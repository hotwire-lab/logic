# Project Specification: HotWire — 8-Channel Logic Analyzer & Tri-State Force I/O (PWA + XIAO ESP32-S3)

## 1. System Overview & Concept

* **Application Name:** HotWire Pocket Lab (8-Channel Edition)
* **Core Concept:** A zero-install **Progressive Web App (PWA)** paired with a **Seeed Studio XIAO ESP32-S3** firmware (compatible with Arduino IDE and PlatformIO). The system functions as an 8-channel digital logic analyzer (`D0`–`D7`), real-time pin state monitor, and interactive tri-state pattern forcing tool where every channel can dynamically be forced to `1` (HIGH), `0` (LOW), or `Z` (High-Impedance Input) directly from the browser UI.
* **Dual-Platform Connectivity:**
  * **Android Phones & Tablets (Chrome):** Connects via **WebUSB API** targeting the USB CDC-ACM interface with explicit USB Control Transfer assertion for DTR/RTS lines.
  * **Desktop PC / Mac / Linux (Chrome / Edge):** Connects via **Web Serial API** (with WebUSB fallback) and supports automatic zero-menu reconnection upon USB hot-plug events.
* **Single-Byte Channel Packing (8 Channels):** Because the system uses exactly 8 channels (`CH0`–`CH7`), both live telemetry states and high-speed logic analyzer samples pack into a single `uint8_t` byte (Bit `0` = `D0` ... Bit `7` = `D7`), allowing 32,768 samples to fit inside a 32 KB SRAM buffer.

---

## 2. Hardware Architecture & Pin Mapping (XIAO ESP32-S3)

All 8 logical channels (`CH0`–`CH7`) map directly to physical pins `D0`–`D7` on the Seeed Studio XIAO ESP32-S3. Internal USB pins (`GPIO 19` and `GPIO 20`) must never be touched by the GPIO driver.

| Logical Channel | Bit Mask | XIAO Pin | ESP32-S3 GPIO | Input Register Location | Default Boot State |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **CH0** | `0x01` (Bit 0) | **D0** | `GPIO 1` | `GPIO.in` (Bit 1) | `Z` (High-Z Input) |
| **CH1** | `0x02` (Bit 1) | **D1** | `GPIO 2` | `GPIO.in` (Bit 2) | `Z` (High-Z Input) |
| **CH2** | `0x04` (Bit 2) | **D2** | `GPIO 3` | `GPIO.in` (Bit 3) | `Z` (High-Z Input) |
| **CH3** | `0x08` (Bit 3) | **D3** | `GPIO 4` | `GPIO.in` (Bit 4) | `Z` (High-Z Input) |
| **CH4** | `0x10` (Bit 4) | **D4** | `GPIO 5` | `GPIO.in` (Bit 5) | `Z` (High-Z Input) |
| **CH5** | `0x20` (Bit 5) | **D5** | `GPIO 6` | `GPIO.in` (Bit 6) | `Z` (High-Z Input) |
| **CH6** | `0x40` (Bit 6) | **D6** | `GPIO 43` | `GPIO.in1.val` (Bit 11) | `Z` (High-Z Input) |
| **CH7** | `0x80` (Bit 7) | **D7** | `GPIO 44` | `GPIO.in1.val` (Bit 12) | `Z` (High-Z Input) |

### 2.1 Fast Single-Cycle Register Acquisition Rule
To achieve up to 20 MHz sampling on the ESP32-S3 without DMA setup overhead, the firmware must read all 8 channels in a single inline operation placed in Instruction RAM (`IRAM_ATTR`):
* Read the lower 32-bit GPIO bank (`GPIO.in`), shift right by 1 bit, and mask with `0x3F` to extract `CH0`–`CH5` (`GPIO 1`–`6`) into bits `0..5`.
* Read the upper GPIO bank (`GPIO.in1.val`), shift right by 11 bits, mask with `0x03`, and shift left by 6 bits to place `CH6`–`CH7` (`GPIO 43`–`44`) into bits `6..7`.
* Combine both masks via bitwise OR into a single `uint8_t` value.

