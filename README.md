# HotWire Logic Analyzer — 8-Channel Pocket Lab & Tri-State Force I/O

[![Deploy to GitHub Pages](https://github.com/hotwire-lab/logic/actions/workflows/deploy.yml/badge.svg)](https://github.com/hotwire-lab/logic/actions/workflows/deploy.yml)
[![Live Web App](https://img.shields.io/badge/Live_Web_App-GitHub_Pages-0ea5e9?logo=googlechrome&logoColor=white)](https://hotwire-lab.github.io/logic/)
[![Hardware](https://img.shields.io/badge/Hardware-XIAO_ESP32--S3_%2F_C6-10b981)](https://www.seeedstudio.com/XIAO-ESP32S3-p-5627.html)
[![Web Serial & WebUSB](https://img.shields.io/badge/USB-Web_Serial_%2F_WebUSB-8b5cf6)](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API)
[![Rust + WASM](https://img.shields.io/badge/Stack-Rust_%2B_Leptos_WASM-f97316?logo=rust&logoColor=white)](https://leptos.dev/)

A zero-install **Progressive Web App (PWA)** built with **Rust + WebAssembly** ([Leptos](https://leptos.dev/) + [Trunk](https://trunkrs.dev/) + [`hotwire-core`](https://github.com/hotwire-lab/hotwire-core)) paired with **Seeed Studio XIAO ESP32-S3 / ESP32-C6** firmware (`HotWire_XIAO_ESP32.ino`, `v1.2.0+`). It provides an **8-channel digital logic analyzer (`D0`–`D7`, up to 20 MHz / 32,768 samples)**, **25 Hz live pin telemetry**, **glitch-free tri-state forcing (`Z` / `0` / `1` + Pull-Up/Pull-Down + 20 ms short-circuit auto-cutoff)**, and **UART / SPI / I²C protocol decoders** over a single multiplexed USB CDC stream.

> **Try it in 1 click (no hardware required):** Open **[https://hotwire-lab.github.io/logic/](https://hotwire-lab.github.io/logic/)** and click **Demo** to explore live captures, pin forcing, and UART/SPI/I²C protocol decoding.

![HotWire Logic Analyzer UI](./docs/screenshot.png)

## Features

* **Unified HotWire Shell (`hotwire-core`):**
  * Top toolbar with instant **Logic / Scope / SDR / Serial** tool switcher, automatic `0x83` target software & version verification (`v1.2.0+` — automatically disconnects and displays a one-click **Flash Firmware** prompt on mismatch), and swipeable mobile **BottomSheet** Web Flasher (`0xF0` auto-reboot to ROM bootloader + bundled `.bin` flashing via `esptool-js`).
* **Dual-Platform USB Connectivity:**
  * **Desktop Chrome / Edge:** **Web Serial API** with automatic zero-touch hot-plug reconnection.
  * **Android Chrome / Tablets:** **WebUSB API** targeting CDC-ACM / Espressif (`0x303A`) / Seeed (`0x2886`) interfaces with explicit `SET_CONTROL_LINE_STATE` (`0x22`, `value: 0x0003`) control transfer.
  * **Offline Simulator (`Demo`):** Interactive XIAO ESP32-S3 protocol simulator with realistic SPI / I²C / UART captures, pin forcing, and simulated short-circuit protection.
* **8-Channel Pin Mapping:**
  * **XIAO ESP32-S3:** `CH0`–`CH5` = `D0`–`D5` (`GPIO 1`–`6`), `CH6`–`CH7` = `D6`–`D7` (`GPIO 43`–`44`). Internal USB pins (`GPIO 19`, `GPIO 20`) are never touched.
  * **XIAO ESP32-C6:** `CH0`–`CH7` mapped to `D0`–`D7` (`GPIO 0, 1, 2, 21, 22, 23, 16, 17`).
* **Hardware-Verified 20 MHz Dual-Core Firmware:**
  * **Core 0:** Non-blocking binary + UTF-8 command parser, `25 Hz` change-driven `0x81` telemetry, and `20 ms` bus contention auto-cutoff watchdog.
  * **Core 1:** Dedicated `LA_Capture_Core1` task (`configMAX_PRIORITIES - 1`) using single-cycle Dedicated GPIO (`ee.get_gpio_in`) for deterministic `100 kHz`–`20 MHz` bursts and `esp_timer_get_time()` for abortable `1 kHz`–`50 kHz` captures, with `0%`/`25%`/`50%`/`75%` pre-trigger circular buffer linearization.
* **Single-Screen Dark UI, Decoders & Export:**
  * Sticky 8-row Tri-State Force strip (`[ Z ] [ 0 ] [ 1 ]`, momentary `[ ⚡ ]` pulse, `[ - | PU | PD ]` pull control, custom channel aliases persisted in `localStorage`, flashing `SHORT!` fault indicator, and red `[ Release All (Z) ]` button).
  * `requestAnimationFrame`-coalesced High-DPI `<canvas>` waveform viewer with activity minimap, dynamic time ruler, trigger marker, cursor-anchored wheel zoom, two-finger touch pinch/pan (`PinchPanTracker`), box-zoom, hover pulse-width/frequency HUD, and edge-snapping `A`/`B` measurement cursors (`Δt` and `1/Δt`).
  * Built-in **UART**, **SPI**, and **I²C** protocol decoders with inline waveform bubbles, clickable decoded frame strip, and **CSV / VCD** capture export.
  * Keyboard shortcuts: `Space` (Capture/Abort), `+`/`-` (Zoom), `←`/`→` (Pan), `F` (Fit All), `T` (Jump to Trigger), `C` (Toggle Cursors).

## Arduino IDE Firmware Build Settings

Open [HotWire_XIAO_ESP32.ino](./firmware/HotWire_XIAO_ESP32/HotWire_XIAO_ESP32.ino) in Arduino IDE (or `arduino-cli`) with Espressif ESP32 Core (`v2.0.14+` or `v3.x`):

* **XIAO ESP32-S3:** Board `XIAO_ESP32S3` (`esp32:esp32:XIAO_ESP32S3`), `USB CDC On Boot: Enabled`, `CPU Frequency: 240MHz (WiFi)`
* **XIAO ESP32-C6:** Board `XIAO_ESP32C6` (`esp32:esp32:XIAO_ESP32C6`), `USB CDC On Boot: Enabled`, `CPU Frequency: 160MHz (WiFi)`

## HotWire Ecosystem

* **[`hotwire-core`](https://github.com/hotwire-lab/hotwire-core)** — Shared Rust/WASM hardware transport, framing, firmware verification, Web Flasher & UI shell
* **[HotWire Logic Analyzer](https://github.com/hotwire-lab/logic)** ([Live App](https://hotwire-lab.github.io/logic/)) — 8-Channel Logic Analyzer & Tri-State Force I/O with UART/SPI/I²C decoders
* **[HotWire Oscilloscope](https://github.com/hotwire-lab/scope)** ([Live App](https://hotwire-lab.github.io/scope/)) — 4-Channel 12-bit GDMA ADC Oscilloscope & FFT Spectrum Analyzer
* **[HotWire SDR](https://github.com/hotwire-lab/sdr)** ([Live App](https://hotwire-lab.github.io/sdr/)) — 1.84–2.79 GHz RF Spectrum Analyzer, Wideband Scanner & Waterfall for XIAO ESP32-S3 & XIAO ESP32-C6
* **[HotWire Serial Terminal](https://github.com/hotwire-lab/serial)** ([Live App](https://hotwire-lab.github.io/serial/)) — Cross-platform Web Serial & WebUSB terminal for desktop and Android

## Development

Built with **Rust + WebAssembly** ([Leptos](https://leptos.dev/) CSR + [Trunk](https://trunkrs.dev/) + `hotwire-core`).

```bash
rustup target add wasm32-unknown-unknown
cargo clippy --all-targets -- -D warnings
cargo test
trunk serve          # local dev server (http://127.0.0.1:8081)
trunk build --release
```

## License

Copyright © 2026 Kari Vierimaa, Kempele — Licensed under the [Apache License 2.0](LICENSE).
