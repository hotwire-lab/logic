# HotWire Pocket Lab — 8-Channel Logic Analyzer & Tri-State Force I/O

A zero-install **Progressive Web App (PWA)** paired with **Seeed Studio XIAO ESP32-S3** firmware (`HotWire_XIAO_ESP32S3.ino`) providing an **8-channel digital logic analyzer (`D0`–`D7`, up to 20 MHz / 32,768 samples)**, **25 Hz live pin telemetry**, and **glitch-free tri-state forcing (`Z` / `0` / `1` + Pull-Up/Pull-Down + 20 ms short-circuit auto-cutoff)** over a single multiplexed USB CDC stream.

**Live Web App (GitHub Pages):** https://kavierim.github.io/HotWire-Logic-Analyzer/

## Features

* **Dual-Platform USB Connectivity (`SerialTransport`):**
  * **Desktop Chrome / Edge:** **Web Serial API** (`115200`, `DTR=true, RTS=true`) with automatic zero-touch hot-plug reconnection.
  * **Android Chrome / Tablets:** **WebUSB API** targeting CDC-ACM / Espressif (`0x303A`) / Seeed (`0x2886`) interfaces with explicit `SET_CONTROL_LINE_STATE` (`0x22`, `value: 0x0003`) control transfer.
  * **Offline Simulator (`Demo`):** Interactive XIAO ESP32-S3 protocol simulator with waveforms, pin forcing, and simulated short-circuit protection.
* **8-Channel Pin Mapping (XIAO ESP32-S3):**
  * `CH0`–`CH5`: `D0`–`D5` -> `GPIO 1`–`6`
  * `CH6`–`CH7`: `D6`–`D7` -> `GPIO 43`–`44`
  * Internal USB pins (`GPIO 19`, `GPIO 20`) are never touched.
* **Hardware-Verified 20 MHz Dual-Core Firmware:**
  * **Core 0:** Non-blocking binary + UTF-8 command parser, `25 Hz` change-driven `0x81` telemetry, and `20 ms` bus contention auto-cutoff watchdog.
  * **Core 1:** Dedicated `LA_Capture_Core1` task (`configMAX_PRIORITIES - 1`) using single-cycle Dedicated GPIO (`ee.get_gpio_in`) for deterministic `100 kHz`–`20 MHz` bursts and `esp_timer_get_time()` for abortable `1 kHz`–`50 kHz` captures, with `0%`/`25%`/`50%` pre-trigger circular buffer linearization.
* **Single-Screen Dark UI & Tools:**
  * Sticky 8-row Tri-State Force strip (`[ Z ] [ 0 ] [ 1 ]`, momentary `[ ⚡ ]` pulse, `[ - | PU | PD ]` pull control, flashing `SHORT!` fault indicator, and red `[ Release All (Z) ]` button).
  * High-DPI interactive `<canvas>` waveform viewer aligned 1:1 with the 8 channel rows, featuring dynamic time ruler, trigger marker, zoom/pan/touch-pinch, and draggable `A`/`B` measurement cursors ($\Delta t$ and $1/\Delta t$).
  * Collapsible bottom drawer with **`xterm.js` Serial Terminal** and **`esptool-js` Web Flasher** (`0xF0` auto-reboot to ROM bootloader + `.bin` flashing).

## Arduino IDE Firmware Build Settings

Open [HotWire_XIAO_ESP32S3.ino](./firmware/HotWire_XIAO_ESP32S3/HotWire_XIAO_ESP32S3.ino) in Arduino IDE (or `arduino-cli`) with Espressif ESP32 Core (`v2.0.14+` or `v3.x`):

* **Board:** `XIAO_ESP32S3` (`esp32:esp32:XIAO_ESP32S3`)
* **USB CDC On Boot:** `Enabled`
* **CPU Frequency:** `240MHz (WiFi)`

## Development

```bash
npm install
npm run dev
```

Verify lint, typecheck, unit tests, and production bundle:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```
