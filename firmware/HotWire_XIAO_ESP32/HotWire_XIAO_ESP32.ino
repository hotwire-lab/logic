/*
 * SPDX-License-Identifier: Apache-2.0
 * Copyright (c) 2026 Kari Vierimaa, Kempele
 *
 * HotWire Pocket Lab — 8-Channel Logic Analyzer & Tri-State Force I/O Firmware
 * Supported Target Boards:
 *   - Seeed Studio XIAO ESP32-S3 (Dual-Core Xtensa 240 MHz)
 *   - Seeed Studio XIAO ESP32-C6 (Single-Core RISC-V 160 MHz)
 *
 * Required Arduino IDE Tools Settings:
 *   XIAO ESP32-S3:
 *     - Board: "XIAO_ESP32S3" (Seeed Studio XIAO ESP32S3)
 *     - USB CDC On Boot: "Enabled"
 *     - CPU Frequency: "240MHz (WiFi)"
 *     - USB Mode: "Hardware CDC and JTAG" (or "USB-OTG (TinyUSB)")
 *     Pin Mapping (D0..D7): GPIO { 1, 2, 3, 4, 5, 6, 43, 44 }
 *
 *   XIAO ESP32-C6:
 *     - Board: "XIAO_ESP32C6" (Seeed Studio XIAO ESP32C6)
 *     - USB CDC On Boot: "Enabled"
 *     - CPU Frequency: "160MHz (WiFi)"
 *     Pin Mapping (D0..D7): GPIO { 0, 1, 2, 21, 22, 23, 16, 17 }
 */

#include <Arduino.h>
#include "driver/gpio.h"
#include "driver/dedic_gpio.h"
#include "hal/dedic_gpio_cpu_ll.h"
#include "soc/gpio_struct.h"
#include "soc/soc_caps.h"
#if CONFIG_IDF_TARGET_ESP32C6
  #include "soc/lp_aon_reg.h"
#else
  #include "soc/rtc_cntl_reg.h"
#endif
#include "esp_cpu.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "hotwire_protocol.h"

// -----------------------------------------------------------------------------
// Hardware Constants & Channel Mapping
// -----------------------------------------------------------------------------

#define HOTWIRE_FW_VERSION "1.2.1"

static const uint8_t CHANNEL_COUNT = 8;
#if CONFIG_IDF_TARGET_ESP32C6
  static const char* const BOARD_NAME = "XIAO-ESP32-C6";
  static const uint8_t CHANNEL_PINS[CHANNEL_COUNT] = { 0, 1, 2, 21, 22, 23, 16, 17 };
  static const uint32_t CPU_FREQ_HZ = 160000000UL;
#else
  static const char* const BOARD_NAME = "XIAO-ESP32-S3";
  static const uint8_t CHANNEL_PINS[CHANNEL_COUNT] = { 1, 2, 3, 4, 5, 6, 43, 44 };
  static const uint32_t CPU_FREQ_HZ = 240000000UL;
#endif
static const char* const CHANNEL_LABELS[CHANNEL_COUNT] = { "D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7" };

static const uint32_t MAX_SAMPLES = 32768;
static const uint64_t CONTENTION_CUTOFF_US = 20000ULL;      // 20 ms short-circuit guard
static const uint64_t TELEMETRY_INTERVAL_US = 40000ULL;     // 25 Hz idle telemetry
static const uint64_t CHANGE_THROTTLE_US = 4000ULL;         // Max 250 Hz for physical-only changes
static const uint64_t LOW_SPEED_TRIG_TIMEOUT_US = 5000000ULL; // 5 s timeout

// Sample Rate Presets (RATE_ID 0..10)
static const uint8_t RATE_PRESET_COUNT = 11;
static const uint32_t RATE_PRESETS_HZ[RATE_PRESET_COUNT] = {
  1000UL,      // 0: 1 kHz
  10000UL,     // 1: 10 kHz
  50000UL,     // 2: 50 kHz
  100000UL,    // 3: 100 kHz
  250000UL,    // 4: 250 kHz
  500000UL,    // 5: 500 kHz
  1000000UL,   // 6: 1 MHz
  2000000UL,   // 7: 2 MHz
  5000000UL,   // 8: 5 MHz
  10000000UL,  // 9: 10 MHz
  20000000UL   // 10: 20 MHz
};

// -----------------------------------------------------------------------------
// Binary Multiplexing Protocol Definitions
// -----------------------------------------------------------------------------

static const uint8_t SYNC_BYTE_0 = 0xAA;
static const uint8_t SYNC_BYTE_1 = 0x55;

// Host-to-Device Commands
static const uint8_t CMD_PING_STATUS = 0x01;
static const uint8_t CMD_GET_CAPS    = 0x02;
static const uint8_t CMD_PIN_FORCE   = 0x10;
static const uint8_t CMD_BATCH_FORCE = 0x11;
static const uint8_t CMD_SIG_GEN     = 0x12;
static const uint8_t CMD_LA_CAPTURE  = 0x20;
static const uint8_t CMD_LA_ABORT    = 0x21;
static const uint8_t CMD_BOOTLOADER  = 0xF0;

// Device-to-Host Frame Types
static const uint8_t TYPE_STATUS_TELEMETRY  = 0x81;
static const uint8_t TYPE_LA_CAPTURE_DATA   = 0x82;
static const uint8_t TYPE_BOARD_CAPABILITIES = 0x83;

// LA Capture Flags
static const uint16_t LA_FLAG_TRIGGERED     = 0x0001;
static const uint16_t LA_FLAG_AUTO_TIMEOUT  = 0x0002;
static const uint16_t LA_FLAG_ABORTED_EARLY = 0x0004;

// -----------------------------------------------------------------------------
// Shared Firmware State & Buffers
// -----------------------------------------------------------------------------

// Force & Contention State (protected by stateMutex)
static SemaphoreHandle_t stateMutex = nullptr;
static SemaphoreHandle_t txMutex = nullptr;

static volatile uint8_t chMode[CHANNEL_COUNT] = { 0 };     // 0=Z, 1=Force 0, 2=Force 1
static volatile uint8_t chPull[CHANNEL_COUNT] = { 0 };     // 0=None, 1=Pull-Up, 2=Pull-Down
static volatile uint8_t forceEnableMask = 0x00;
static volatile uint8_t forcedLevelMask = 0x00;
static volatile uint8_t protectMask = 0xFF;                // 20 ms contention guard enabled by default
static volatile uint8_t contentionMask = 0x00;
static volatile bool immediateTelemetryPending = false;

static bool mismatchActive[CHANNEL_COUNT] = { false };
static uint64_t mismatchStartUs[CHANNEL_COUNT] = { 0 };

// Logic Analyzer Buffers (Internal SRAM)
static uint8_t ringBuf[MAX_SAMPLES];
static uint8_t captureBuffer[MAX_SAMPLES];

struct CaptureRequest {
  uint8_t rateId;
  uint8_t trigCh;
  uint8_t trigCfg;
  uint8_t blocksKb;
};

static CaptureRequest pendingCaptureReq = { 6, 0xFF, 0, 16 };
static volatile bool laCaptureActive = false;
static volatile bool laAbortRequested = false;

static TaskHandle_t core0TaskHandle = nullptr;
static TaskHandle_t core1TaskHandle = nullptr;
static TaskHandle_t sigGenTaskHandle = nullptr;
static portMUX_TYPE laSpinlock = portMUX_INITIALIZER_UNLOCKED;
static portMUX_TYPE sigSpinlock = portMUX_INITIALIZER_UNLOCKED;
static volatile uint8_t sigGenMode = 0;
static volatile uint8_t sigGenPinMask = 0x00;
static bool dedicGpioReady = false;
static uint32_t dedicInOffset = 0;

// -----------------------------------------------------------------------------
// Fast Single-Cycle Register Acquisition (IRAM)
// -----------------------------------------------------------------------------

static inline uint8_t IRAM_ATTR readAllChannelsFast() {
#if CONFIG_IDF_TARGET_ESP32C6
  // XIAO ESP32-C6 D0..D7 -> GPIO {0, 1, 2, 21, 22, 23, 16, 17}
  const uint32_t inVal = GPIO.in.val;
  return (uint8_t)(
    (inVal & 0x07U) |
    ((inVal >> 18) & 0x38U) |
    ((inVal >> 10) & 0xC0U)
  );
#else
  // XIAO ESP32-S3 D0..D7 -> GPIO {1, 2, 3, 4, 5, 6, 43, 44}
  uint32_t low = (GPIO.in >> 1) & 0x3FU;
  uint32_t high = ((GPIO.in1.val >> 11) & 0x03U) << 6;
  return (uint8_t)(low | high);
#endif
}

static void initCore1DedicGpio() {
  int gpioArray[CHANNEL_COUNT];
  for (uint8_t i = 0; i < CHANNEL_COUNT; i++) {
    gpioArray[i] = CHANNEL_PINS[i];
  }
  dedic_gpio_bundle_config_t bundleCfg = {
    .gpio_array = gpioArray,
    .array_size = CHANNEL_COUNT,
    .flags = {
      .in_en = 1,
      .in_invert = 0,
      .out_en = 0,
      .out_invert = 0
    }
  };
  dedic_gpio_bundle_handle_t handle = nullptr;
  if (dedic_gpio_new_bundle(&bundleCfg, &handle) == ESP_OK && handle != nullptr) {
    uint32_t offset = 0;
    if (dedic_gpio_get_in_offset(handle, &offset) == ESP_OK) {
      dedicInOffset = offset;
      dedicGpioReady = true;
    }
  }
}

