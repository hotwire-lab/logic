use std::collections::HashMap;

use leptos::prelude::*;
use wasm_bindgen::JsCast;

use crate::protocol::types::{
    BoardCapabilities, PinForceMode, PinPullMode, StatusTelemetry, CHANNELS,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChannelUiState {
    pub mode: PinForceMode,
    pub pull: PinPullMode,
    pub protect: bool,
}

impl Default for ChannelUiState {
    fn default() -> Self {
        Self {
            mode: 0,
            pull: 0,
            protect: true,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ForceChannelRequest {
    pub ch: usize,
    pub mode: PinForceMode,
    pub pull: PinPullMode,
    pub protect: bool,
}

#[component]
pub fn ChannelStrip(
    connected: Signal<bool>,
    telemetry: RwSignal<StatusTelemetry>,
    channel_configs: RwSignal<[ChannelUiState; 8]>,
    channel_labels: RwSignal<[String; 8]>,
    board_caps: RwSignal<Option<BoardCapabilities>>,
    on_force_channel: Callback<ForceChannelRequest>,
    on_rename_channel: Callback<(usize, String)>,
) -> impl IntoView {
    let pulse_restore = StoredValue::new(HashMap::<usize, (PinForceMode, PinPullMode)>::new());
    let editing_ch = RwSignal::new(None::<usize>);
    let draft_alias = RwSignal::new(String::new());

    let commit_alias = move |ch: usize| {
        editing_ch.set(None);
        on_rename_channel.run((ch, draft_alias.get_untracked().trim().to_string()));
    };

    view! {
        <aside class="channel-strip" aria-label="8-channel tri-state force controls">
            <div class="channel-strip-header">
                <span>"CH / GPIO"</span>
                <span>"LIVE"</span>
                <span>"FORCE"</span>
                <span>"PULSE"</span>
                <span>"PULL"</span>
            </div>

            <div class="channel-rows">
                {CHANNELS
                    .iter()
                    .map(|meta| {
                        let ch = meta.ch;
                        let bit = 1u8 << ch;
                        let base_label = meta.label;
                        let default_gpio = meta.gpio;
                        let color = meta.color;

                        let resolved_gpio = move || {
                            board_caps
                                .get()
                                .and_then(|caps| {
                                    caps.pins.iter().find(|p| p.ch == ch).map(|p| p.gpio)
                                })
                                .unwrap_or(default_gpio)
                        };

                        let effective_mode = move || {
                            let tel = telemetry.get();
                            let cfg = channel_configs.get()[ch];
                            let force_active = (tel.force_enable_mask & bit) != 0;
                            let forced_high = (tel.forced_levels & bit) != 0;
                            if force_active {
                                if forced_high { 2 } else { 1 }
                            } else {
                                cfg.mode
                            }
                        };

                        let has_contention = move || (telemetry.get().contention_mask & bit) != 0;
                        let phys_high = move || (telemetry.get().physical_levels & bit) != 0;

                        let end_pulse = move || {
                            let mut prior = None;
                            pulse_restore.update_value(|m| {
                                prior = m.remove(&ch);
                            });
                            if let Some((pmode, ppull)) = prior {
                                if !has_contention() {
                                    let cfg = channel_configs.get_untracked()[ch];
                                    on_force_channel.run(ForceChannelRequest {
                                        ch,
                                        mode: pmode,
                                        pull: ppull,
                                        protect: cfg.protect,
                                    });
                                }
                            }
                        };

                        view! {
                            <div class=move || {
                                if has_contention() {
                                    "channel-row channel-row-short"
                                } else {
                                    "channel-row"
                                }
                            }>
                                <div class="ch-id-cell">
                                    <span
                                        class="ch-color-bar"
                                        style=format!("background-color: {color}")
                                    />
                                    <div class="ch-labels">
                                        <Show
                                            when=move || editing_ch.get() == Some(ch)
                                            fallback=move || {
                                                view! {
                                                    <button
                                                        type="button"
                                                        class="ch-name-btn"
                                                        title="Click to rename channel alias"
                                                        on:click=move |_| {
                                                            let cur = channel_labels.get_untracked()[ch].clone();
                                                            draft_alias.set(cur);
                                                            editing_ch.set(Some(ch));
                                                        }
                                                    >
                                                        {move || {
                                                            let labels = channel_labels.get();
                                                            let trimmed = labels[ch].trim();
                                                            if trimmed.is_empty() {
                                                                base_label.to_string()
                                                            } else {
                                                                trimmed.to_string()
                                                            }
                                                        }}
                                                    </button>
                                                }
                                            }
                                        >
                                            <input
                                                type="text"
                                                class="ch-alias-input"
                                                maxlength="14"
                                                autofocus=true
                                                prop:value=move || draft_alias.get()
                                                placeholder=base_label
                                                on:input=move |ev| draft_alias.set(event_target_value(&ev))
                                                on:blur=move |_| commit_alias(ch)
                                                on:keydown=move |ev: web_sys::KeyboardEvent| {
                                                    let key = ev.key();
                                                    if key == "Enter" {
                                                        commit_alias(ch);
                                                    } else if key == "Escape" {
                                                        editing_ch.set(None);
                                                    }
                                                }
                                            />
                                        </Show>

                                        <span class="ch-gpio">
                                            {move || {
                                                let gpio = resolved_gpio();
                                                let labels = channel_labels.get();
                                                if labels[ch].trim().is_empty() {
                                                    format!("GPIO {gpio}")
                                                } else {
                                                    format!("{base_label} · GPIO {gpio}")
                                                }
                                            }}
                                        </span>
                                    </div>
                                </div>

                                <div class="ch-live-cell">
                                    <Show
                                        when=has_contention
                                        fallback=move || {
                                            view! {
                                                <span
                                                    class=move || {
                                                        if phys_high() {
                                                            "live-badge live-high"
                                                        } else {
                                                            "live-badge live-low"
                                                        }
                                                    }
                                                    title=move || {
                                                        if phys_high() {
                                                            "Physical level: HIGH (3.3V)"
                                                        } else {
                                                            "Physical level: LOW (0V)"
                                                        }
                                                    }
                                                >
                                                    {move || if phys_high() { "1" } else { "0" }}
                                                </span>
                                            }
                                        }
                                    >
                                        <span
                                            class="live-badge live-short"
                                            title="Bus conflict / short circuit >20ms"
                                        >
                                            "SHORT!"
                                        </span>
                                    </Show>
                                </div>

                                <div class="ch-force-cell">
                                    <div
                                        class="seg-group"
                                        role="group"
                                        aria-label=format!("{base_label} tri-state mode")
                                    >
                                        <button
                                            type="button"
                                            disabled=move || !connected.get()
                                            class=move || {
                                                if effective_mode() == 0 {
                                                    "seg-btn active active-z"
                                                } else {
                                                    "seg-btn"
                                                }
                                            }
                                            on:click=move |_| {
                                                let cfg = channel_configs.get_untracked()[ch];
                                                on_force_channel.run(ForceChannelRequest {
                                                    ch,
                                                    mode: 0,
                                                    pull: cfg.pull,
                                                    protect: cfg.protect,
                                                });
                                            }
                                            title=format!("Release {base_label} to High-Z Input")
                                        >
                                            "Z"
                                        </button>
                                        <button
                                            type="button"
                                            disabled=move || !connected.get()
                                            class=move || {
                                                if effective_mode() == 1 {
                                                    "seg-btn active active-low"
                                                } else {
                                                    "seg-btn"
                                                }
                                            }
                                            on:click=move |_| {
                                                let cfg = channel_configs.get_untracked()[ch];
                                                on_force_channel.run(ForceChannelRequest {
                                                    ch,
                                                    mode: 1,
                                                    pull: cfg.pull,
                                                    protect: cfg.protect,
                                                });
                                            }
                                            title=format!("Force {base_label} LOW (0V)")
                                        >
                                            "0"
                                        </button>
                                        <button
                                            type="button"
                                            disabled=move || !connected.get()
                                            class=move || {
                                                if effective_mode() == 2 {
                                                    "seg-btn active active-high"
                                                } else {
                                                    "seg-btn"
                                                }
                                            }
                                            on:click=move |_| {
                                                let cfg = channel_configs.get_untracked()[ch];
                                                on_force_channel.run(ForceChannelRequest {
                                                    ch,
                                                    mode: 2,
                                                    pull: cfg.pull,
                                                    protect: cfg.protect,
                                                });
                                            }
                                            title=format!("Force {base_label} HIGH (3.3V)")
                                        >
                                            "1"
                                        </button>
                                    </div>
                                </div>

                                <div class="ch-pulse-cell">
                                    <button
                                        type="button"
                                        disabled=move || !connected.get()
                                        class="btn-pulse"
                                        on:pointerdown=move |ev: web_sys::PointerEvent| {
                                            if !connected.get_untracked() {
                                                return;
                                            }
                                            ev.prevent_default();
                                            if let Some(el) = ev
                                                .current_target()
                                                .and_then(|t| t.dyn_into::<web_sys::Element>().ok())
                                            {
                                                let _ = el.set_pointer_capture(ev.pointer_id());
                                            }
                                            let cfg = channel_configs.get_untracked()[ch];
                                            pulse_restore.update_value(|m| {
                                                m.entry(ch).or_insert((cfg.mode, cfg.pull));
                                            });
                                            let target_mode = if phys_high() { 1 } else { 2 };
                                            on_force_channel.run(ForceChannelRequest {
                                                ch,
                                                mode: target_mode,
                                                pull: cfg.pull,
                                                protect: cfg.protect,
                                            });
                                        }
                                        on:pointerup=move |_| end_pulse()
                                        on:pointercancel=move |_| end_pulse()
                                        on:lostpointercapture=move |_| end_pulse()
                                        title=move || {
                                            format!(
                                                "Hold to pulse {base_label} to {}, release to restore",
                                                if phys_high() { "0" } else { "1" }
                                            )
                                        }
                                    >
                                        "⚡"
                                    </button>
                                </div>

                                <div class="ch-pull-cell">
                                    <button
                                        type="button"
                                        disabled=move || !connected.get() || effective_mode() != 0
                                        class=move || {
                                            let cfg = channel_configs.get()[ch];
                                            if cfg.pull != 0 && effective_mode() == 0 {
                                                "btn-pull active"
                                            } else {
                                                "btn-pull"
                                            }
                                        }
                                        on:click=move |_| {
                                            let cfg = channel_configs.get_untracked()[ch];
                                            on_force_channel.run(ForceChannelRequest {
                                                ch,
                                                mode: 0,
                                                pull: (cfg.pull + 1) % 3,
                                                protect: cfg.protect,
                                            });
                                        }
                                        title=move || match channel_configs.get()[ch].pull {
                                            1 => "Internal Pull-Up (~45 kΩ) — click to switch to Pull-Down",
                                            2 => "Internal Pull-Down (~45 kΩ) — click to release floating (-)",
                                            _ => "Floating (No pull) — click to cycle PU / PD",
                                        }
                                    >
                                        {move || match channel_configs.get()[ch].pull {
                                            1 => "PU",
                                            2 => "PD",
                                            _ => "-",
                                        }}
                                    </button>
                                </div>
                            </div>
                        }
                    })
                    .collect_view()}
            </div>
        </aside>
    }
}