### 2.2 Electrical Modes & Glitch-Free Tri-State Switching
Each channel supports three primary electrical states plus optional internal pull resistors:
1. **Mode `0` — `Z` (High-Impedance Input / Release):** Output driver is disabled (`INPUT`, `INPUT_PULLUP`, or `INPUT_PULLDOWN` according to pull setting).
2. **Mode `1` — Force `0` (Drive LOW):** Output driver is enabled in bidirectional mode (`INPUT_OUTPUT`) driving `0 V` (GND).
3. **Mode `2` — Force `1` (Drive HIGH):** Output driver is enabled in bidirectional mode (`INPUT_OUTPUT`) driving `3.3 V` (VCC).
4. **Glitch-Free Transition Requirement:** When transitioning a pin from `Z` to Force `0` or Force `1`, the firmware MUST preload the target output latch value *before* enabling the output driver (`INPUT_OUTPUT`) so the pin never emits a transient pulse of the wrong polarity.

### 2.3 Simultaneous Readback & Bus Contention Protection
Because ESP32-S3's `INPUT_OUTPUT` mode keeps the digital input buffer connected to the physical pad at all times:
* The firmware continuously reads the real physical voltage level on all 8 pins, even while forcing outputs.
* **20 ms Auto-Cutoff Guard:** If a channel is forced to `0` or `1` (with protection enabled) and its physical readback state opposes the forced level continuously for more than `20 ms`, the firmware must immediately revert that channel to `Z` (High-Z Floating), set the channel's bit in `contention_mask`, and transmit an immediate status telemetry frame to alert the user of a short circuit or bus conflict.

---

## 3. Binary Multiplexing Protocol (Single USB CDC Stream)

Both human-readable UTF-8 serial logs and binary control/capture frames share the single USB CDC stream.
* **Sync Header:** Every binary packet begins with the 2-byte sequence `[0xAA, 0x55]`.
* **Checksum:** Every binary packet ends with a 1-byte `XOR_CHECKSUM` equal to the bitwise XOR of all preceding bytes in the packet (including the sync bytes `0xAA` and `0x55`).
* **Demultiplexing State Machine (PWA Side):** The host stream parser scans for `0xAA 0x55`. Upon detection, it reads the frame type and 16-bit payload length (`LEN <= 32776`). If the type is valid and the trailing `XOR_CHECKSUM` matches, the packet is processed by the binary handler. If validation fails, the buffered bytes are flushed directly to the `xterm.js` terminal as plain text.

### 3.1 Host-to-Device Command Frames (Fixed 8 Bytes)
Structure: `[0xAA, 0x55, CMD_ID, P1, P2, P3, P4, XOR_CHECKSUM]`

1. **`0x01 (CMD_PING_STATUS)`:**
   * Requests an immediate `0x81` telemetry frame.
2. **`0x02 (CMD_GET_CAPS)`:**
   * Requests the `0x83` JSON board capability descriptor.
3. **`0x10 (CMD_PIN_FORCE)`:**
   * Sets the electrical state of a single channel or releases all channels.
   * `P1 (CH)`: Channel index (`0..7`), or `0xFF` to release ALL 8 channels to `Z` and clear all contention fault flags.
   * `P2 (MODE)`: `0` = `Z` (High-Z Input), `1` = Force `0` (LOW), `2` = Force `1` (HIGH).
   * `P3 (PULL)`: `0` = Floating (None), `1` = Pull-Up (~45 k$\Omega$), `2` = Pull-Down (~45 k$\Omega$). Applied when in `Z` mode.
   * `P4 (PROTECT)`: `1` = Enable 20 ms contention auto-cutoff (default), `0` = Disable.
4. **`0x11 (CMD_BATCH_FORCE)`:**
   * Updates all 8 channels atomically.
   * `P1`: `force_enable_mask` (`uint8_t` — Bit `k = 1` forces output, `0` sets `Z`).
   * `P2`: `forced_level_mask` (`uint8_t` — Bit `k = 1` drives HIGH, `0` drives LOW for enabled bits).
   * `P3`: `pullup_mask` (`uint8_t` — Bit `k = 1` enables internal pull-up on `Z` channels).
   * `P4`: Reserved (`0x00`).