static inline void IRAM_ATTR preloadOutputLatch(uint8_t pin, uint8_t level) {
#if CONFIG_IDF_TARGET_ESP32C6
  const uint32_t bit = (1UL << pin);
  if (level) {
    GPIO.out_w1ts.val = bit;
  } else {
    GPIO.out_w1tc.val = bit;
  }
#else
  if (pin < 32) {
    if (level) {
      GPIO.out_w1ts = (1UL << pin);
    } else {
      GPIO.out_w1tc = (1UL << pin);
    }
  } else {
    uint32_t bit = (1UL << (pin - 32));
    if (level) {
      GPIO.out1_w1ts.val = bit;
    } else {
      GPIO.out1_w1tc.val = bit;
    }
  }
#endif
}

static void applyChannelHardware(uint8_t ch, uint8_t mode, uint8_t pull) {
  if (ch >= CHANNEL_COUNT) {
    return;
  }
  const uint8_t pin = CHANNEL_PINS[ch];

  if (mode == 1 || mode == 2) {
    const uint8_t level = (mode == 2) ? 1 : 0;
    // Glitch-free requirement: preload output latch BEFORE enabling output driver
    preloadOutputLatch(pin, level);
    gpio_set_level((gpio_num_t)pin, level);
    pinMode(pin, OUTPUT); // ESP32 Arduino OUTPUT == 0x03 (INPUT_OUTPUT)
    gpio_set_level((gpio_num_t)pin, level);
  } else {
    uint8_t inputMode = INPUT;
    if (pull == 1) {
      inputMode = INPUT_PULLUP;
    } else if (pull == 2) {
      inputMode = INPUT_PULLDOWN;
    }
    pinMode(pin, inputMode);
  }
}

static void releaseAllChannels() {
  if (stateMutex) {
    xSemaphoreTake(stateMutex, portMAX_DELAY);
  }
  sigGenMode = 0;
  sigGenPinMask = 0x00;
  forceEnableMask = 0x00;
  forcedLevelMask = 0x00;
  contentionMask = 0x00;
  for (uint8_t ch = 0; ch < CHANNEL_COUNT; ch++) {
    chMode[ch] = 0;
    chPull[ch] = 0;
    mismatchActive[ch] = false;
    mismatchStartUs[ch] = 0;
    applyChannelHardware(ch, 0, 0);
  }
  immediateTelemetryPending = true;
  if (stateMutex) {
    xSemaphoreGive(stateMutex);
  }
}

// -----------------------------------------------------------------------------
// Non-Blocking Chunked Binary Frame Transmitter
// -----------------------------------------------------------------------------

static void writeChunkedLocked(const uint8_t* data, size_t len) {
  static const size_t CHUNK_SIZE = 512;
  size_t offset = 0;
  uint32_t stallCount = 0;

  while (offset < len) {
    size_t remaining = len - offset;
    size_t toSend = (remaining > CHUNK_SIZE) ? CHUNK_SIZE : remaining;

    int avail = Serial.availableForWrite();
    if (avail > 0 && (size_t)avail < toSend) {
      toSend = (size_t)avail;
    }

    if (avail <= 0) {
      stallCount++;
      if (stallCount > 250) {
        // Avoid permanent hang if host stops reading
        break;
      }
      vTaskDelay(1);
      continue;
    }

    size_t written = Serial.write(data + offset, toSend);
    if (written == 0) {
      stallCount++;
      if (stallCount > 250) {
        break;
      }
      vTaskDelay(1);
      continue;
    }

    stallCount = 0;
    offset += written;

    if (offset < len && (offset % 1024U) == 0) {
      vTaskDelay(1);
    }
  }
}

static void sendBinaryFrame(uint8_t typeId, const uint8_t* payload, uint16_t payloadLen) {
  uint8_t header[5] = {
    SYNC_BYTE_0,
    SYNC_BYTE_1,
    typeId,
    (uint8_t)(payloadLen & 0xFFU),
    (uint8_t)((payloadLen >> 8) & 0xFFU)
  };

  uint8_t xorSum = 0;
  for (size_t i = 0; i < sizeof(header); i++) {
    xorSum ^= header[i];
  }
  for (uint16_t i = 0; i < payloadLen; i++) {
    xorSum ^= payload[i];
  }

  if (txMutex) {
    xSemaphoreTake(txMutex, portMAX_DELAY);
  }

  if (payloadLen <= 64) {
    uint8_t smallFrame[70];
    memcpy(smallFrame, header, sizeof(header));
    if (payloadLen > 0 && payload != nullptr) {
      memcpy(smallFrame + sizeof(header), payload, payloadLen);
    }
    smallFrame[sizeof(header) + payloadLen] = xorSum;
    writeChunkedLocked(smallFrame, sizeof(header) + payloadLen + 1);
  } else {
    writeChunkedLocked(header, sizeof(header));
    if (payloadLen > 0 && payload != nullptr) {
      writeChunkedLocked(payload, payloadLen);
    }
    writeChunkedLocked(&xorSum, 1);
  }

  if (txMutex) {
    xSemaphoreGive(txMutex);
  }
}

static void sendTelemetryFrame() {
  uint8_t payload[4];
  if (stateMutex) {
    xSemaphoreTake(stateMutex, portMAX_DELAY);
  }
  payload[0] = readAllChannelsFast();
  payload[1] = forceEnableMask;
  payload[2] = forcedLevelMask;
  payload[3] = contentionMask;
  if (stateMutex) {
    xSemaphoreGive(stateMutex);
  }
  sendBinaryFrame(TYPE_STATUS_TELEMETRY, payload, sizeof(payload));
}

static void sendCapabilitiesFrame() {
#if CONFIG_IDF_TARGET_ESP32C6
  static const char CAPS_JSON[] =
    "{\"board\":\"XIAO-ESP32-C6\",\"firmware\":\"" HOTWIRE_FW_VERSION "\",\"schema\":2,\"tool\":\"logic\",\"channels\":8,"
    "\"maxRateHz\":20000000,\"maxDepth\":32768,\"max_rate_hz\":20000000,\"max_depth\":32768,"
    "\"pins\":["
    "{\"ch\":0,\"label\":\"D0\",\"gpio\":0},"
    "{\"ch\":1,\"label\":\"D1\",\"gpio\":1},"
    "{\"ch\":2,\"label\":\"D2\",\"gpio\":2},"
    "{\"ch\":3,\"label\":\"D3\",\"gpio\":21},"
    "{\"ch\":4,\"label\":\"D4\",\"gpio\":22},"
    "{\"ch\":5,\"label\":\"D5\",\"gpio\":23},"
    "{\"ch\":6,\"label\":\"D6\",\"gpio\":16},"
    "{\"ch\":7,\"label\":\"D7\",\"gpio\":17}"
    "]}";
#else
  static const char CAPS_JSON[] =
    "{\"board\":\"XIAO-ESP32-S3\",\"firmware\":\"" HOTWIRE_FW_VERSION "\",\"schema\":2,\"tool\":\"logic\",\"channels\":8,"
    "\"maxRateHz\":20000000,\"maxDepth\":32768,\"max_rate_hz\":20000000,\"max_depth\":32768,"
    "\"pins\":["
    "{\"ch\":0,\"label\":\"D0\",\"gpio\":1},"
    "{\"ch\":1,\"label\":\"D1\",\"gpio\":2},"
    "{\"ch\":2,\"label\":\"D2\",\"gpio\":3},"
    "{\"ch\":3,\"label\":\"D3\",\"gpio\":4},"
    "{\"ch\":4,\"label\":\"D4\",\"gpio\":5},"
    "{\"ch\":5,\"label\":\"D5\",\"gpio\":6},"
    "{\"ch\":6,\"label\":\"D6\",\"gpio\":43},"
    "{\"ch\":7,\"label\":\"D7\",\"gpio\":44}"
    "]}";
#endif
  sendBinaryFrame(TYPE_BOARD_CAPABILITIES, (const uint8_t*)CAPS_JSON, (uint16_t)(sizeof(CAPS_JSON) - 1));
}

static void sendTextLocked(const char* text) {
  if (txMutex) {
    xSemaphoreTake(txMutex, portMAX_DELAY);
  }
  Serial.print(text);
  if (txMutex) {
    xSemaphoreGive(txMutex);
  }
}

// -----------------------------------------------------------------------------
// Core 1 Logic Analyzer Capture Engine (High-Speed & Low-Speed Dual Paths)
// -----------------------------------------------------------------------------

static inline bool IRAM_ATTR matchesTriggerEdge(uint8_t prevSample, uint8_t curSample, uint8_t trigMask, uint8_t edgeType) {
  const uint8_t prevBit = prevSample & trigMask;
  const uint8_t curBit = curSample & trigMask;
  if (edgeType == 0) {
    return (prevBit != 0) && (curBit == 0); // Falling
  }
  if (edgeType == 1) {
    return (prevBit == 0) && (curBit != 0); // Rising
  }
  return prevBit != curBit; // Any edge
}

