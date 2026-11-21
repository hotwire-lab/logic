use hotwire_core::protocol::BoardIdentity;
use hotwire_core::ui::HotWireTheme;
use leptos::prelude::*;
use wasm_bindgen::closure::Closure;
use wasm_bindgen::JsCast;

use crate::components::bottom_drawer::BottomDrawer;
use crate::components::channel_strip::{ChannelStrip, ChannelUiState, ForceChannelRequest};
use crate::components::top_toolbar::{CaptureConfig, TopToolbar};
use crate::components::waveform_canvas::{WaveformCanvas, WaveformCommand};
use crate::protocol::codec::{
    build_la_abort_cmd, build_la_capture_cmd, build_pin_force_cmd, build_release_all_cmd,
};
use crate::protocol::decoders::{
    decode_protocol, export_capture_to_csv, export_capture_to_vcd, DecodedFrameAnnotation,
    DecoderConfig, DecoderKind,
};
use crate::protocol::demuxer::ProtocolDemuxer;
use crate::protocol::time_format::format_signed_duration;
use crate::protocol::types::{
    BoardCapabilities, CaptureDataFrame, DecodedPacket, StatusTelemetry, RATE_PRESETS,
};
use crate::transport::serial::{create_logic_transport, TransportSnapshot};

const CHANNEL_LABELS_STORAGE_KEY: &str = "hotwire.channelLabels.v1";

fn load_channel_labels() -> [String; 8] {
    let empty: [String; 8] = Default::default();
    let Some(storage) = web_sys::window().and_then(|w| w.local_storage().ok().flatten()) else {
        return empty;
    };
    let Ok(Some(raw)) = storage.get_item(CHANNEL_LABELS_STORAGE_KEY) else {
        return empty;
    };
    if let Ok(parsed) = serde_json::from_str::<Vec<String>>(&raw) {
        if parsed.len() == 8 {
            let mut out: [String; 8] = Default::default();
            for (i, s) in parsed.into_iter().enumerate() {
                out[i] = s.chars().take(14).collect();
            }
            return out;
        }
    }
    empty
}

fn save_channel_labels(labels: &[String; 8]) {
    if let Some(storage) = web_sys::window().and_then(|w| w.local_storage().ok().flatten()) {
        if let Ok(json) = serde_json::to_string(labels) {
            let _ = storage.set_item(CHANNEL_LABELS_STORAGE_KEY, &json);
        }
    }
}

fn download_text_file(filename: &str, content: &str, mime_type: &str) {
    let Some(win) = web_sys::window() else { return };
    let Some(doc) = win.document() else { return };
    let arr = js_sys::Array::new();
    arr.push(&content.into());
    let bag = web_sys::BlobPropertyBag::new();
    bag.set_type(mime_type);
    let Ok(blob) = web_sys::Blob::new_with_str_sequence_and_options(&arr, &bag) else {
        return;
    };
    let Ok(url) = web_sys::Url::create_object_url_with_blob(&blob) else {
        return;
    };
    if let Ok(el) = doc.create_element("a") {
        if let Ok(link) = el.dyn_into::<web_sys::HtmlAnchorElement>() {
            link.set_href(&url);
            link.set_download(filename);
            if let Some(body) = doc.body() {
                let _ = body.append_child(&link);
                link.click();
                link.remove();
            }
        }
    }
    let url_clone = url.clone();
    let cb = Closure::once(move || {
        let _ = web_sys::Url::revoke_object_url(&url_clone);
    });
    let _ = win.set_timeout_with_callback_and_timeout_and_arguments_0(
        cb.as_ref().unchecked_ref(),
        1000,
    );
    cb.forget();
}