5. **`0x20 (CMD_LA_CAPTURE)`:**
   * Initiates an 8-channel logic analyzer capture on Core 1.
   * `P1 (RATE_ID)`: Sample rate preset index (`0..10`):
     * `0`: `1 kHz` ($\Delta t = 1\text{ ms}$, Window @ 16k = $16.38\text{ s}$)
     * `1`: `10 kHz` ($\Delta t = 100\ \mu\text{s}$, Window @ 16k = $1.64\text{ s}$)
     * `2`: `50 kHz` ($\Delta t = 20\ \mu\text{s}$, Window @ 16k = $327.7\text{ ms}$)
     * `3`: `100 kHz` ($\Delta t = 10\ \mu\text{s}$, Window @ 16k = $163.8\text{ ms}$)
     * `4`: `250 kHz` ($\Delta t = 4\ \mu\text{s}$, Window @ 16k = $65.5\text{ ms}$)
     * `5`: `500 kHz` ($\Delta t = 2\ \mu\text{s}$, Window @ 16k = $32.8\text{ ms}$)
     * `6`: `1 MHz` ($\Delta t = 1\ \mu\text{s}$, Window @ 16k = $16.4\text{ ms}$)
     * `7`: `2 MHz` ($\Delta t = 500\text{ ns}$, Window @ 16k = $8.19\text{ ms}$)
     * `8`: `5 MHz` ($\Delta t = 200\text{ ns}$, Window @ 16k = $3.28\text{ ms}$)
     * `9`: `10 MHz` ($\Delta t = 100\text{ ns}$, Window @ 16k = $1.64\text{ ms}$)
     * `10`: `20 MHz` ($\Delta t = 50\text{ ns}$, Window @ 16k = $819.2\ \mu\text{s}$)
   * `P2 (TRIG_CH)`: Trigger channel (`0..7`), or `0xFF` for Free-Run / Immediate capture.
   * `P3 (TRIG_CFG)`:
     * Bits `0..1`: Edge condition (`0` = Falling `↓`, `1` = Rising `↑`, `2` = Any Edge `↕`).
     * Bits `4..5`: Pre-trigger buffer ratio (`0` = 0%, `1` = 25%, `2` = 50% center trigger).
   * `P4 (BLOCKS_KB)`: Capture buffer size in 1024-sample increments (`1..32`, where `32` = 32,768 samples = 32 KB).
6. **`0x21 (CMD_LA_ABORT)`:**
   * Immediately aborts an ongoing low-speed capture or trigger wait and returns the partial capture buffer.
7. **`0xF0 (CMD_BOOTLOADER)`:**
   * Releases all pins to `Z`, sets the ESP32-S3 RTC download boot flag (`RTC_CNTL_FORCE_DOWNLOAD_BOOT` in `RTC_CNTL_OPTION1_REG`), and triggers a software reset so the browser can flash new firmware via WebUSB/WebSerial without pressing physical buttons.

### 3.2 Device-to-Host Response Frames
Structure: `[0xAA, 0x55, TYPE_ID, LEN_L, LEN_H, ...PAYLOAD..., XOR_CHECKSUM]` (Little Endian length).

1. **`TYPE_ID = 0x81 (STATUS_TELEMETRY)` (Payload = 4 Bytes):**
   * Transmitted automatically at `25 Hz` (every 40 ms) when idle, and **immediately** whenever any pin's physical state or force configuration changes.
   * `Byte 0`: `physical_levels` (`uint8_t` — live physical voltage states of `D0`–`D7`).
   * `Byte 1`: `force_enable_mask` (`uint8_t` — `1` = Output driver active, `0` = `Z` High-Z).
   * `Byte 2`: `forced_levels` (`uint8_t` — commanded level `0` or `1`).
   * `Byte 3`: `contention_mask` (`uint8_t` — `1` = contention fault cutoff occurred).
2. **`TYPE_ID = 0x82 (LA_CAPTURE_DATA)` (Payload = `8 + N` Bytes):**
   * `Bytes 0..3`: `uint32_t sample_rate_hz` (Actual capture rate in Hz, Little Endian).
   * `Bytes 4..5`: `uint16_t trigger_index` (0-based index within the sample array where the trigger event occurred).
   * `Bytes 6..7`: `uint16_t flags` (`Bit 0` = Triggered, `Bit 1` = Auto-triggered on timeout, `Bit 2` = Aborted early).
   * `Bytes 8..(8+N-1)`: `uint8_t samples[N]` (Chronological array of `N` 8-bit samples).