static void IRAM_ATTR linearizeRingBuffer(
  uint32_t trigRingPos,
  uint32_t preCount,
  uint32_t postCountIncludingTrig
) {
  uint32_t startPos = (trigRingPos + MAX_SAMPLES - preCount) & (MAX_SAMPLES - 1U);
  uint32_t total = preCount + postCountIncludingTrig;
  if (total > MAX_SAMPLES) {
    total = MAX_SAMPLES;
  }

  for (uint32_t i = 0; i < total; i++) {
    captureBuffer[i] = ringBuf[(startPos + i) & (MAX_SAMPLES - 1U)];
  }
}

#if SOC_CPU_CORES_NUM == 1
static volatile bool inlineCaptureBusy = false;
static uint8_t inlineCounterLut[64];
static uint8_t inlineUartLut[128];
static uint8_t inlineSpiLut[128];
static uint8_t inlineI2cLut[256];

static void initInlineSigGenTables() {
  // Mode 1: 4-bit counter (D0..D3) + 25%/75% PWM (D4/D5) at 200 kHz steps
  for (uint8_t step = 0; step < 64; step++) {
    uint8_t val = (uint8_t)(step & 0x0FU);
    if ((step & 3U) == 0U) val |= 0x10U;
    if ((step & 3U) != 3U) val |= 0x20U;
    inlineCounterLut[step] = val;
  }

  // Mode 2: UART 115200 8N1 "HotWire!\r\n" on D6 (0x40), idle HIGH
  static const char msg[] = "HotWire!\r\n";
  for (uint8_t i = 0; i < 128; i++) {
    inlineUartLut[i] = 0x40U;
  }
  for (uint8_t c = 0; c < 10; c++) {
    const uint8_t b = (uint8_t)msg[c];
    const uint8_t base = (uint8_t)(16U + c * 10U);
    inlineUartLut[base] = 0x00U; // Start bit
    for (uint8_t bit = 0; bit < 8; bit++) {
      inlineUartLut[base + 1U + bit] = ((b >> bit) & 1U) ? 0x40U : 0x00U;
    }
    inlineUartLut[base + 9U] = 0x40U; // Stop bit
  }

  // Mode 3: SPI burst {0xA5, 0x5A, 0x48, 0x57}/{0x11, 0x22, 0x33, 0x44}
  // D0=SCK(0x01), D1=MOSI(0x02), D2=MISO(0x04), D3=CS#(0x08) at 500 kHz half-clock
  static const uint8_t mosi[4] = { 0xA5, 0x5A, 0x48, 0x57 };
  static const uint8_t miso[4] = { 0x11, 0x22, 0x33, 0x44 };
  for (uint8_t i = 0; i < 128; i++) {
    inlineSpiLut[i] = 0x08U; // CS# idle high, SCK low
  }
  inlineSpiLut[16] = 0x00U; // CS# active low
  inlineSpiLut[17] = 0x00U;
  for (uint8_t idx = 0; idx < 4; idx++) {
    for (uint8_t bit = 0; bit < 8; bit++) {
      const uint8_t shift = (uint8_t)(7U - bit);
      const uint8_t slot = (uint8_t)(18U + (idx * 8U + bit) * 2U);
      const uint8_t dataBits = (uint8_t)(
        (((mosi[idx] >> shift) & 1U) ? 0x02U : 0x00U) |
        (((miso[idx] >> shift) & 1U) ? 0x04U : 0x00U)
      );
      inlineSpiLut[slot] = dataBits;            // SCK low
      inlineSpiLut[slot + 1U] = dataBits | 0x01U; // SCK high
    }
  }
  inlineSpiLut[82] = 0x00U;
  inlineSpiLut[83] = 0x00U;

  // Mode 4: I2C burst Write 0x3C -> 0x00, 0xAE, 0xAF
  // D0=SCL(0x01), D1=SDA(0x02) at 400 kHz quarter-bit (~100 kHz SCL)
  static const uint8_t i2cBytes[4] = { (uint8_t)(0x3C << 1), 0x00, 0xAE, 0xAF };
  for (uint16_t i = 0; i < 256; i++) {
    inlineI2cLut[i] = 0x03U; // SCL=1, SDA=1 idle
  }
  inlineI2cLut[24] = 0x01U; // START: SDA=0 while SCL=1
  inlineI2cLut[25] = 0x01U;
  inlineI2cLut[26] = 0x00U;
  uint16_t s = 27;
  for (uint8_t idx = 0; idx < 4; idx++) {
    for (uint8_t bit = 0; bit < 9; bit++) {
      const uint8_t sdaVal = (bit < 8)
        ? (((i2cBytes[idx] >> (7U - bit)) & 1U) ? 0x02U : 0x00U)
        : 0x00U; // ACK = 0
      inlineI2cLut[s++] = sdaVal;
      inlineI2cLut[s++] = (uint8_t)(sdaVal | 0x01U);
      inlineI2cLut[s++] = (uint8_t)(sdaVal | 0x01U);
      inlineI2cLut[s++] = sdaVal;
    }
  }
  inlineI2cLut[s++] = 0x00U; // STOP: SCL=0, SDA=0
  inlineI2cLut[s++] = 0x01U; // SCL=1, SDA=0
  inlineI2cLut[s++] = 0x01U; // SCL=1, SDA=0
  inlineI2cLut[s++] = 0x03U; // SCL=1, SDA=1
}

static inline uint32_t IRAM_ATTR chMaskToGpioMask(uint8_t chBits) {
#if CONFIG_IDF_TARGET_ESP32C6
  return (uint32_t)(chBits & 0x07U)
       | ((uint32_t)(chBits & 0x38U) << 18)
       | ((uint32_t)(chBits & 0xC0U) << 10);
#else
  return ((uint32_t)(chBits & 0x3FU) << 1);
#endif
}

struct InlineSigGenCtx {
  const uint8_t* lut;
  uint32_t lutMask;
  uint32_t phase;
  uint32_t phaseInc;
  uint32_t lastIdx;
  uint8_t chMask;
  uint32_t gpioMask;
};

static InlineSigGenCtx IRAM_ATTR prepareInlineSigGen(uint8_t mode, uint8_t pinMask, uint32_t rateHz) {
  InlineSigGenCtx ctx = { nullptr, 0, 0, 0, 0xFFFFFFFFU, pinMask, chMaskToGpioMask(pinMask) };
  if (pinMask == 0) {
    return ctx;
  }
  if (mode == 1) {
    ctx.lut = inlineCounterLut;
    ctx.lutMask = 63U;
    ctx.phaseInc = (uint32_t)((200000ULL << 16) / rateHz);
  } else if (mode == 2) {
    ctx.lut = inlineUartLut;
    ctx.lutMask = 127U;
    ctx.phaseInc = (uint32_t)((115200ULL << 16) / rateHz);
  } else if (mode == 3) {
    ctx.lut = inlineSpiLut;
    ctx.lutMask = 127U;
    ctx.phaseInc = (uint32_t)((500000ULL << 16) / rateHz);
  } else if (mode == 4) {
    ctx.lut = inlineI2cLut;
    ctx.lutMask = 255U;
    ctx.phaseInc = (uint32_t)((400000ULL << 16) / rateHz);
  }
  return ctx;
}

static inline void IRAM_ATTR stepInlineSigGen(InlineSigGenCtx& ctx) {
  const uint32_t idx = (ctx.phase >> 16) & ctx.lutMask;
  ctx.phase += ctx.phaseInc;
  if (idx != ctx.lastIdx) {
    ctx.lastIdx = idx;
    const uint8_t chVal = ctx.lut[idx] & ctx.chMask;
    const uint32_t highGpio = chMaskToGpioMask(chVal);
#if CONFIG_IDF_TARGET_ESP32C6
    GPIO.out_w1ts.val = highGpio;
    GPIO.out_w1tc.val = ctx.gpioMask & (~highGpio);
#else
    GPIO.out_w1ts = highGpio;
    GPIO.out_w1tc = ctx.gpioMask & (~highGpio);
#endif
  }
}
#endif

