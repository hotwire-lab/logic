use hotwire_core::protocol::{BoardIdentity, ToolId};
use hotwire_core::ui::HotWireToolbar;
use leptos::prelude::*;

use crate::protocol::decoders::{DecoderConfig, DecoderKind};
use crate::protocol::time_format::{format_duration, format_resolution};
use crate::protocol::types::{PreTriggerRatio, TriggerEdge, CHANNELS, DEPTH_PRESETS, RATE_PRESETS};
use crate::transport::serial::TransportSnapshot;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaptureConfig {
    pub rate_id: u8,
    pub blocks_kb: u8,
    pub trigger_channel: Option<u8>,
    pub edge: TriggerEdge,
    pub pre_trigger: PreTriggerRatio,
}

impl Default for CaptureConfig {
    fn default() -> Self {
        Self {
            rate_id: 6,    // 1 MHz
            blocks_kb: 16, // 16k samples
            trigger_channel: None,
            edge: 1,        // Rising
            pre_trigger: 1, // 25%
        }
    }
}

const UART_BAUD_PRESETS: [u32; 9] = [
    9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1_000_000,
];

#[component]
pub fn TopToolbar(
    transport: RwSignal<TransportSnapshot>,
    identity: RwSignal<Option<BoardIdentity>>,
    capture_config: RwSignal<CaptureConfig>,
    capturing: RwSignal<bool>,
    continuous: RwSignal<bool>,
    has_active_outputs: Signal<bool>,
    decoder_config: RwSignal<DecoderConfig>,
    has_capture: Signal<bool>,
    channel_labels: RwSignal<[String; 8]>,
    drawer_open: RwSignal<bool>,
    on_toggle_drawer: Callback<()>,
    on_connect: Callback<()>,
    on_start_demo: Callback<()>,
    on_disconnect: Callback<()>,
    on_capture: Callback<()>,
    on_abort: Callback<()>,
    on_toggle_continuous: Callback<()>,
    on_release_all: Callback<()>,
    on_decoder_change: Callback<DecoderConfig>,
    on_export_csv: Callback<()>,
    on_export_vcd: Callback<()>,
) -> impl IntoView {
    let is_connected = move || transport.get().status.is_active();
    let is_capture_running = move || capturing.get() || continuous.get();
    let controls_locked = move || capturing.get() && !continuous.get();
    let controls_open = RwSignal::new(false);

    // Notify WaveformCanvas to redraw whenever the mobile controls bar toggles
    Effect::new(move |_| {
        let _ = controls_open.get();
        if let Some(w) = web_sys::window() {
            if let Ok(ev) = web_sys::Event::new("resize") {
                let _ = w.dispatch_event(&ev);
            }
        }
    });

    let window_badge = move || {
        let cfg = capture_config.get();
        let rate = RATE_PRESETS
            .get(cfg.rate_id as usize)
            .copied()
            .unwrap_or(RATE_PRESETS[6]);
        let samples = (cfg.blocks_kb as f64) * 1024.0;
        let window_sec = samples / (rate.hz as f64);
        format!(
            "Window: {} | Res: {}",
            format_duration(window_sec),
            format_resolution(rate.hz)
        )
    };

    view! {
        <HotWireToolbar
            active_tool=ToolId::LogicAnalyzer
            subtitle="8-Ch · 20 MHz · Rust/WASM"
            transport=transport
            identity=identity
            on_connect=on_connect
            on_disconnect=on_disconnect
            on_start_demo=on_start_demo
            flasher_open=drawer_open
            on_toggle_flasher=on_toggle_drawer
            app_version=env!("CARGO_PKG_VERSION")
        >
            <button
                type="button"
                class="btn btn-danger release-all-btn hw-desktop-only"
                disabled=move || !is_connected() || !has_active_outputs.get()
                on:click=move |_| on_release_all.run(())
                title="Release all 8 channels (D0–D7) to High-Z Input (Z) and clear contention flags"
            >
                "Release All (Z)"
            </button>

            <Show
                when=move || !is_capture_running()
                fallback=move || {
                    view! {
                        <button
                            type="button"
                            class="btn btn-danger hw-mobile-only mobile-capture-btn"
                            on:click=move |_| on_abort.run(())
                            title="Abort ongoing capture and retrieve partial buffer (Space)"
                        >
                            "Abort"
                        </button>
                    }
                }
            >
                <button
                    type="button"
                    class="btn btn-accent hw-mobile-only mobile-capture-btn"
                    disabled=move || !is_connected()
                    on:click=move |_| on_capture.run(())
                    title="Start single capture (Space)"
                >
                    "Capture"
                </button>
            </Show>

            <button
                type="button"
                class=move || {
                    if controls_open.get() {
                        "btn btn-secondary hw-mobile-only mobile-controls-btn active"
                    } else {
                        "btn btn-secondary hw-mobile-only mobile-controls-btn"
                    }
                }
                aria-label="Toggle capture controls"
                aria-expanded=move || if controls_open.get() { "true" } else { "false" }
                on:click=move |_| controls_open.update(|v| *v = !*v)
                title="Toggle capture, trigger & decoder controls"
            >
                "⚙"
            </button>
        </HotWireToolbar>

        <header class=move || {
            if controls_open.get() {
                "top-toolbar mobile-open"
            } else {
                "top-toolbar"
            }
        }>
            <div class="toolbar-row toolbar-capture">
                <div class="capture-control-group">
                    <label class="ctrl-field">
                        <span class="ctrl-label">"Rate"</span>
                        <select
                            aria-label="Sample rate"
                            class="ctrl-select"
                            prop:value=move || capture_config.get().rate_id.to_string()
                            disabled=controls_locked
                            on:change=move |ev| {
                                if let Ok(v) = event_target_value(&ev).parse::<u8>() {
                                    capture_config.update(|c| c.rate_id = v);
                                }
                            }
                        >
                            {RATE_PRESETS
                                .iter()
                                .map(|p| view! { <option value=p.id.to_string()>{p.label}</option> })
                                .collect_view()}
                        </select>
                    </label>

                    <label class="ctrl-field">
                        <span class="ctrl-label">"Depth"</span>
                        <select
                            aria-label="Sample depth"
                            class="ctrl-select"
                            prop:value=move || capture_config.get().blocks_kb.to_string()
                            disabled=controls_locked
                            on:change=move |ev| {
                                if let Ok(v) = event_target_value(&ev).parse::<u8>() {
                                    capture_config.update(|c| c.blocks_kb = v);
                                }
                            }
                        >
                            {DEPTH_PRESETS
                                .iter()
                                .map(|d| {
                                    view! {
                                        <option value=d.blocks_kb.to_string()>{d.label}</option>
                                    }
                                })
                                .collect_view()}
                        </select>
                    </label>

                    <span
                        class="window-badge"
                        title="Calculated capture duration and sample resolution"
                    >
                        {window_badge}
                    </span>
                </div>

                <div class="capture-control-group">
                    <label class="ctrl-field">
                        <span class="ctrl-label">"Trig"</span>
                        <select
                            aria-label="Trigger channel"
                            class="ctrl-select"
                            prop:value=move || {
                                match capture_config.get().trigger_channel {
                                    None => "free".to_string(),
                                    Some(ch) => ch.to_string(),
                                }
                            }
                            disabled=controls_locked
                            on:change=move |ev| {
                                let v = event_target_value(&ev);
                                let next = if v == "free" { None } else { v.parse::<u8>().ok() };
                                capture_config.update(|c| c.trigger_channel = next);
                            }
                        >
                            <option value="free">"Free Run"</option>
                            {CHANNELS
                                .iter()
                                .map(|c| {
                                    let ch = c.ch;
                                    let base = c.label;
                                    view! {
                                        <option value=ch.to_string()>
                                            {move || {
                                                let labels = channel_labels.get();
                                                let alias = labels[ch].trim();
                                                if alias.is_empty() {
                                                    base.to_string()
                                                } else {
                                                    format!("{base} ({alias})")
                                                }
                                            }}
                                        </option>
                                    }
                                })
                                .collect_view()}
                        </select>
                    </label>

                    <Show when=move || capture_config.get().trigger_channel.is_some()>
                        <div class="seg-group" role="group" aria-label="Trigger edge">
                            {[
                                (1u8, "↑", "Rising edge"),
                                (0u8, "↓", "Falling edge"),
                                (2u8, "↕", "Any edge"),
                            ]
                            .into_iter()
                            .map(|(val, label, title)| {
                                view! {
                                    <button
                                        type="button"
                                        title=title
                                        disabled=controls_locked
                                        class=move || {
                                            if capture_config.get().edge == val {
                                                "seg-btn active"
                                            } else {
                                                "seg-btn"
                                            }
                                        }
                                        on:click=move |_| capture_config.update(|c| c.edge = val)
                                    >
                                        {label}
                                    </button>
                                }
                            })
                            .collect_view()}
                        </div>

                        <div class="seg-group" role="group" aria-label="Pre-trigger ratio">
                            {[(0u8, "0%"), (1u8, "25%"), (2u8, "50%"), (3u8, "75%")]
                                .into_iter()
                                .map(|(val, label)| {
                                    view! {
                                        <button
                                            type="button"
                                            title=format!("Pre-trigger buffer {label}")
                                            disabled=controls_locked
                                            class=move || {
                                                if capture_config.get().pre_trigger == val {
                                                    "seg-btn active"
                                                } else {
                                                    "seg-btn"
                                                }
                                            }
                                            on:click=move |_| capture_config.update(|c| c.pre_trigger = val)
                                        >
                                            {label}
                                        </button>
                                    }
                                })
                                .collect_view()}
                        </div>
                    </Show>
                </div>

                <div class="capture-control-group">
                    <label class="ctrl-field">
                        <span class="ctrl-label">"Decode"</span>
                        <select
                            aria-label="Protocol decoder"
                            class="ctrl-select"
                            prop:value=move || decoder_config.get().kind.as_str()
                            on:change=move |ev| {
                                let mut next = decoder_config.get_untracked();
                                next.kind = DecoderKind::from_str(&event_target_value(&ev));
                                on_decoder_change.run(next);
                            }
                        >
                            <option value="none">"None"</option>
                            <option value="uart">"UART"</option>
                            <option value="spi">"SPI"</option>
                            <option value="i2c">"I2C"</option>
                        </select>
                    </label>

                    <Show when=move || decoder_config.get().kind == DecoderKind::Uart>
                        <div class="decoder-subcontrols">
                            <select
                                aria-label="UART RX channel"
                                class="ctrl-select ctrl-select-sm"
                                prop:value=move || decoder_config.get().uart.rx_ch.to_string()
                                on:change=move |ev| {
                                    if let Ok(ch) = event_target_value(&ev).parse::<usize>() {
                                        let mut next = decoder_config.get_untracked();
                                        next.uart.rx_ch = ch;
                                        on_decoder_change.run(next);
                                    }
                                }
                            >
                                {CHANNELS
                                    .iter()
                                    .map(|c| {
                                        view! {
                                            <option value=c.ch.to_string()>{format!("RX:{}", c.label)}</option>
                                        }
                                    })
                                    .collect_view()}
                            </select>

                            <select
                                aria-label="UART baud rate"
                                class="ctrl-select ctrl-select-sm"
                                prop:value=move || decoder_config.get().uart.baud.to_string()
                                on:change=move |ev| {
                                    if let Ok(b) = event_target_value(&ev).parse::<u32>() {
                                        let mut next = decoder_config.get_untracked();
                                        next.uart.baud = b;
                                        on_decoder_change.run(next);
                                    }
                                }
                            >
                                {UART_BAUD_PRESETS
                                    .iter()
                                    .map(|&b| {
                                        let text = if b >= 1_000_000 {
                                            "1M".to_string()
                                        } else {
                                            b.to_string()
                                        };
                                        view! { <option value=b.to_string()>{text}</option> }
                                    })
                                    .collect_view()}
                            </select>

                            <button
                                type="button"
                                class=move || {
                                    if decoder_config.get().uart.invert {
                                        "btn btn-secondary btn-compact active"
                                    } else {
                                        "btn btn-secondary btn-compact"
                                    }
                                }
                                title="Invert UART idle/polarity"
                                on:click=move |_| {
                                    let mut next = decoder_config.get_untracked();
                                    next.uart.invert = !next.uart.invert;
                                    on_decoder_change.run(next);
                                }
                            >
                                "Inv"
                            </button>
                        </div>
                    </Show>

                    <Show when=move || decoder_config.get().kind == DecoderKind::Spi>
                        <div class="decoder-subcontrols">
                            <select
                                aria-label="SPI CLK"
                                class="ctrl-select ctrl-select-sm"
                                prop:value=move || decoder_config.get().spi.clk_ch.to_string()
                                on:change=move |ev| {
                                    if let Ok(ch) = event_target_value(&ev).parse::<usize>() {
                                        let mut next = decoder_config.get_untracked();
                                        next.spi.clk_ch = ch;
                                        on_decoder_change.run(next);
                                    }
                                }
                            >
                                {CHANNELS
                                    .iter()
                                    .map(|c| {
                                        view! {
                                            <option value=c.ch.to_string()>{format!("CLK:{}", c.label)}</option>
                                        }
                                    })
                                    .collect_view()}
                            </select>

                            <select
                                aria-label="SPI MOSI"
                                class="ctrl-select ctrl-select-sm"
                                prop:value=move || decoder_config.get().spi.mosi_ch.to_string()
                                on:change=move |ev| {
                                    if let Ok(ch) = event_target_value(&ev).parse::<usize>() {
                                        let mut next = decoder_config.get_untracked();
                                        next.spi.mosi_ch = ch;
                                        on_decoder_change.run(next);
                                    }
                                }
                            >
                                {CHANNELS
                                    .iter()
                                    .map(|c| {
                                        view! {
                                            <option value=c.ch.to_string()>{format!("MOSI:{}", c.label)}</option>
                                        }
                                    })
                                    .collect_view()}
                            </select>

                            <select
                                aria-label="SPI MISO"
                                class="ctrl-select ctrl-select-sm"
                                prop:value=move || {
                                    match decoder_config.get().spi.miso_ch {
                                        None => "none".to_string(),
                                        Some(ch) => ch.to_string(),
                                    }
                                }
                                on:change=move |ev| {
                                    let v = event_target_value(&ev);
                                    let mut next = decoder_config.get_untracked();
                                    next.spi.miso_ch = if v == "none" { None } else { v.parse::<usize>().ok() };
                                    on_decoder_change.run(next);
                                }
                            >
                                <option value="none">"MISO:-"</option>
                                {CHANNELS
                                    .iter()
                                    .map(|c| {
                                        view! {
                                            <option value=c.ch.to_string()>{format!("MISO:{}", c.label)}</option>
                                        }
                                    })
                                    .collect_view()}
                            </select>

                            <select
                                aria-label="SPI CS"
                                class="ctrl-select ctrl-select-sm"
                                prop:value=move || {
                                    match decoder_config.get().spi.cs_ch {
                                        None => "none".to_string(),
                                        Some(ch) => ch.to_string(),
                                    }
                                }
                                on:change=move |ev| {
                                    let v = event_target_value(&ev);
                                    let mut next = decoder_config.get_untracked();
                                    next.spi.cs_ch = if v == "none" { None } else { v.parse::<usize>().ok() };
                                    on_decoder_change.run(next);
                                }
                            >
                                <option value="none">"CS:-"</option>
                                {CHANNELS
                                    .iter()
                                    .map(|c| {
                                        view! {
                                            <option value=c.ch.to_string()>{format!("CS:{}", c.label)}</option>
                                        }
                                    })
                                    .collect_view()}
                            </select>

                            <select
                                aria-label="SPI Mode"
                                class="ctrl-select ctrl-select-sm"
                                prop:value=move || {
                                    let spi = decoder_config.get().spi;
                                    ((spi.cpol << 1) | spi.cpha).to_string()
                                }
                                on:change=move |ev| {
                                    if let Ok(m) = event_target_value(&ev).parse::<u8>() {
                                        let mut next = decoder_config.get_untracked();
                                        next.spi.cpol = (m >> 1) & 1;
                                        next.spi.cpha = m & 1;
                                        on_decoder_change.run(next);
                                    }
                                }
                            >
                                <option value="0">"M0"</option>
                                <option value="1">"M1"</option>
                                <option value="2">"M2"</option>
                                <option value="3">"M3"</option>
                            </select>
                        </div>
                    </Show>

                    <Show when=move || decoder_config.get().kind == DecoderKind::I2c>
                        <div class="decoder-subcontrols">
                            <select
                                aria-label="I2C SCL"
                                class="ctrl-select ctrl-select-sm"
                                prop:value=move || decoder_config.get().i2c.scl_ch.to_string()
                                on:change=move |ev| {
                                    if let Ok(ch) = event_target_value(&ev).parse::<usize>() {
                                        let mut next = decoder_config.get_untracked();
                                        next.i2c.scl_ch = ch;
                                        on_decoder_change.run(next);
                                    }
                                }
                            >
                                {CHANNELS
                                    .iter()
                                    .map(|c| {
                                        view! {
                                            <option value=c.ch.to_string()>{format!("SCL:{}", c.label)}</option>
                                        }
                                    })
                                    .collect_view()}
                            </select>

                            <select
                                aria-label="I2C SDA"
                                class="ctrl-select ctrl-select-sm"
                                prop:value=move || decoder_config.get().i2c.sda_ch.to_string()
                                on:change=move |ev| {
                                    if let Ok(ch) = event_target_value(&ev).parse::<usize>() {
                                        let mut next = decoder_config.get_untracked();
                                        next.i2c.sda_ch = ch;
                                        on_decoder_change.run(next);
                                    }
                                }
                            >
                                {CHANNELS
                                    .iter()
                                    .map(|c| {
                                        view! {
                                            <option value=c.ch.to_string()>{format!("SDA:{}", c.label)}</option>
                                        }
                                    })
                                    .collect_view()}
                            </select>
                        </div>
                    </Show>
                </div>

                <div class="capture-action-group">
                    <Show
                        when=move || !is_capture_running()
                        fallback=move || {
                            view! {
                                <button
                                    type="button"
                                    class="btn btn-danger capture-primary-btn"
                                    on:click=move |_| on_abort.run(())
                                    title="Abort ongoing capture and retrieve partial buffer (Space)"
                                >
                                    "Abort"
                                </button>
                            }
                        }
                    >
                        <button
                            type="button"
                            class="btn btn-accent capture-primary-btn"
                            disabled=move || !is_connected()
                            on:click=move |_| on_capture.run(())
                            title="Start single capture (Space)"
                        >
                            "Capture"
                        </button>
                    </Show>

                    <button
                        type="button"
                        class=move || {
                            if continuous.get() { "btn btn-toggle active" } else { "btn btn-toggle" }
                        }
                        disabled=move || !is_connected()
                        on:click=move |_| on_toggle_continuous.run(())
                        title="Continuous capture loop"
                    >
                        "Continuous"
                    </button>

                    <button
                        type="button"
                        class="btn btn-danger hw-mobile-only"
                        disabled=move || !is_connected() || !has_active_outputs.get()
                        on:click=move |_| on_release_all.run(())
                        title="Release all 8 channels (D0–D7) to High-Z Input (Z) and clear contention flags"
                    >
                        "Release All (Z)"
                    </button>

                    <Show when=move || has_capture.get()>
                        <button
                            type="button"
                            class="btn btn-secondary btn-compact"
                            on:click=move |_| on_export_csv.run(())
                            title="Export captured waveform samples as CSV"
                        >
                            "CSV"
                        </button>
                        <button
                            type="button"
                            class="btn btn-secondary btn-compact"
                            on:click=move |_| on_export_vcd.run(())
                            title="Export captured waveform samples as IEEE-1364 VCD (GTKWave / PulseView)"
                        >
                            "VCD"
                        </button>
                    </Show>
                </div>
            </div>
        </header>
    }
}