3. **`TYPE_ID = 0x83 (BOARD_CAPABILITIES)`:**
   * UTF-8 JSON descriptor specifying board name (`"XIAO-ESP32-S3"`), channel count (`8`), maximum sample rate (`20000000`), maximum sample depth (`32768`), and pin metadata (`D0`–`D7` with GPIO numbers).

---

## 4. Firmware Architecture Specification (Arduino IDE / ESP32-S3)

The firmware must be deliverable as a single, self-contained Arduino IDE sketch (`HotWire_XIAO_ESP32S3.ino`) requiring zero external third-party libraries beyond the standard Espressif Arduino ESP32 core (`v2.0.14+` or `v3.x`).

### 4.1 Required Arduino IDE Build Configuration
* **Board Target:** `Seeed Studio XIAO ESP32S3`
* **USB CDC On Boot:** `Enabled`
* **CPU Frequency:** `240 MHz`
* **Dual-Core Task Separation:**
  * **Core 0 (`loop()`):** Manages non-blocking USB CDC byte reception, command frame validation, 25 Hz live pin telemetry, and the 20 ms bus contention watchdog.
  * **Core 1 (Dedicated FreeRTOS Task):** Executes the logic analyzer capture engine (`LA_Capture_Core1`) at maximum priority (`configMAX_PRIORITIES - 1`).

### 4.2 Dual-Path Capture Engine & Pre-Trigger Ring Buffer Rules
To support rates from `1 kHz` (32.7-second window) to `20 MHz` (1.6-millisecond window) without triggering FreeRTOS Watchdog resets:

1. **Pre-Trigger Ring Buffer Discipline:**
   * Allocate a 32 KB circular buffer (`ringBuf[32768]`) and a 32 KB linear output buffer (`captureBuffer[32768]`) in internal SRAM (or use in-place rotation).
   * When a trigger channel (`0..7`) is active, the capture loop MUST first collect at least `preTrigSamples` (`0`, `totalSamples / 4`, or `totalSamples / 2`) into the ring buffer *before* enabling edge detection.
   * Once the trigger edge condition is met (or timeout expires), record the exact sample count and collect the remaining `postTrigSamples = totalSamples - preTrigSamples` samples.
   * Linearize the circular buffer so `captureBuffer[0]` is the oldest pre-trigger sample and `trigger_index` points accurately to the trigger transition sample.
2. **High-Speed Capture Path (`100 kHz` – `20 MHz`, `RATE_ID >= 3`):**
   * Execute inside an `IRAM_ATTR` function on Core 1.
   * Enter a critical section (`portENTER_CRITICAL`) during the burst so FreeRTOS tick interrupts do not introduce timing jitter.
   * Pace samples deterministically using the 240 MHz CPU cycle counter (`esp_cpu_get_cycle_count()`), advancing the target cycle count by `cyclesPerSample = 240000000UL / rateHz` on each iteration.
   * Enforce a 1-second hardware cycle timeout while waiting for a trigger edge so Core 1 never deadlocks if the signal is static.
3. **Low-Speed Capture Path (`1 kHz` – `50 kHz`, `RATE_ID <= 2`):**
   * Keep interrupts enabled so USB CDC remains responsive and Core 0 can process `0x21 (CMD_LA_ABORT)`.
   * Pace samples using the 64-bit microsecond hardware timer (`esp_timer_get_time()`), yielding via `vTaskDelay(1)` when the sample interval exceeds `2000 µs` to feed the Idle Watchdog.
   * Enforce a 5-second trigger wait timeout before auto-triggering.
4. **Non-Blocking USB CDC Payload Transmission:**
   * When transmitting the `0x82` capture frame (up to 32,776 bytes), write the payload in chunks of `256` or `512` bytes, checking `Serial.availableForWrite()` and yielding briefly if the USB TX FIFO is full to prevent dropped bytes on Android and Desktop hosts.

---

## 5. PWA Frontend Architecture & UX Specification (`/web`)

### 5.1 Transport Layer (`SerialTransport`)
Implement a unified TypeScript transport manager supporting two backends:
1. **WebUSB Backend (Primary on Android Chrome, Optional on Desktop):**
   * Filters for USB CDC-ACM devices (or Espressif VID `0x303A`).
   * Claims the CDC Control and Data interfaces (`claimInterface`).
   * **Mandatory Control Transfer:** Immediately sends USB control transfer `SET_CONTROL_LINE_STATE` (`requestType: 'class'`, `recipient: 'interface'`, `request: 0x22`, `value: 0x0003`) to assert DTR + RTS so the ESP32-S3 USB stack enables transmission.
   * Runs an asynchronous `transferIn` loop on the Bulk IN endpoint and writes commands via `transferOut` on the Bulk OUT endpoint.