static void IRAM_ATTR executeHighSpeedCapture(
  uint32_t rateHz,
  uint8_t trigCh,
  uint8_t edgeType,
  uint32_t totalSamples,
  uint32_t preTrigSamples,
  uint32_t* outSamples,
  uint16_t* outTrigIndex,
  uint16_t* outFlags,
  uint32_t* outActualRateHz
) {
  const uint32_t cyclesPerSample = CPU_FREQ_HZ / rateHz;
  const uint32_t timeoutCycles = CPU_FREQ_HZ; // 1 second timeout
  uint16_t flags = 0;
  uint16_t trigIndex = 0;

#if SOC_CPU_CORES_NUM == 1
  InlineSigGenCtx sigCtx = prepareInlineSigGen(sigGenMode, sigGenPinMask, rateHz);
  if (sigCtx.lut != nullptr) {
    inlineCaptureBusy = true;
    stepInlineSigGen(sigCtx);
  }
#endif

  portENTER_CRITICAL(&laSpinlock);

  const bool useDedic = dedicGpioReady && (dedicInOffset == 0);

  if (trigCh >= CHANNEL_COUNT) {
    // Free-Run / Immediate capture
    uint32_t startCycle = esp_cpu_get_cycle_count();
    uint32_t nextCycle = startCycle;
#if SOC_CPU_CORES_NUM == 1
    if (sigCtx.lut != nullptr) {
      nextCycle += (cyclesPerSample > 16U ? cyclesPerSample : 16U);
      startCycle = nextCycle;
      for (uint32_t i = 0; i < totalSamples; i++) {
        while ((int32_t)(esp_cpu_get_cycle_count() - nextCycle) < 0) {
        }
        captureBuffer[i] = useDedic ? (uint8_t)dedic_gpio_cpu_ll_read_in() : readAllChannelsFast();
        stepInlineSigGen(sigCtx);
        nextCycle += cyclesPerSample;
      }
    } else
#endif
    if (useDedic) {
      for (uint32_t i = 0; i < totalSamples; i++) {
        while ((int32_t)(esp_cpu_get_cycle_count() - nextCycle) < 0) {
        }
        captureBuffer[i] = (uint8_t)dedic_gpio_cpu_ll_read_in();
        nextCycle += cyclesPerSample;
      }
    } else {
      for (uint32_t i = 0; i < totalSamples; i++) {
        while ((int32_t)(esp_cpu_get_cycle_count() - nextCycle) < 0) {
        }
        captureBuffer[i] = readAllChannelsFast();
        nextCycle += cyclesPerSample;
      }
    }
    uint32_t elapsedCycles = esp_cpu_get_cycle_count() - startCycle;
    portEXIT_CRITICAL(&laSpinlock);
#if SOC_CPU_CORES_NUM == 1
    inlineCaptureBusy = false;
    vTaskDelay(2);
#endif

    *outSamples = totalSamples;
    *outTrigIndex = 0;
    *outFlags = 0;
    if (elapsedCycles > 0 && totalSamples > 1) {
      uint64_t measured = ((uint64_t)totalSamples * (uint64_t)CPU_FREQ_HZ) / (uint64_t)elapsedCycles;
      // Report nominal if within 8% (loop startup overhead), else actual achieved
      if (measured >= (rateHz * 92ULL) / 100ULL && measured <= (rateHz * 108ULL) / 100ULL) {
        *outActualRateHz = rateHz;
      } else {
        *outActualRateHz = (uint32_t)measured;
      }
    } else {
      *outActualRateHz = rateHz;
    }
    return;
  }

  // Triggered high-speed capture using circular buffer
  const uint8_t trigMask = (uint8_t)(1U << trigCh);
  uint32_t writeIdx = 0;
  uint32_t nextCycle = esp_cpu_get_cycle_count();
#if SOC_CPU_CORES_NUM == 1
  if (sigCtx.lut != nullptr) {
    nextCycle += (cyclesPerSample > 16U ? cyclesPerSample : 16U);
  }
#endif

  // Phase 1: Collect mandatory pre-trigger samples before arming edge detector
  for (uint32_t i = 0; i < preTrigSamples; i++) {
    while ((int32_t)(esp_cpu_get_cycle_count() - nextCycle) < 0) {
    }
    ringBuf[writeIdx] = useDedic ? (uint8_t)dedic_gpio_cpu_ll_read_in() : readAllChannelsFast();
#if SOC_CPU_CORES_NUM == 1
    if (sigCtx.lut != nullptr) {
      stepInlineSigGen(sigCtx);
    }
#endif
    writeIdx = (writeIdx + 1U) & (MAX_SAMPLES - 1U);
    nextCycle += cyclesPerSample;
  }

  uint8_t prevSample = (preTrigSamples > 0)
    ? ringBuf[(writeIdx + MAX_SAMPLES - 1U) & (MAX_SAMPLES - 1U)]
    : (useDedic ? (uint8_t)dedic_gpio_cpu_ll_read_in() : readAllChannelsFast());

  // Phase 2: Wait for trigger edge (with 1-second hardware cycle timeout)
  const uint32_t trigWaitStart = esp_cpu_get_cycle_count();
  bool triggered = false;
  uint32_t trigRingPos = 0;

  while (true) {
    while ((int32_t)(esp_cpu_get_cycle_count() - nextCycle) < 0) {
    }
    uint8_t curSample = useDedic ? (uint8_t)dedic_gpio_cpu_ll_read_in() : readAllChannelsFast();
#if SOC_CPU_CORES_NUM == 1
    if (sigCtx.lut != nullptr) {
      stepInlineSigGen(sigCtx);
    }
#endif
    ringBuf[writeIdx] = curSample;
    trigRingPos = writeIdx;
    writeIdx = (writeIdx + 1U) & (MAX_SAMPLES - 1U);
    nextCycle += cyclesPerSample;

    if (matchesTriggerEdge(prevSample, curSample, trigMask, edgeType)) {
      triggered = true;
      flags |= LA_FLAG_TRIGGERED;
      break;
    }
    prevSample = curSample;

    if ((uint32_t)(esp_cpu_get_cycle_count() - trigWaitStart) >= timeoutCycles) {
      flags |= LA_FLAG_AUTO_TIMEOUT;
      break;
    }
  }

  // Phase 3: Collect remaining post-trigger samples (trigger sample is index 0 of post)
  const uint32_t postRemaining = (totalSamples > preTrigSamples + 1U)
    ? (totalSamples - preTrigSamples - 1U)
    : 0U;
  uint32_t postStartCycle = esp_cpu_get_cycle_count();
#if SOC_CPU_CORES_NUM == 1
  if (sigCtx.lut != nullptr) {
    for (uint32_t i = 0; i < postRemaining; i++) {
      while ((int32_t)(esp_cpu_get_cycle_count() - nextCycle) < 0) {
      }
      ringBuf[writeIdx] = useDedic ? (uint8_t)dedic_gpio_cpu_ll_read_in() : readAllChannelsFast();
      stepInlineSigGen(sigCtx);
      writeIdx = (writeIdx + 1U) & (MAX_SAMPLES - 1U);
      nextCycle += cyclesPerSample;
    }
  } else
#endif
  if (useDedic) {
    for (uint32_t i = 0; i < postRemaining; i++) {
      while ((int32_t)(esp_cpu_get_cycle_count() - nextCycle) < 0) {
      }
      ringBuf[writeIdx] = (uint8_t)dedic_gpio_cpu_ll_read_in();
      writeIdx = (writeIdx + 1U) & (MAX_SAMPLES - 1U);
      nextCycle += cyclesPerSample;
    }
  } else {
    for (uint32_t i = 0; i < postRemaining; i++) {
      while ((int32_t)(esp_cpu_get_cycle_count() - nextCycle) < 0) {
      }
      ringBuf[writeIdx] = readAllChannelsFast();
      writeIdx = (writeIdx + 1U) & (MAX_SAMPLES - 1U);
      nextCycle += cyclesPerSample;
    }
  }
  uint32_t postElapsedCycles = esp_cpu_get_cycle_count() - postStartCycle;

  linearizeRingBuffer(trigRingPos, preTrigSamples, postRemaining + 1U);
  trigIndex = (uint16_t)preTrigSamples;
  (void)triggered;

  portEXIT_CRITICAL(&laSpinlock);
#if SOC_CPU_CORES_NUM == 1
  inlineCaptureBusy = false;
  vTaskDelay(2);
#endif

  *outSamples = totalSamples;
  *outTrigIndex = trigIndex;
  *outFlags = flags;
  if (postRemaining > 32 && postElapsedCycles > 0) {
    uint64_t measured = ((uint64_t)postRemaining * (uint64_t)CPU_FREQ_HZ) / (uint64_t)postElapsedCycles;
    if (measured >= (rateHz * 92ULL) / 100ULL && measured <= (rateHz * 108ULL) / 100ULL) {
      *outActualRateHz = rateHz;
    } else {
      *outActualRateHz = (uint32_t)measured;
    }
  } else {
    *outActualRateHz = rateHz;
  }
}

static bool lowSpeedWaitSample(uint64_t nextSampleUs, uint64_t intervalUs, uint64_t* lastYieldUs) {
  uint64_t nowUs = (uint64_t)esp_timer_get_time();
  if (nextSampleUs > nowUs) {
    uint64_t rem = nextSampleUs - nowUs;
    if (rem >= 2000ULL || (intervalUs >= 1000ULL && rem >= 900ULL)) {
      vTaskDelay(1);
      *lastYieldUs = (uint64_t)esp_timer_get_time();
    } else if ((nowUs - *lastYieldUs) >= 1500000ULL) {
      vTaskDelay(1);
      *lastYieldUs = (uint64_t)esp_timer_get_time();
    }
    while ((uint64_t)esp_timer_get_time() < nextSampleUs) {
      if (laAbortRequested) {
        return false;
      }
    }
  } else if ((nowUs - *lastYieldUs) >= 1500000ULL) {
    vTaskDelay(1);
    *lastYieldUs = (uint64_t)esp_timer_get_time();
  }
  return !laAbortRequested;
}