#[component]
pub fn App() -> impl IntoView {
    let serial_transport = StoredValue::new_local(create_logic_transport());

    let transport = RwSignal::new(serial_transport.with_value(|t| t.snapshot()));
    let identity = RwSignal::new(None::<BoardIdentity>);
    let board_caps = RwSignal::new(None::<BoardCapabilities>);
    let drawer_open = RwSignal::new(false);
    let telemetry = RwSignal::new(StatusTelemetry::default());
    let channel_configs = RwSignal::new([ChannelUiState::default(); 8]);
    let channel_labels = RwSignal::new(load_channel_labels());
    let decoder_config = RwSignal::new(DecoderConfig::default());
    let selected_frame_id = RwSignal::new(None::<u32>);
    let capture_config = RwSignal::new(CaptureConfig::default());
    let capture = RwSignal::new(None::<CaptureDataFrame>);
    let capturing = RwSignal::new(false);
    let continuous = RwSignal::new(false);

    let waveform_cmd = RwSignal::new(None::<(u64, WaveformCommand)>);
    let cmd_seq = StoredValue::new(0u64);
    let send_waveform_cmd = move |cmd: WaveformCommand| {
        let next = cmd_seq.get_value().wrapping_add(1);
        cmd_seq.set_value(next);
        waveform_cmd.set(Some((next, cmd)));
    };

    let demuxer = StoredValue::new_local(ProtocolDemuxer::new());
    let continuous_timer = StoredValue::new(None::<i32>);
    let capture_watchdog = StoredValue::new(None::<i32>);
    let abort_watchdog = StoredValue::new(None::<i32>);

    let clear_watchdogs = move || {
        if let Some(w) = web_sys::window() {
            if let Some(id) = capture_watchdog.get_value() {
                w.clear_timeout_with_handle(id);
                capture_watchdog.set_value(None);
            }
            if let Some(id) = abort_watchdog.get_value() {
                w.clear_timeout_with_handle(id);
                abort_watchdog.set_value(None);
            }
        }
    };

    let clear_continuous_timer = move || {
        if let Some(id) = continuous_timer.get_value() {
            if let Some(w) = web_sys::window() {
                w.clear_timeout_with_handle(id);
            }
            continuous_timer.set_value(None);
        }
    };

    let trigger_capture = move || {
        if !transport.get_untracked().status.is_active() {
            return;
        }
        let cfg = capture_config.get_untracked();
        capturing.set(true);

        if let Some(w) = web_sys::window() {
            if let Some(id) = capture_watchdog.get_value() {
                w.clear_timeout_with_handle(id);
            }
            let rate_hz = RATE_PRESETS
                .get(cfg.rate_id as usize)
                .map(|r| r.hz)
                .unwrap_or(1_000_000) as f64;
            let timeout_ms = (((cfg.blocks_kb as f64 * 1024.0) / rate_hz) * 1000.0).ceil() as i32 + 6500;
            let cb = Closure::once(move || {
                capture_watchdog.set_value(None);
                capturing.set(false);
            });
            if let Ok(id) = w.set_timeout_with_callback_and_timeout_and_arguments_0(
                cb.as_ref().unchecked_ref(),
                timeout_ms,
            ) {
                capture_watchdog.set_value(Some(id));
            }
            cb.forget();
        }

        let cmd = build_la_capture_cmd(
            cfg.rate_id,
            cfg.trigger_channel,
            cfg.edge,
            cfg.pre_trigger,
            cfg.blocks_kb,
        );
        serial_transport.with_value(|t| t.send_bytes(&cmd));
    };

    let abort_capture = move || {
        continuous.set(false);
        clear_continuous_timer();
        if capturing.get_untracked() {
            let cmd = build_la_abort_cmd();
            serial_transport.with_value(|t| t.send_bytes(&cmd));
            if let Some(w) = web_sys::window() {
                if let Some(id) = abort_watchdog.get_value() {
                    w.clear_timeout_with_handle(id);
                }
                let cb = Closure::once(move || {
                    abort_watchdog.set_value(None);
                    capturing.set(false);
                });
                if let Ok(id) = w.set_timeout_with_callback_and_timeout_and_arguments_0(
                    cb.as_ref().unchecked_ref(),
                    350,
                ) {
                    abort_watchdog.set_value(Some(id));
                }
                cb.forget();
            }
        }
    };

    // Initialize SerialTransport + ProtocolDemuxer
    serial_transport.with_value(|st| {
        st.init(
            move |snap: TransportSnapshot| {
                let disconnected = !snap.status.is_active();
                transport.set(snap);
                if disconnected {
                    demuxer.update_value(|d| d.reset());
                    identity.set(None);
                    board_caps.set(None);
                    capturing.set(false);
                    continuous.set(false);
                    clear_watchdogs();
                    clear_continuous_timer();
                }
            },
            move |bytes: &[u8]| {
                demuxer.update_value(|d| {
                    d.push(
                        bytes,
                        |packet| match packet {
                            DecodedPacket::StatusTelemetry(tel) => {
                                if telemetry.get_untracked() != tel {
                                    telemetry.set(tel);
                                }
                                channel_configs.update(|cfgs| {
                                    for (ch, cfg) in cfgs.iter_mut().enumerate() {
                                        let bit = 1u8 << ch;
                                        let is_forced = (tel.force_enable_mask & bit) != 0;
                                        let is_high = (tel.forced_levels & bit) != 0;
                                        let next_mode = if is_forced {
                                            if is_high { 2 } else { 1 }
                                        } else {
                                            0
                                        };
                                        cfg.mode = next_mode;
                                    }
                                });
                            }
                            DecodedPacket::BoardCapabilities(id, caps) => {
                                identity.set(Some(id));
                                board_caps.set(Some(caps));
                            }
                            DecodedPacket::LaCaptureData(cap) => {
                                clear_watchdogs();
                                capture.set(Some(cap));
                                selected_frame_id.set(None);
                                capturing.set(false);
                                if continuous.get_untracked()
                                    && transport.get_untracked().status.is_active()
                                {
                                    clear_continuous_timer();
                                    if let Some(w) = web_sys::window() {
                                        let cb = Closure::once(move || {
                                            continuous_timer.set_value(None);
                                            trigger_capture();
                                        });
                                        if let Ok(id) = w.set_timeout_with_callback_and_timeout_and_arguments_0(
                                            cb.as_ref().unchecked_ref(),
                                            80,
                                        ) {
                                            continuous_timer.set_value(Some(id));
                                        }
                                        cb.forget();
                                    }
                                }
                            }
                        },
                        |_| {},
                    );
                });
            },
        );
    });

    // Global keyboard shortcuts
    Effect::new(move |_| {
        let cb = Closure::<dyn FnMut(web_sys::KeyboardEvent)>::new(move |ev: web_sys::KeyboardEvent| {
            if let Some(target) = ev
                .target()
                .and_then(|t| t.dyn_into::<web_sys::HtmlElement>().ok())
            {
                let tag = target.tag_name();
                if matches!(tag.as_str(), "INPUT" | "SELECT" | "TEXTAREA")
                    || target.is_content_editable()
                {
                    return;
                }
            }

            let code = ev.code();
            let key = ev.key();
            if code == "Space" {
                if !transport.get_untracked().status.is_active() {
                    return;
                }
                ev.prevent_default();
                if capturing.get_untracked() || continuous.get_untracked() {
                    abort_capture();
                } else {
                    trigger_capture();
                }
            } else if key == "+" || key == "=" {
                ev.prevent_default();
                send_waveform_cmd(WaveformCommand::ZoomIn);
            } else if key == "-" || key == "_" {
                ev.prevent_default();
                send_waveform_cmd(WaveformCommand::ZoomOut);
            } else if key == "ArrowLeft" {
                ev.prevent_default();
                send_waveform_cmd(WaveformCommand::PanByFraction(-0.2));
            } else if key == "ArrowRight" {
                ev.prevent_default();
                send_waveform_cmd(WaveformCommand::PanByFraction(0.2));
            } else if key == "f" || key == "F" {
                send_waveform_cmd(WaveformCommand::FitAll);
            } else if key == "t" || key == "T" {
                send_waveform_cmd(WaveformCommand::JumpToTrigger);
            } else if key == "c" || key == "C" {
                send_waveform_cmd(WaveformCommand::ToggleCursors);
            }
        });

        if let Some(win) = web_sys::window() {
            let _ = win.add_event_listener_with_callback("keydown", cb.as_ref().unchecked_ref());
        }
        cb.forget();
    });

    let decoded_frames = Memo::new(move |_| {
        let cfg = decoder_config.get();
        if cfg.kind == DecoderKind::None {
            return Vec::new();
        }
        let Some(cap) = capture.get() else {
            return Vec::new();
        };
        decode_protocol(&cap.samples, cap.sample_rate_hz, cfg)
    });

    let connected = Signal::derive(move || transport.get().status.is_active());
    let has_active_outputs = Signal::derive(move || {
        let t = telemetry.get();
        t.force_enable_mask != 0 || t.contention_mask != 0
    });
    let has_capture = Signal::derive(move || capture.get().is_some());

    let on_connect = Callback::new(move |_| serial_transport.with_value(|t| t.connect_usb()));
    let on_start_demo = Callback::new(move |_| serial_transport.with_value(|t| t.start_demo()));
    let on_toggle_drawer = Callback::new(move |_| drawer_open.update(|v| *v = !*v));
    let on_close_drawer = Callback::new(move |_| drawer_open.set(false));
    let on_disconnect = Callback::new(move |_| {
        continuous.set(false);
        capturing.set(false);
        channel_configs.set([ChannelUiState::default(); 8]);
        telemetry.set(StatusTelemetry::default());
        serial_transport.with_value(|t| t.disconnect());
    });
    let on_release_all = Callback::new(move |_| {
        channel_configs.set([ChannelUiState::default(); 8]);
        let cmd = build_release_all_cmd();
        serial_transport.with_value(|t| t.send_bytes(&cmd));
    });
    let on_capture = Callback::new(move |_| trigger_capture());
    let on_abort = Callback::new(move |_| abort_capture());
    let on_toggle_continuous = Callback::new(move |_| {
        let next = !continuous.get_untracked();
        continuous.set(next);
        if !next {
            clear_continuous_timer();
        } else if !capturing.get_untracked() {
            trigger_capture();
        }
    });
    let on_decoder_change = Callback::new(move |next: DecoderConfig| {
        selected_frame_id.set(None);
        decoder_config.set(next);
    });
    let on_export_csv = Callback::new(move |_| {
        if let Some(cap) = capture.get_untracked() {
            let labels = channel_labels.get_untracked();
            let csv = export_capture_to_csv(&cap, &labels);
            download_text_file("hotwire_capture.csv", &csv, "text/csv;charset=utf-8");
        }
    });
    let on_export_vcd = Callback::new(move |_| {
        if let Some(cap) = capture.get_untracked() {
            let labels = channel_labels.get_untracked();
            let vcd = export_capture_to_vcd(&cap, &labels);
            download_text_file("hotwire_capture.vcd", &vcd, "text/plain;charset=utf-8");
        }
    });
    let on_force_channel = Callback::new(move |req: ForceChannelRequest| {
        channel_configs.update(|cfgs| {
            cfgs[req.ch] = ChannelUiState {
                mode: req.mode,
                pull: req.pull,
                protect: req.protect,
            };
        });
        let cmd = build_pin_force_cmd(req.ch as u8, req.mode, req.pull, req.protect);
        serial_transport.with_value(|t| t.send_bytes(&cmd));
    });
    let on_rename_channel = Callback::new(move |(ch, alias): (usize, String)| {
        channel_labels.update(|labels| {
            labels[ch] = alias.chars().take(14).collect();
            save_channel_labels(labels);
        });
    });
    let on_select_frame = Callback::new(move |frame: DecodedFrameAnnotation| {
        selected_frame_id.set(Some(frame.id));
        send_waveform_cmd(WaveformCommand::FocusSampleRange {
            start: frame.start_sample,
            end: frame.end_sample,
        });
    });

    view! {
        <HotWireTheme />
        <div class="app-shell">
            <TopToolbar
                transport=transport
                identity=identity
                capture_config=capture_config
                capturing=capturing
                continuous=continuous
                has_active_outputs=has_active_outputs
                decoder_config=decoder_config
                has_capture=has_capture
                channel_labels=channel_labels
                drawer_open=drawer_open
                on_toggle_drawer=on_toggle_drawer
                on_connect=on_connect
                on_start_demo=on_start_demo
                on_disconnect=on_disconnect
                on_capture=on_capture
                on_abort=on_abort
                on_toggle_continuous=on_toggle_continuous
                on_release_all=on_release_all
                on_decoder_change=on_decoder_change
                on_export_csv=on_export_csv
                on_export_vcd=on_export_vcd
            />

            <main class="workspace-split">
                <ChannelStrip
                    connected=connected
                    telemetry=telemetry
                    channel_configs=channel_configs
                    channel_labels=channel_labels
                    board_caps=board_caps
                    on_force_channel=on_force_channel
                    on_rename_channel=on_rename_channel
                />
                <WaveformCanvas
                    capture=capture
                    capturing=capturing
                    decoded_frames=decoded_frames
                    selected_frame_id=selected_frame_id
                    on_select_frame=on_select_frame
                    channel_labels=channel_labels
                    command=waveform_cmd
                />
            </main>

            {move || {
                let cap = capture.get()?;
                let cfg = decoder_config.get();
                if cfg.kind == DecoderKind::None {
                    return None;
                }
                let frames = decoded_frames.get();
                let count = frames.len();
                let rate_hz = cap.sample_rate_hz.max(1) as f64;
                let trig_idx = cap.trigger_index as f64;

                Some(view! {
                    <section class="decoded-strip" aria-label="Decoded protocol frames">
                        <span class="decoded-strip-title">
                            {format!("{} ({count})", cfg.kind.display_upper())}
                        </span>
                        {if count == 0 {
                            view! {
                                <span class="decoded-strip-empty">
                                    {format!(
                                        "No valid {} frames found in capture — check channel/baud settings",
                                        cfg.kind.display_upper()
                                    )}
                                </span>
                            }
                            .into_any()
                        } else {
                            let more = count.saturating_sub(200);
                            view! {
                                <div class="decoded-strip-list">
                                    {frames
                                        .into_iter()
                                        .take(200)
                                        .map(|frame| {
                                            let t_sec = (frame.start_sample as f64 - trig_idx) / rate_hz;
                                            let t_str = format_signed_duration(t_sec);
                                            let chip_title = format!("{} @ {t_str}", frame.detail);
                                            let kind_cls = frame.kind.as_class();
                                            let fid = frame.id;
                                            let lbl = frame.label.clone();
                                            view! {
                                                <button
                                                    type="button"
                                                    class=move || {
                                                        if selected_frame_id.get() == Some(fid) {
                                                            format!("decoded-chip decoded-chip-{kind_cls} selected")
                                                        } else {
                                                            format!("decoded-chip decoded-chip-{kind_cls}")
                                                        }
                                                    }
                                                    title=chip_title
                                                    on:click=move |_| on_select_frame.run(frame.clone())
                                                >
                                                    <span class="decoded-chip-time">{t_str}</span>
                                                    <span class="decoded-chip-val">{lbl}</span>
                                                </button>
                                            }
                                        })
                                        .collect_view()}
                                    {(more > 0).then(|| {
                                        view! { <span class="decoded-strip-more">{format!("+{more} more")}</span> }
                                    })}
                                </div>
                            }
                            .into_any()
                        }}
                    </section>
                })
            }}

            <BottomDrawer
                open=drawer_open
                on_close=on_close_drawer
                identity=identity
                serial_transport=serial_transport
            />
        </div>
    }
}