2. **Web Serial Backend (Desktop Chrome / Edge Default):**
   * Opens port via `navigator.serial.requestPort()` at `115200` baud (symbolic rate for native USB CDC) and assertions `setSignals({ dataTerminalReady: true, requestToSend: true })`.
3. **Zero-Touch Reconnect:**
   * Listens to `navigator.usb.onconnect` / `navigator.serial.onconnect`. If a previously authorized device is plugged back in, automatically re-opens the stream, sends `0x02 (CMD_GET_CAPS)` and `0x01 (CMD_PING_STATUS)`, and resumes live telemetry without showing any modal dialogs.

### 5.2 Single-Screen Layout & Controls
Design a distraction-free, dark-themed (`#0D1117`) interface that fits on a phone/tablet screen without scrolling:

1. **Top Toolbar:**
   * **Connection Status Pill:** Shows connection state (`Waiting for USB...` / `Connected: XIAO-ESP32-S3`) and `[ Connect ]` button.
   * **Capture Settings Bar:**
     * **Rate Selector:** `1 kHz` to `20 MHz`.
     * **Depth Selector:** `1k`, `4k`, `8k`, `16k`, `32k` samples.
     * **Live Window Readout Badge:** Displays calculated capture duration and sample resolution (e.g., `Window: 16.38 ms | Res: 1.0 µs`).
     * **Trigger Group:** Channel (`Free Run`, `D0`–`D7`), Edge (`↑`, `↓`, `↕`), Pre-trigger (`0%`, `25%`, `50%`).
     * **Capture Actions:** `[ Capture ]` (switches to red `[ Abort ]` during slow captures) and `[ Auto / Continuous ]` toggle.
   * **Emergency Release Button:** Prominent red `[ Release All (Z) ]` button (`CMD_PIN_FORCE` with `P1 = 0xFF`).

2. **Center Split Workspace (8-Channel Force Strip + Waveform Canvas):**
   * **Left Sticky Channel Strip (8 Rows: `D0` to `D7`):**
     * **Live Pin Badge:** Displays `D0`..`D7`, GPIO number subtitle, and a live state indicator (`0` in slate blue, `1` in bright green) updated at 25 Hz from `0x81` telemetry. Flashes red (`SHORT!`) if the channel's `contention_mask` bit is set.
     * **Tri-State Force Segmented Switch (`[ Z ] [ 0 ] [ 1 ]`):**
       * `[ Z ]`: Releases pin to High-Z Input.
       * `[ 0 ]`: Forces pin Output LOW (`0V`).
       * `[ 1 ]`: Forces pin Output HIGH (`3.3V`).
     * **Momentary Pulse Button (`[ ⚡ ]`):** Pressing and holding (`pointerdown`) forces the opposite logic state; releasing (`pointerup` / `pointercancel`) immediately restores the pin to `Z` (or its prior state).
     * **Pull Resistor Selector (`[ - | PU | PD ]`):** Compact toggle active when the row is in `Z` mode.
   * **Right Interactive Waveform Canvas:**
     * High-DPI HTML5 `<canvas>` aligned 1:1 vertically with the 8 channel rows.
     * Renders digital step waveforms, a vertical trigger position marker, and a dynamic time ruler (`ns` / `µs` / `ms` / `s`).
     * Supports touch pinch-to-zoom, mouse-wheel zoom centered on cursor, horizontal touch/drag panning, and two draggable measurement cursors (`A` and `B`) with a floating delta badge ($\Delta t$ and frequency $1/\Delta t$).

3. **Bottom Collapsible Drawer:**
   * **Serial Terminal Tab (`xterm.js`):** Displays all non-binary UTF-8 serial output from the XIAO, equipped with quick macro buttons and an input bar (`CR+LF` / `LF`).
   * **Web Flasher Tab (`esptool-js`):** Provides a `[ Reboot to Bootloader & Flash .bin ]` button that sends `0xF0` and flashes a user-selected `.bin` firmware image directly from the browser.