static void executeLowSpeedCapture(
  uint32_t rateHz,
  uint8_t trigCh,
  uint8_t edgeType,
  uint32_t totalSamples,
  uint32_t preTrigSamples,
  uint32_t* outSamples,
  uint16_t* outTrigIndex,
  uint16_t* outFlags,
  uint32_t* outActualRateHz
) {
  const uint64_t intervalUs = 1000000ULL / rateHz;
  uint16_t flags = 0;
  uint16_t trigIndex = 0;
  uint64_t nextSampleUs = (uint64_t)esp_timer_get_time();
  uint64_t lastYieldUs = nextSampleUs;

#if SOC_CPU_CORES_NUM == 1
  InlineSigGenCtx sigCtx = prepareInlineSigGen(sigGenMode, sigGenPinMask, rateHz);
  if (sigCtx.lut != nullptr) {
    inlineCaptureBusy = true;
    stepInlineSigGen(sigCtx);
  }
#endif

  if (trigCh >= CHANNEL_COUNT) {
    // Free-Run low-speed capture (interrupts enabled, abortable)
    uint32_t collected = 0;
    for (uint32_t i = 0; i < totalSamples; i++) {
      if (!lowSpeedWaitSample(nextSampleUs, intervalUs, &lastYieldUs)) {
        flags |= LA_FLAG_ABORTED_EARLY;
        break;
      }
      captureBuffer[collected++] = readAllChannelsFast();
#if SOC_CPU_CORES_NUM == 1
      if (sigCtx.lut != nullptr) {
        stepInlineSigGen(sigCtx);
      }
#endif
      nextSampleUs += intervalUs;
    }

#if SOC_CPU_CORES_NUM == 1
    inlineCaptureBusy = false;
#endif
    *outSamples = collected;
    *outTrigIndex = 0;
    *outFlags = flags;
    *outActualRateHz = rateHz;
    return;
  }

  // Triggered low-speed capture
  const uint8_t trigMask = (uint8_t)(1U << trigCh);
  uint32_t writeIdx = 0;
  uint32_t collectedRing = 0;

  // Phase 1: Fill pre-trigger ring buffer
  for (uint32_t i = 0; i < preTrigSamples; i++) {
    if (!lowSpeedWaitSample(nextSampleUs, intervalUs, &lastYieldUs)) {
      flags |= LA_FLAG_ABORTED_EARLY;
      for (uint32_t k = 0; k < collectedRing; k++) {
        captureBuffer[k] = ringBuf[k];
      }
#if SOC_CPU_CORES_NUM == 1
      inlineCaptureBusy = false;
#endif
      *outSamples = collectedRing;
      *outTrigIndex = 0;
      *outFlags = flags;
      *outActualRateHz = rateHz;
      return;
    }
    ringBuf[writeIdx] = readAllChannelsFast();
#if SOC_CPU_CORES_NUM == 1
    if (sigCtx.lut != nullptr) {
      stepInlineSigGen(sigCtx);
    }
#endif
    writeIdx = (writeIdx + 1U) & (MAX_SAMPLES - 1U);
    collectedRing++;
    nextSampleUs += intervalUs;
  }

  uint8_t prevSample = (preTrigSamples > 0)
    ? ringBuf[(writeIdx + MAX_SAMPLES - 1U) & (MAX_SAMPLES - 1U)]
    : readAllChannelsFast();

  // Phase 2: Wait for trigger edge (5-second timeout or abort)
  const uint64_t trigWaitStartUs = (uint64_t)esp_timer_get_time();
  uint32_t trigRingPos = 0;
  bool abortedInWait = false;

  while (true) {
    if (!lowSpeedWaitSample(nextSampleUs, intervalUs, &lastYieldUs)) {
      flags |= LA_FLAG_ABORTED_EARLY;
      abortedInWait = true;
      break;
    }

    uint8_t curSample = readAllChannelsFast();
#if SOC_CPU_CORES_NUM == 1
    if (sigCtx.lut != nullptr) {
      stepInlineSigGen(sigCtx);
    }
#endif
    ringBuf[writeIdx] = curSample;
    trigRingPos = writeIdx;
    writeIdx = (writeIdx + 1U) & (MAX_SAMPLES - 1U);
    if (collectedRing < MAX_SAMPLES) {
      collectedRing++;
    }
    nextSampleUs += intervalUs;

    if (matchesTriggerEdge(prevSample, curSample, trigMask, edgeType)) {
      flags |= LA_FLAG_TRIGGERED;
      break;
    }
    prevSample = curSample;

    if (((uint64_t)esp_timer_get_time() - trigWaitStartUs) >= LOW_SPEED_TRIG_TIMEOUT_US) {
      flags |= LA_FLAG_AUTO_TIMEOUT;
      break;
    }
  }

  if (abortedInWait) {
    uint32_t count = (collectedRing > totalSamples) ? totalSamples : collectedRing;
    uint32_t startPos = (writeIdx + MAX_SAMPLES - count) & (MAX_SAMPLES - 1U);
    for (uint32_t i = 0; i < count; i++) {
      captureBuffer[i] = ringBuf[(startPos + i) & (MAX_SAMPLES - 1U)];
    }
#if SOC_CPU_CORES_NUM == 1
    inlineCaptureBusy = false;
#endif
    *outSamples = count;
    *outTrigIndex = 0;
    *outFlags = flags;
    *outActualRateHz = rateHz;
    return;
  }

  // Phase 3: Collect post-trigger samples
  const uint32_t postTarget = (totalSamples > preTrigSamples + 1U)
    ? (totalSamples - preTrigSamples - 1U)
    : 0U;
  uint32_t postCollected = 0;
  for (uint32_t i = 0; i < postTarget; i++) {
    if (!lowSpeedWaitSample(nextSampleUs, intervalUs, &lastYieldUs)) {
      flags |= LA_FLAG_ABORTED_EARLY;
      break;
    }
    ringBuf[writeIdx] = readAllChannelsFast();
#if SOC_CPU_CORES_NUM == 1
    if (sigCtx.lut != nullptr) {
      stepInlineSigGen(sigCtx);
    }
#endif
    writeIdx = (writeIdx + 1U) & (MAX_SAMPLES - 1U);
    postCollected++;
    nextSampleUs += intervalUs;
  }

#if SOC_CPU_CORES_NUM == 1
  inlineCaptureBusy = false;
#endif

  linearizeRingBuffer(trigRingPos, preTrigSamples, postCollected + 1U);
  trigIndex = (uint16_t)preTrigSamples;

  *outSamples = preTrigSamples + 1U + postCollected;
  *outTrigIndex = trigIndex;
  *outFlags = flags;
  *outActualRateHz = rateHz;
}

static void transmitCaptureFrame(
  uint32_t sampleRateHz,
  uint16_t trigIndex,
  uint16_t flags,
  uint32_t sampleCount
) {
  const uint16_t payloadLen = (uint16_t)(8U + sampleCount);
  uint8_t frameHeader[13];
  frameHeader[0] = SYNC_BYTE_0;
  frameHeader[1] = SYNC_BYTE_1;
  frameHeader[2] = TYPE_LA_CAPTURE_DATA;
  frameHeader[3] = (uint8_t)(payloadLen & 0xFFU);
  frameHeader[4] = (uint8_t)((payloadLen >> 8) & 0xFFU);
  // 8-byte capture metadata
  frameHeader[5] = (uint8_t)(sampleRateHz & 0xFFU);
  frameHeader[6] = (uint8_t)((sampleRateHz >> 8) & 0xFFU);
  frameHeader[7] = (uint8_t)((sampleRateHz >> 16) & 0xFFU);
  frameHeader[8] = (uint8_t)((sampleRateHz >> 24) & 0xFFU);
  frameHeader[9] = (uint8_t)(trigIndex & 0xFFU);
  frameHeader[10] = (uint8_t)((trigIndex >> 8) & 0xFFU);
  frameHeader[11] = (uint8_t)(flags & 0xFFU);
  frameHeader[12] = (uint8_t)((flags >> 8) & 0xFFU);

  uint8_t xorSum = 0;
  for (size_t i = 0; i < sizeof(frameHeader); i++) {
    xorSum ^= frameHeader[i];
  }
  for (uint32_t i = 0; i < sampleCount; i++) {
    xorSum ^= captureBuffer[i];
  }

  if (txMutex) {
    xSemaphoreTake(txMutex, portMAX_DELAY);
  }
  writeChunkedLocked(frameHeader, sizeof(frameHeader));
  if (sampleCount > 0) {
    writeChunkedLocked(captureBuffer, sampleCount);
  }
  writeChunkedLocked(&xorSum, 1);
  if (txMutex) {
    xSemaphoreGive(txMutex);
  }
}

static void LA_Capture_Core1(void* arg) {
  (void)arg;
  initCore1DedicGpio();
  for (;;) {
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);

    CaptureRequest req = pendingCaptureReq;
    const uint8_t rateId = (req.rateId < RATE_PRESET_COUNT) ? req.rateId : (RATE_PRESET_COUNT - 1);
    const uint32_t rateHz = RATE_PRESETS_HZ[rateId];
    const uint8_t blocksKb = (req.blocksKb < 1) ? 1 : (req.blocksKb > 32 ? 32 : req.blocksKb);
    const uint32_t totalSamples = (uint32_t)blocksKb * 1024U;
    const uint8_t edgeType = req.trigCfg & 0x03U;
    const uint8_t preTrigCode = (req.trigCfg >> 4) & 0x03U;

    uint32_t preTrigSamples = 0;
    if (req.trigCh < CHANNEL_COUNT) {
      if (preTrigCode == 1) {
        preTrigSamples = totalSamples / 4U;
      } else if (preTrigCode == 2) {
        preTrigSamples = totalSamples / 2U;
      } else if (preTrigCode == 3) {
        preTrigSamples = (totalSamples * 3U) / 4U;
      }
    }

    uint32_t actualSamples = 0;
    uint16_t trigIndex = 0;
    uint16_t flags = 0;
    uint32_t actualRateHz = rateHz;

    if (rateId >= 3) {
      executeHighSpeedCapture(
        rateHz,
        req.trigCh,
        edgeType,
        totalSamples,
        preTrigSamples,
        &actualSamples,
        &trigIndex,
        &flags,
        &actualRateHz
      );
    } else {
      executeLowSpeedCapture(
        rateHz,
        req.trigCh,
        edgeType,
        totalSamples,
        preTrigSamples,
        &actualSamples,
        &trigIndex,
        &flags,
        &actualRateHz
      );
    }

    transmitCaptureFrame(actualRateHz, trigIndex, flags, actualSamples);

    laAbortRequested = false;
    laCaptureActive = false;
  }
}

// -----------------------------------------------------------------------------
// Command Handlers & Contention Watchdog (Core 0)
// -----------------------------------------------------------------------------

static void handlePinForceCmd(uint8_t p1Ch, uint8_t p2Mode, uint8_t p3Pull, uint8_t p4Protect) {
  if (p1Ch == 0xFF) {
    releaseAllChannels();
    return;
  }
  if (p1Ch >= CHANNEL_COUNT) {
    return;
  }

  const uint8_t ch = p1Ch;
  const uint8_t bit = (uint8_t)(1U << ch);
  const uint8_t mode = (p2Mode <= 2) ? p2Mode : 0;
  const uint8_t pull = (p3Pull <= 2) ? p3Pull : 0;

  if (stateMutex) {
    xSemaphoreTake(stateMutex, portMAX_DELAY);
  }

  chMode[ch] = mode;
  chPull[ch] = pull;
  sigGenPinMask &= (uint8_t)(~bit);
  contentionMask &= (uint8_t)(~bit);
  mismatchActive[ch] = false;
  mismatchStartUs[ch] = 0;

  if (p4Protect) {
    protectMask |= bit;
  } else {
    protectMask &= (uint8_t)(~bit);
  }

  if (mode == 1) {
    forceEnableMask |= bit;
    forcedLevelMask &= (uint8_t)(~bit);
  } else if (mode == 2) {
    forceEnableMask |= bit;
    forcedLevelMask |= bit;
  } else {
    forceEnableMask &= (uint8_t)(~bit);
    forcedLevelMask &= (uint8_t)(~bit);
  }

  applyChannelHardware(ch, mode, pull);
  immediateTelemetryPending = true;

  if (stateMutex) {
    xSemaphoreGive(stateMutex);
  }
}

static void handleBatchForceCmd(uint8_t enableMask, uint8_t levelMask, uint8_t pullupMask) {
  if (stateMutex) {
    xSemaphoreTake(stateMutex, portMAX_DELAY);
  }

  sigGenPinMask &= (uint8_t)(~enableMask);
  forceEnableMask = enableMask;
  forcedLevelMask = levelMask & enableMask;
  contentionMask = 0x00;

  for (uint8_t ch = 0; ch < CHANNEL_COUNT; ch++) {
    const uint8_t bit = (uint8_t)(1U << ch);
    mismatchActive[ch] = false;
    mismatchStartUs[ch] = 0;

    if (enableMask & bit) {
      chMode[ch] = (levelMask & bit) ? 2 : 1;
      chPull[ch] = 0;
    } else {
      chMode[ch] = 0;
      chPull[ch] = (pullupMask & bit) ? 1 : 0;
    }
    applyChannelHardware(ch, chMode[ch], chPull[ch]);
  }

  immediateTelemetryPending = true;

  if (stateMutex) {
    xSemaphoreGive(stateMutex);
  }
}

static void handleEnterBootloader() {
  releaseAllChannels();
  sendTelemetryFrame();
#if CONFIG_IDF_TARGET_ESP32C6
  sendTextLocked("\r\n[HotWire] Entering ESP32-C6 ROM Download Bootloader...\r\n");
#else
  sendTextLocked("\r\n[HotWire] Entering ESP32-S3 ROM Download Bootloader...\r\n");
#endif
  if (txMutex) {
    xSemaphoreTake(txMutex, portMAX_DELAY);
  }
  Serial.flush();
  if (txMutex) {
    xSemaphoreGive(txMutex);
  }
  vTaskDelay(pdMS_TO_TICKS(50));
#if CONFIG_IDF_TARGET_ESP32C6
  REG_SET_BIT(LP_AON_SYS_CFG_REG, LP_AON_FORCE_DOWNLOAD_BOOT);
#else
  REG_SET_BIT(RTC_CNTL_OPTION1_REG, RTC_CNTL_FORCE_DOWNLOAD_BOOT);
#endif
  esp_restart();
}

// -----------------------------------------------------------------------------
// Built-in Signal Generator (Core 0)
// -----------------------------------------------------------------------------

static inline void sigDrivePin(uint8_t ch, uint8_t level) {
  if (sigGenPinMask & (uint8_t)(1U << ch)) {
    preloadOutputLatch(CHANNEL_PINS[ch], level);
  }
}

static inline void sigWaitUntilCycle(uint32_t startCyc, uint32_t offsetCyc) {
  while ((uint32_t)(esp_cpu_get_cycle_count() - startCyc) < offsetCyc) {
    // Tight cycle-accurate wait for bit timing
  }
}

static uint8_t sigGenMaskForMode(uint8_t mode) {
  switch (mode) {
    case 1: return 0x3F; // D0..D5: 4-bit counter + 25%/75% PWM
    case 2: return 0x40; // D6: UART 115200 TX
    case 3: return 0x0F; // D0=SCK, D1=MOSI, D2=MISO, D3=CS#
    case 4: return 0x03; // D0=SCL, D1=SDA
    default: return 0x00;
  }
}

static uint8_t sigGenIdleLevel(uint8_t mode, uint8_t ch) {
  if (mode == 2 && ch == 6) return 1; // UART idle high
  if (mode == 3 && ch == 3) return 1; // SPI CS# idle high
  if (mode == 4 && (ch == 0 || ch == 1)) return 1; // I2C SCL/SDA idle high
  return 0;
}

static void setSigGenMode(uint8_t nextMode) {
  if (stateMutex) {
    xSemaphoreTake(stateMutex, portMAX_DELAY);
  }

  const uint8_t mode = (nextMode <= 4) ? nextMode : 0;
  const uint8_t prevMask = sigGenPinMask;
  const uint8_t nextMask = (uint8_t)(sigGenMaskForMode(mode) & (uint8_t)(~forceEnableMask));

  // Restore any channels no longer used by generator to their user-configured Z/pull state
  const uint8_t releasedMask = (uint8_t)(prevMask & (uint8_t)(~nextMask));
  sigGenPinMask = 0x00;
  sigGenMode = 0;

  for (uint8_t ch = 0; ch < CHANNEL_COUNT; ch++) {
    const uint8_t bit = (uint8_t)(1U << ch);
    if ((releasedMask & bit) && !(forceEnableMask & bit)) {
      applyChannelHardware(ch, chMode[ch], chPull[ch]);
    }
  }

  for (uint8_t ch = 0; ch < CHANNEL_COUNT; ch++) {
    const uint8_t bit = (uint8_t)(1U << ch);
    if (nextMask & bit) {
      const uint8_t pin = CHANNEL_PINS[ch];
      const uint8_t lvl = sigGenIdleLevel(mode, ch);
      preloadOutputLatch(pin, lvl);
      pinMode(pin, OUTPUT);
      preloadOutputLatch(pin, lvl);
    }
  }

  sigGenPinMask = nextMask;
  sigGenMode = mode;
  immediateTelemetryPending = true;

  if (stateMutex) {
    xSemaphoreGive(stateMutex);
  }

  if (mode != 0 && sigGenTaskHandle != nullptr) {
    xTaskNotifyGive(sigGenTaskHandle);
  }
}

static void emitSigGenCounterPwm() {
  // ~100 kHz toggle bursts on D0..D3 + PWM 25%/75% on D4/D5
  const uint32_t stepCyc = CPU_FREQ_HZ / 200000UL; // 5 us per step
  for (uint8_t step = 0; step < 64 && sigGenMode == 1; step++) {
    const uint32_t t0 = esp_cpu_get_cycle_count();
    sigDrivePin(0, (step >> 0) & 1U);
    sigDrivePin(1, (step >> 1) & 1U);
    sigDrivePin(2, (step >> 2) & 1U);
    sigDrivePin(3, (step >> 3) & 1U);
    sigDrivePin(4, ((step & 3U) == 0U) ? 1U : 0U); // 25% duty
    sigDrivePin(5, ((step & 3U) != 3U) ? 1U : 0U); // 75% duty
    sigWaitUntilCycle(t0, stepCyc);
  }
  vTaskDelay(pdMS_TO_TICKS(2));
}

static void emitSigGenUartFrame() {
  static const char msg[] = "HotWire!\r\n";
  const uint32_t bitCyc = CPU_FREQ_HZ / 115200UL; // ~2083 cycles per bit

  for (size_t i = 0; i < sizeof(msg) - 1 && sigGenMode == 2; i++) {
    const uint8_t chByte = (uint8_t)msg[i];
    portENTER_CRITICAL(&sigSpinlock);
    const uint32_t t0 = esp_cpu_get_cycle_count();
    sigDrivePin(6, 0); // Start bit
    sigWaitUntilCycle(t0, bitCyc);
    for (uint8_t b = 0; b < 8; b++) {
      sigDrivePin(6, (chByte >> b) & 1U);
      sigWaitUntilCycle(t0, bitCyc * (uint32_t)(b + 2U));
    }
    sigDrivePin(6, 1); // Stop bit
    sigWaitUntilCycle(t0, bitCyc * 10U);
    portEXIT_CRITICAL(&sigSpinlock);
  }
  vTaskDelay(pdMS_TO_TICKS(3));
}

static void emitSigGenSpiBurst() {
  static const uint8_t mosi[4] = { 0xA5, 0x5A, 0x48, 0x57 };
  static const uint8_t miso[4] = { 0x11, 0x22, 0x33, 0x44 };
  const uint32_t halfCyc = CPU_FREQ_HZ / 500000UL; // 2 us half-clock (~250 kHz SCK)

  portENTER_CRITICAL(&sigSpinlock);
  uint32_t t0 = esp_cpu_get_cycle_count();
  sigDrivePin(0, 0); // SCK low
  sigDrivePin(3, 0); // CS# active low
  sigWaitUntilCycle(t0, halfCyc * 2U);

  for (size_t idx = 0; idx < 4 && sigGenMode == 3; idx++) {
    for (int8_t b = 7; b >= 0; b--) {
      sigDrivePin(1, (mosi[idx] >> b) & 1U);
      sigDrivePin(2, (miso[idx] >> b) & 1U);
      t0 = esp_cpu_get_cycle_count();
      sigDrivePin(0, 0);
      sigWaitUntilCycle(t0, halfCyc);
      sigDrivePin(0, 1);
      sigWaitUntilCycle(t0, halfCyc * 2U);
    }
  }

  t0 = esp_cpu_get_cycle_count();
  sigDrivePin(0, 0);
  sigWaitUntilCycle(t0, halfCyc);
  sigDrivePin(3, 1); // CS# idle high
  portEXIT_CRITICAL(&sigSpinlock);

  vTaskDelay(pdMS_TO_TICKS(3));
}

static void emitSigGenI2cByte(uint8_t byteVal, uint32_t qCyc) {
  for (int8_t b = 7; b >= 0; b--) {
    const uint32_t t0 = esp_cpu_get_cycle_count();
    sigDrivePin(0, 0);
    sigDrivePin(1, (byteVal >> b) & 1U);
    sigWaitUntilCycle(t0, qCyc);
    sigDrivePin(0, 1);
    sigWaitUntilCycle(t0, qCyc * 3U);
    sigDrivePin(0, 0);
    sigWaitUntilCycle(t0, qCyc * 4U);
  }
  // 9th clock ACK (SDA=0)
  const uint32_t tAck = esp_cpu_get_cycle_count();
  sigDrivePin(0, 0);
  sigDrivePin(1, 0);
  sigWaitUntilCycle(tAck, qCyc);
  sigDrivePin(0, 1);
  sigWaitUntilCycle(tAck, qCyc * 3U);
  sigDrivePin(0, 0);
  sigWaitUntilCycle(tAck, qCyc * 4U);
}

static void emitSigGenI2cBurst() {
  static const uint8_t payload[4] = { (uint8_t)(0x3C << 1), 0x00, 0xAE, 0xAF };
  const uint32_t qCyc = CPU_FREQ_HZ / 400000UL; // 2.5 us quarter-bit (~100 kHz I2C)

  portENTER_CRITICAL(&sigSpinlock);
  uint32_t t0 = esp_cpu_get_cycle_count();
  // START: SDA falls while SCL=1
  sigDrivePin(0, 1);
  sigDrivePin(1, 0);
  sigWaitUntilCycle(t0, qCyc * 2U);
  sigDrivePin(0, 0);
  sigWaitUntilCycle(t0, qCyc * 3U);

  for (size_t i = 0; i < 4 && sigGenMode == 4; i++) {
    emitSigGenI2cByte(payload[i], qCyc);
  }

  // STOP: SDA rises while SCL=1
  t0 = esp_cpu_get_cycle_count();
  sigDrivePin(0, 0);
  sigDrivePin(1, 0);
  sigWaitUntilCycle(t0, qCyc);
  sigDrivePin(0, 1);
  sigWaitUntilCycle(t0, qCyc * 3U);
  sigDrivePin(1, 1);
  portEXIT_CRITICAL(&sigSpinlock);

  vTaskDelay(pdMS_TO_TICKS(3));
}

static void SigGen_Core0_Task(void* arg) {
  (void)arg;
  for (;;) {
#if SOC_CPU_CORES_NUM == 1
    if (inlineCaptureBusy) {
      vTaskDelay(1);
      continue;
    }
#endif
    const uint8_t mode = sigGenMode;
    switch (mode) {
      case 1: emitSigGenCounterPwm(); break;
      case 2: emitSigGenUartFrame(); break;
      case 3: emitSigGenSpiBurst(); break;
      case 4: emitSigGenI2cBurst(); break;
      default:
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(100));
        break;
    }
  }
}

static void dispatchBinaryCommand(const uint8_t cmd[8]) {
  const uint8_t cmdId = cmd[2];
  const uint8_t p1 = cmd[3];
  const uint8_t p2 = cmd[4];
  const uint8_t p3 = cmd[5];
  const uint8_t p4 = cmd[6];

  switch (cmdId) {
    case CMD_PING_STATUS:
      sendTelemetryFrame();
      break;

    case CMD_GET_CAPS:
      sendCapabilitiesFrame();
      break;

    case CMD_PIN_FORCE:
      handlePinForceCmd(p1, p2, p3, p4);
      break;

    case CMD_BATCH_FORCE:
      handleBatchForceCmd(p1, p2, p3);
      break;

    case CMD_SIG_GEN:
      setSigGenMode(p1);
      break;

    case CMD_LA_CAPTURE:
      if (!laCaptureActive && core1TaskHandle != nullptr) {
        laAbortRequested = false;
        laCaptureActive = true;
        pendingCaptureReq.rateId = p1;
        pendingCaptureReq.trigCh = p2;
        pendingCaptureReq.trigCfg = p3;
        pendingCaptureReq.blocksKb = p4;
        xTaskNotifyGive(core1TaskHandle);
      }
      break;

    case CMD_LA_ABORT:
      if (laCaptureActive) {
        laAbortRequested = true;
      }
      break;

    case CMD_BOOTLOADER:
      // Require the shared HotWire bootloader magic (B0 07 10 AD) so a
      // stray 0xF0 command can never reboot an active capture session.
      if (hotwire_is_bootloader_magic(p1, p2, p3, p4)) {
        handleEnterBootloader();
      }
      break;

    default:
      break;
  }
}

static void handleAsciiLine(const char* line) {
  if (strcmp(line, "help") == 0) {
    sendTextLocked(
      "\r\nHotWire Commands:\r\n"
      "  help     - Show this command list\r\n"
      "  status   - Print live pin states and contention status\r\n"
      "  pins     - Show D0..D7 GPIO mapping\r\n"
      "  release  - Release all 8 channels to Z and stop signal generator\r\n"
      "  gen <m>  - Signal generator: off | counter | uart | spi | i2c\r\n"
      "  version  - Show firmware version\r\n"
    );
  } else if (strcmp(line, "version") == 0) {
#if CONFIG_IDF_TARGET_ESP32C6
    sendTextLocked("\r\nHotWire-XIAO-ESP32C6 v" HOTWIRE_FW_VERSION " (20 MHz 8-ch LA + Tri-State Force I/O + SigGen)\r\n");
#else
    sendTextLocked("\r\nHotWire-XIAO-ESP32S3 v" HOTWIRE_FW_VERSION " (20 MHz 8-ch LA + Tri-State Force I/O + SigGen)\r\n");
#endif
  } else if (strcmp(line, "pins") == 0) {
#if CONFIG_IDF_TARGET_ESP32C6
    sendTextLocked(
      "\r\nCH0=D0(GPIO0) CH1=D1(GPIO1) CH2=D2(GPIO2) CH3=D3(GPIO21)\r\n"
      "CH4=D4(GPIO22) CH5=D5(GPIO23) CH6=D6(GPIO16) CH7=D7(GPIO17)\r\n"
    );
#else
    sendTextLocked(
      "\r\nCH0=D0(GPIO1) CH1=D1(GPIO2) CH2=D2(GPIO3) CH3=D3(GPIO4)\r\n"
      "CH4=D4(GPIO5) CH5=D5(GPIO6) CH6=D6(GPIO43) CH7=D7(GPIO44)\r\n"
    );
#endif
  } else if (strcmp(line, "release") == 0) {
    releaseAllChannels();
    sendTextLocked("\r\n[HotWire] All channels D0..D7 released to Z.\r\n");
  } else if (strncmp(line, "gen ", 4) == 0 || strcmp(line, "gen") == 0) {
    const char* arg = (line[3] == ' ') ? (line + 4) : "";
    uint8_t nextMode = 255;
    if (strcmp(arg, "off") == 0 || strcmp(arg, "0") == 0) nextMode = 0;
    else if (strcmp(arg, "counter") == 0 || strcmp(arg, "pwm") == 0 || strcmp(arg, "1") == 0) nextMode = 1;
    else if (strcmp(arg, "uart") == 0 || strcmp(arg, "2") == 0) nextMode = 2;
    else if (strcmp(arg, "spi") == 0 || strcmp(arg, "3") == 0) nextMode = 3;
    else if (strcmp(arg, "i2c") == 0 || strcmp(arg, "4") == 0) nextMode = 4;

    if (nextMode <= 4) {
      setSigGenMode(nextMode);
      char buf[64];
      snprintf(buf, sizeof(buf), "\r\n[HotWire] Signal generator mode=%u (mask=0x%02X)\r\n", nextMode, sigGenPinMask);
      sendTextLocked(buf);
    } else {
      sendTextLocked("\r\nUsage: gen <off|counter|uart|spi|i2c>\r\n");
    }
  } else if (strcmp(line, "status") == 0) {
    uint8_t phys = readAllChannelsFast();
    char buf[192];
    snprintf(
      buf,
      sizeof(buf),
      "\r\n[STATUS] phys=0x%02X forceEn=0x%02X forced=0x%02X contention=0x%02X sigGen=%u\r\n",
      phys,
      forceEnableMask,
      forcedLevelMask,
      contentionMask,
      sigGenMode
    );
    sendTextLocked(buf);
  } else if (line[0] != '\0') {
    char buf[96];
    snprintf(buf, sizeof(buf), "\r\nUnknown command: '%s' (type 'help')\r\n", line);
    sendTextLocked(buf);
  }
}

static void checkContentionWatchdog(uint64_t nowUs) {
  if (!stateMutex) {
    return;
  }
  xSemaphoreTake(stateMutex, portMAX_DELAY);
  const uint8_t physical = readAllChannelsFast();

  for (uint8_t ch = 0; ch < CHANNEL_COUNT; ch++) {
    const uint8_t bit = (uint8_t)(1U << ch);
    if ((forceEnableMask & bit) && !(sigGenPinMask & bit) && (protectMask & bit)) {
      const bool expected = (forcedLevelMask & bit) != 0;
      const bool actual = (physical & bit) != 0;
      if (actual != expected) {
        if (!mismatchActive[ch]) {
          mismatchActive[ch] = true;
          mismatchStartUs[ch] = nowUs;
        } else if ((nowUs - mismatchStartUs[ch]) >= CONTENTION_CUTOFF_US) {
          // 20 ms contention cutoff reached: revert to Z Floating immediately
          chMode[ch] = 0;
          chPull[ch] = 0;
          forceEnableMask &= (uint8_t)(~bit);
          forcedLevelMask &= (uint8_t)(~bit);
          contentionMask |= bit;
          mismatchActive[ch] = false;
          mismatchStartUs[ch] = 0;
          applyChannelHardware(ch, 0, 0);
          immediateTelemetryPending = true;
        }
      } else {
        mismatchActive[ch] = false;
        mismatchStartUs[ch] = 0;
      }
    } else {
      mismatchActive[ch] = false;
      mismatchStartUs[ch] = 0;
    }
  }
  xSemaphoreGive(stateMutex);
}

static void Protocol_Core0_Task(void* arg) {
  (void)arg;

  enum RxState {
    RX_IDLE,
    RX_SYNC1,
    RX_CMD_BODY
  };

  RxState rxState = RX_IDLE;
  uint8_t cmdBuf[8] = { 0 };
  uint8_t cmdPos = 0;

  char asciiLine[64];
  uint8_t asciiLen = 0;

  uint8_t lastPhysical = readAllChannelsFast();
  uint64_t lastTelemetryUs = (uint64_t)esp_timer_get_time();
  uint64_t lastChangeTelemetryUs = 0;

  for (;;) {
    // 1. Non-blocking USB CDC reception
    while (Serial.available() > 0) {
      int bInt = Serial.read();
      if (bInt < 0) {
        break;
      }
      uint8_t b = (uint8_t)bInt;

      if (rxState == RX_IDLE) {
        if (b == SYNC_BYTE_0) {
          cmdBuf[0] = b;
          rxState = RX_SYNC1;
        } else if (b == '\r' || b == '\n') {
          if (asciiLen > 0) {
            asciiLine[asciiLen] = '\0';
            handleAsciiLine(asciiLine);
            asciiLen = 0;
          }
        } else if (b >= 0x20 && b < 0x7F) {
          if (asciiLen < sizeof(asciiLine) - 1U) {
            asciiLine[asciiLen++] = (char)b;
          }
        }
      } else if (rxState == RX_SYNC1) {
        if (b == SYNC_BYTE_1) {
          cmdBuf[1] = b;
          cmdPos = 2;
          rxState = RX_CMD_BODY;
        } else if (b == SYNC_BYTE_0) {
          cmdBuf[0] = b;
        } else {
          rxState = RX_IDLE;
        }
      } else {
        cmdBuf[cmdPos++] = b;
        if (cmdPos >= 8) {
          uint8_t xorCalc = 0;
          for (uint8_t i = 0; i < 7; i++) {
            xorCalc ^= cmdBuf[i];
          }
          if (xorCalc == cmdBuf[7]) {
            dispatchBinaryCommand(cmdBuf);
          }
          rxState = RX_IDLE;
          cmdPos = 0;
        }
      }
    }

    const uint64_t nowUs = (uint64_t)esp_timer_get_time();

    // 2. 20 ms Bus Contention Auto-Cutoff Guard
    checkContentionWatchdog(nowUs);

    // 3. 25 Hz Idle & Change-Driven Live Pin Telemetry (pause while LA capture/TX active)
    if (!laCaptureActive) {
      const uint8_t curPhysical = readAllChannelsFast();
      const uint8_t externalChanged = (uint8_t)((curPhysical ^ lastPhysical) & (uint8_t)(~sigGenPinMask));
      const bool periodicDue = (nowUs - lastTelemetryUs) >= TELEMETRY_INTERVAL_US;
      const bool changeDue = (externalChanged != 0U) && ((nowUs - lastChangeTelemetryUs) >= CHANGE_THROTTLE_US);

      if (immediateTelemetryPending || periodicDue || changeDue) {
        immediateTelemetryPending = false;
        lastPhysical = curPhysical;
        lastTelemetryUs = nowUs;
        if (externalChanged != 0U) {
          lastChangeTelemetryUs = nowUs;
        }
        sendTelemetryFrame();
      }
    }

    vTaskDelay(1);
  }
}

// -----------------------------------------------------------------------------
// Arduino Setup & Loop
// -----------------------------------------------------------------------------

void setup() {
#if CONFIG_IDF_TARGET_ESP32C6
  REG_CLR_BIT(LP_AON_SYS_CFG_REG, LP_AON_FORCE_DOWNLOAD_BOOT);
#else
  REG_CLR_BIT(RTC_CNTL_OPTION1_REG, RTC_CNTL_FORCE_DOWNLOAD_BOOT);
#endif
#if SOC_CPU_CORES_NUM == 1
  initInlineSigGenTables();
#endif
  stateMutex = xSemaphoreCreateMutex();
  txMutex = xSemaphoreCreateMutex();

  // Ensure all 8 channels D0..D7 start safely in High-Z Input (Z)
  for (uint8_t ch = 0; ch < CHANNEL_COUNT; ch++) {
    pinMode(CHANNEL_PINS[ch], INPUT);
  }

#if ARDUINO_USB_MODE == 1
  Serial.setTxBufferSize(36864);
  Serial.setRxBufferSize(1024);
#else
  Serial.setRxBufferSize(1024);
#endif
  Serial.begin(115200);

  static const BaseType_t LA_CAPTURE_CORE = (SOC_CPU_CORES_NUM > 1) ? 1 : 0;
  xTaskCreatePinnedToCore(
    LA_Capture_Core1,
    "LA_Capture",
    4096,
    nullptr,
    configMAX_PRIORITIES - 1,
    &core1TaskHandle,
    LA_CAPTURE_CORE
  );

  xTaskCreatePinnedToCore(
    Protocol_Core0_Task,
    "Protocol_Core0",
    4096,
    nullptr,
    2,
    &core0TaskHandle,
    0
  );

  xTaskCreatePinnedToCore(
    SigGen_Core0_Task,
    "SigGen_Core0",
    2048,
    nullptr,
    1,
    &sigGenTaskHandle,
    0
  );
}

void loop() {
  vTaskDelay(pdMS_TO_TICKS(1000));
}
