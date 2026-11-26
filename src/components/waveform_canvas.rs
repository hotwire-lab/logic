use hotwire_core::ui::{apply_anchored_zoom, apply_horizontal_pan, GestureDelta, PinchPanTracker};
use leptos::html;
use leptos::prelude::*;
use wasm_bindgen::JsCast;

use crate::protocol::decoders::{
    count_channel_edges, find_nearest_edge, measure_pulse_at_sample, DecodedFrameAnnotation,
    FrameBadgeKind, PulseMeasurement,
};
use crate::protocol::time_format::{format_duration, format_frequency, format_signed_duration};
use crate::protocol::types::{CaptureDataFrame, CHANNELS};

const MINIMAP_HEIGHT: f64 = 20.0;
const RULER_HEIGHT: f64 = 26.0;
const TOP_HEIGHT: f64 = MINIMAP_HEIGHT + RULER_HEIGHT;
const MINIMAP_BINS: usize = 512;

#[derive(Debug, Clone, Copy)]
pub enum WaveformCommand {
    ZoomIn,
    ZoomOut,
    PanByFraction(f64),
    FitAll,
    JumpToTrigger,
    ToggleCursors,
    FocusSampleRange { start: usize, end: usize },
}

#[derive(Debug, Clone, Copy)]
struct ViewWindow {
    start_sample: f64,
    visible_samples: f64,
}

#[derive(Debug, Clone, Copy)]
struct HoverState {
    x: f64,
    y: f64,
    ch: usize,
    measurement: Option<PulseMeasurement>,
}

#[derive(Debug, Clone, Copy)]
struct SnapMarker {
    sample_idx: usize,
    ch: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DragMode {
    None,
    Pan,
    CursorA,
    CursorB,
    Pinch,
    Minimap,
    BoxZoom,
}

#[derive(Debug, Clone)]
struct MinimapActivity {
    density: Vec<u16>,
    max_density: u16,
    bins: usize,
}

fn choose_nice_step(raw_step_sec: f64) -> f64 {
    if !raw_step_sec.is_finite() || raw_step_sec <= 0.0 {
        return 1e-6;
    }
    let exp = raw_step_sec.log10().floor();
    let base = 10.0f64.powf(exp);
    let norm = raw_step_sec / base;
    if norm <= 1.0 {
        base
    } else if norm <= 2.0 {
        2.0 * base
    } else if norm <= 5.0 {
        5.0 * base
    } else {
        10.0 * base
    }
}

fn frame_badge_colors(kind: FrameBadgeKind) -> (&'static str, &'static str, &'static str) {
    match kind {
        FrameBadgeKind::Start => ("rgba(63, 185, 80, 0.28)", "#3FB950", "#AFF5B4"),
        FrameBadgeKind::Stop => ("rgba(240, 136, 62, 0.28)", "#F0883E", "#FFD8B5"),
        FrameBadgeKind::Addr => ("rgba(188, 140, 255, 0.28)", "#BC8CFF", "#EBD9FF"),
        FrameBadgeKind::Error => ("rgba(248, 81, 73, 0.34)", "#F85149", "#FFDCE0"),
        FrameBadgeKind::Data => ("rgba(57, 197, 207, 0.24)", "#39C5CF", "#C5F7FA"),
    }
}

fn compute_minimap(capture: &CaptureDataFrame) -> Option<MinimapActivity> {
    let samples = &capture.samples;
    let total = samples.len();
    if total < 2 {
        return None;
    }
    let bins = MINIMAP_BINS.min(total);
    let mut density = vec![0u16; bins];
    let mut max_density = 1u16;

    for (b, slot) in density.iter_mut().enumerate() {
        let s0 = ((b as f64 / bins as f64) * ((total - 1) as f64)).floor() as usize;
        let s1 = ((((b + 1) as f64 / bins as f64) * ((total - 1) as f64)).floor() as usize)
            .min(total - 1);
        let mut transitions = 0u32;
        for i in s0.max(1)..=s1 {
            let diff = samples[i] ^ samples[i - 1];
            if diff != 0 {
                transitions += diff.count_ones();
            }
        }
        let span = (s1.saturating_sub(s0) + 1) as f64;
        let avg = ((transitions as f64 * 10.0) / span)
            .round()
            .clamp(0.0, 65535.0) as u16;
        *slot = avg;
        if avg > max_density {
            max_density = avg;
        }
    }

    Some(MinimapActivity {
        density,
        max_density,
        bins,
    })
}

fn clamp_view(start_sample: f64, visible_samples: f64, total: usize) -> ViewWindow {
    let total_f = total.max(1) as f64;
    let min_vis = total_f.min(4.0);
    let clamped_vis = visible_samples.clamp(min_vis, total_f);
    let max_start = (total_f - clamped_vis).max(0.0);
    let clamped_start = start_sample.clamp(0.0, max_start);
    ViewWindow {
        start_sample: clamped_start,
        visible_samples: clamped_vis,
    }
}

#[component]
pub fn WaveformCanvas(
    capture: RwSignal<Option<CaptureDataFrame>>,
    capturing: RwSignal<bool>,
    decoded_frames: Memo<Vec<DecodedFrameAnnotation>>,
    selected_frame_id: RwSignal<Option<u32>>,
    on_select_frame: Callback<DecodedFrameAnnotation>,
    channel_labels: RwSignal<[String; 8]>,
    command: RwSignal<Option<(u64, WaveformCommand)>>,
) -> impl IntoView {
    let canvas_ref = NodeRef::<html::Canvas>::new();

    let view = RwSignal::new(ViewWindow {
        start_sample: 0.0,
        visible_samples: 1024.0,
    });
    let show_cursors = RwSignal::new(false);
    let cursor_a = RwSignal::new(256usize);
    let cursor_b = RwSignal::new(768usize);
    let active_channel = RwSignal::new(0usize);
    let hover_state = RwSignal::new(None::<HoverState>);
    let snap_marker = RwSignal::new(None::<SnapMarker>);
    let box_zoom_range = RwSignal::new(None::<(f64, f64)>);
    let resize_rev = RwSignal::new(0u64);

    let prev_capture_len = StoredValue::new(0usize);
    let minimap_cache = StoredValue::new(None::<MinimapActivity>);
    let gesture_tracker = StoredValue::new(PinchPanTracker::new());
    let drag_mode = StoredValue::new(DragMode::None);
    let down_pos = StoredValue::new((0.0f64, 0.0f64, false));
    let raf_pending = StoredValue::new(false);

    let get_canvas_dims = move || -> (f64, f64) {
        if let Some(c) = canvas_ref.get_untracked() {
            let r = c.get_bounding_client_rect();
            (r.width().floor().max(100.0), r.height().floor().max(180.0))
        } else {
            (640.0, 360.0)
        }
    };

    let zoom_around_x = move |factor: f64, x_px: f64| {
        let Some(cap) = capture.get_untracked() else {
            return;
        };
        if cap.samples.is_empty() {
            return;
        }
        let (width_px, _) = get_canvas_dims();
        let total = cap.samples.len();
        let total_f = total.max(1) as f64;
        let max_zoom = (total_f / 4.0).max(1.0);
        let scale_factor = if factor > 0.0 { 1.0 / factor } else { 1.0 };
        view.update(|v| {
            let cur_zoom = (total_f / v.visible_samples.max(1.0)).clamp(1.0, max_zoom);
            let cur_pan = (v.start_sample / total_f).clamp(0.0, 1.0);
            let anchor = (x_px / width_px.max(1.0)).clamp(0.0, 1.0);
            let (next_z, next_pan) =
                apply_anchored_zoom(cur_zoom, cur_pan, scale_factor, anchor, 1.0, max_zoom);
            *v = clamp_view(next_pan * total_f, total_f / next_z, total);
        });
    };

    let fit_all = move || {
        if let Some(cap) = capture.get_untracked() {
            if !cap.samples.is_empty() {
                view.set(ViewWindow {
                    start_sample: 0.0,
                    visible_samples: cap.samples.len() as f64,
                });
            }
        }
    };

    let jump_to_trigger = move || {
        if let Some(cap) = capture.get_untracked() {
            let total = cap.samples.len();
            if total == 0 {
                return;
            }
            let target = cap.trigger_index as f64;
            view.update(|v| {
                let next_vis = if v.visible_samples > (total as f64) * 0.45 {
                    ((total as f64) / 8.0).round().max(64.0).min(total as f64)
                } else {
                    v.visible_samples
                };
                *v = clamp_view(target - next_vis / 2.0, next_vis, total);
            });
        }
    };

    // React to external commands (keyboard shortcuts & decoded chip clicks)
    Effect::new(move |_| {
        let Some((_, cmd)) = command.get() else {
            return;
        };
        match cmd {
            WaveformCommand::ZoomIn => {
                let (w, _) = get_canvas_dims();
                zoom_around_x(0.65, w / 2.0);
            }
            WaveformCommand::ZoomOut => {
                let (w, _) = get_canvas_dims();
                zoom_around_x(1.5, w / 2.0);
            }
            WaveformCommand::PanByFraction(frac) => {
                if let Some(cap) = capture.get_untracked() {
                    let total = cap.samples.len();
                    if total > 0 {
                        view.update(|v| {
                            *v = clamp_view(
                                v.start_sample + frac * v.visible_samples,
                                v.visible_samples,
                                total,
                            );
                        });
                    }
                }
            }
            WaveformCommand::FitAll => fit_all(),
            WaveformCommand::JumpToTrigger => jump_to_trigger(),
            WaveformCommand::ToggleCursors => show_cursors.update(|v| *v = !*v),
            WaveformCommand::FocusSampleRange { start, end } => {
                if let Some(cap) = capture.get_untracked() {
                    let total = cap.samples.len();
                    if total > 0 {
                        let span = end.saturating_sub(start).max(12) as f64;
                        let padded = (span * 3.0).max(48.0).min(total as f64);
                        let mid = (start + end) as f64 / 2.0;
                        view.set(clamp_view(mid - padded / 2.0, padded, total));
                    }
                }
            }
        }
    });

    // Update minimap & reset zoom only when capture length changes
    Effect::new(move |_| {
        let cur_cap = capture.get();
        let Some(cap) = cur_cap else {
            prev_capture_len.set_value(0);
            minimap_cache.set_value(None);
            return;
        };
        let total = cap.samples.len();
        if total == 0 {
            prev_capture_len.set_value(0);
            minimap_cache.set_value(None);
            return;
        }
        minimap_cache.set_value(compute_minimap(&cap));
        let trig = cap.trigger_index.min(total - 1);
        if prev_capture_len.get_value() != total {
            view.set(ViewWindow {
                start_sample: 0.0,
                visible_samples: total as f64,
            });
            cursor_a.set(((total as f64) * 0.25).round() as usize);
            cursor_b.set(if trig > 0 && trig < total - 1 {
                trig
            } else {
                (((total as f64) * 0.65).round() as usize).min(total - 1)
            });
        } else {
            view.update(|v| *v = clamp_view(v.start_sample, v.visible_samples, total));
            cursor_a.update(|a| *a = (*a).min(total - 1));
            cursor_b.update(|b| *b = (*b).min(total - 1));
        }
        prev_capture_len.set_value(total);
        hover_state.set(None);
        snap_marker.set(None);
        box_zoom_range.set(None);
    });

    // Window resize redraw listener
    Effect::new(move |_| {
        let cb = wasm_bindgen::closure::Closure::<dyn FnMut()>::new(move || {
            resize_rev.update(|v| *v += 1);
        });
        if let Some(w) = web_sys::window() {
            let _ = w.add_event_listener_with_callback("resize", cb.as_ref().unchecked_ref());
        }
        cb.forget();
    });

    // Main Canvas 2D renderer (coalesced onto requestAnimationFrame)
    let render_waveform = move || {
        let cur_cap = capture.get_untracked();
        let is_capturing = capturing.get_untracked();
        let cur_view = view.get_untracked();
        let cur_show_cursors = show_cursors.get_untracked();
        let cur_a = cursor_a.get_untracked();
        let cur_b = cursor_b.get_untracked();
        let cur_active_ch = active_channel.get_untracked();
        let cur_hover = hover_state.get_untracked();
        let cur_snap = snap_marker.get_untracked();
        let cur_box = box_zoom_range.get_untracked();
        let frames = decoded_frames.get_untracked();
        let sel_id = selected_frame_id.get_untracked();

        let Some(canvas) = canvas_ref.get() else {
            return;
        };
        let rect = canvas.get_bounding_client_rect();
        let width = rect.width().floor().max(100.0);
        let height = rect.height().floor().max(180.0);
        let dpr = hotwire_core::web::capped_device_pixel_ratio();
        let target_w = (width * dpr).round() as u32;
        let target_h = (height * dpr).round() as u32;
        if canvas.width() != target_w || canvas.height() != target_h {
            canvas.set_width(target_w);
            canvas.set_height(target_h);
        }

        let Ok(Some(ctx_obj)) = canvas.get_context("2d") else {
            return;
        };
        let Ok(ctx) = ctx_obj.dyn_into::<web_sys::CanvasRenderingContext2d>() else {
            return;
        };

        let _ = ctx.set_transform(dpr, 0.0, 0.0, dpr, 0.0, 0.0);
        let lane_height = ((height - TOP_HEIGHT) / 8.0).max(16.0);

        // 1. Backgrounds
        ctx.set_fill_style_str("#0B0E12");
        ctx.fill_rect(0.0, 0.0, width, height);
        ctx.set_fill_style_str("#0E1217");
        ctx.fill_rect(0.0, 0.0, width, MINIMAP_HEIGHT);
        ctx.set_fill_style_str("#11151B");
        ctx.fill_rect(0.0, MINIMAP_HEIGHT, width, RULER_HEIGHT);

        for ch in 0..8 {
            let y_top = TOP_HEIGHT + (ch as f64) * lane_height;
            ctx.set_fill_style_str(if ch == cur_active_ch && cur_cap.is_some() {
                "rgba(88, 166, 255, 0.07)"
            } else if ch % 2 == 0 {
                "#0B0E12"
            } else {
                "#0F131A"
            });
            ctx.fill_rect(0.0, y_top, width, lane_height);

            ctx.set_stroke_style_str("#1B212B");
            ctx.set_line_width(1.0);
            ctx.begin_path();
            ctx.move_to(0.0, y_top);
            ctx.line_to(width, y_top);
            ctx.stroke();
        }

        ctx.set_stroke_style_str("#232A35");
        ctx.set_line_width(1.0);
        ctx.begin_path();
        ctx.move_to(0.0, MINIMAP_HEIGHT - 0.5);
        ctx.line_to(width, MINIMAP_HEIGHT - 0.5);
        ctx.move_to(0.0, TOP_HEIGHT - 0.5);
        ctx.line_to(width, TOP_HEIGHT - 0.5);
        ctx.stroke();

        let Some(ref cap) = cur_cap else {
            ctx.set_fill_style_str("#7D8796");
            ctx.set_font(
                "12.5px 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            );
            ctx.set_text_align("center");
            ctx.set_text_baseline("middle");
            let msg = if is_capturing {
                "Waiting for trigger / capturing samples..."
            } else {
                "Connect USB device or launch Demo, then click Capture (Space)"
            };
            let _ = ctx.fill_text(msg, width / 2.0, TOP_HEIGHT + (height - TOP_HEIGHT) / 2.0);
            return;
        };

        if cap.samples.is_empty() {
            return;
        }

        let samples = &cap.samples;
        let total = samples.len();
        let total_f = total as f64;
        let rate_hz = cap.sample_rate_hz.max(1) as f64;
        let start_idx = cur_view.start_sample.max(0.0);
        let vis_count = cur_view.visible_samples.max(1.0);
        let end_idx = (start_idx + vis_count).min(total_f);
        let px_per_sample = width / vis_count;

        let sample_to_x = |s: f64| ((s - start_idx) / vis_count) * width;

        // 1b. Minimap
        minimap_cache.with_value(|mm_opt| {
            if let Some(mm) = mm_opt {
                ctx.set_fill_style_str("rgba(88, 166, 255, 0.42)");
                for (b, &val) in mm.density.iter().enumerate() {
                    if val == 0 {
                        continue;
                    }
                    let bar_h = (((val as f64 / mm.max_density as f64) * (MINIMAP_HEIGHT - 4.0))
                        .round())
                    .max(2.0);
                    let bx0 = (b as f64 / mm.bins as f64) * width;
                    let bx1 = ((b + 1) as f64 / mm.bins as f64) * width;
                    ctx.fill_rect(
                        bx0,
                        MINIMAP_HEIGHT - 2.0 - bar_h,
                        (bx1 - bx0).max(1.0),
                        bar_h,
                    );
                }
            }
        });

        let has_trigger_marker = (cap.triggered || cap.auto_triggered || cap.trigger_index > 0)
            && cap.trigger_index < total;

        if has_trigger_marker {
            let m_trig_x = (cap.trigger_index as f64 / total_f) * width;
            ctx.set_fill_style_str(if cap.auto_triggered {
                "#8B949E"
            } else {
                "#F0883E"
            });
            ctx.fill_rect(m_trig_x.round() - 1.0, 1.0, 2.0, MINIMAP_HEIGHT - 2.0);
        }

        let vx0 = (start_idx / total_f) * width;
        let vw = ((vis_count / total_f) * width).clamp(6.0, width);
        let vx_clamped = vx0.clamp(0.0, width - vw);
        ctx.set_fill_style_str("rgba(0, 0, 0, 0.45)");
        if vx_clamped > 0.0 {
            ctx.fill_rect(0.0, 0.0, vx_clamped, MINIMAP_HEIGHT - 1.0);
        }
        if vx_clamped + vw < width {
            ctx.fill_rect(
                vx_clamped + vw,
                0.0,
                width - (vx_clamped + vw),
                MINIMAP_HEIGHT - 1.0,
            );
        }
        ctx.set_stroke_style_str("#58A6FF");
        ctx.set_line_width(1.25);
        ctx.stroke_rect(vx_clamped + 0.5, 1.5, vw - 1.0, MINIMAP_HEIGHT - 3.0);

        // 2. Time Ruler Ticks & Vertical Grid
        let visible_dur_sec = vis_count / rate_hz;
        let target_ticks = ((width / 110.0).floor() as i32).max(3) as f64;
        let step_sec = choose_nice_step(visible_dur_sec / target_ticks);
        let origin_sample = cap.trigger_index as f64;
        let t_start_sec = (start_idx - origin_sample) / rate_hz;
        let t_end_sec = (end_idx - origin_sample) / rate_hz;
        let first_tick_k = (t_start_sec / step_sec).ceil() as i64;
        let last_tick_k = (t_end_sec / step_sec).floor() as i64;

        ctx.set_font(
            "11px 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        );
        ctx.set_text_baseline("middle");
        ctx.set_text_align("left");

        for k in first_tick_k..=last_tick_k {
            let tick_sec = (k as f64) * step_sec;
            let sample_pos = origin_sample + tick_sec * rate_hz;
            let x = sample_to_x(sample_pos);
            if x < -2.0 || x > width + 2.0 {
                continue;
            }
            let xr = x.round() + 0.5;
            ctx.set_stroke_style_str("#1E2633");
            ctx.set_line_width(1.0);
            ctx.begin_path();
            ctx.move_to(xr, TOP_HEIGHT);
            ctx.line_to(xr, height);
            ctx.stroke();

            ctx.set_stroke_style_str("#484F58");
            ctx.begin_path();
            ctx.move_to(xr, TOP_HEIGHT - 6.0);
            ctx.line_to(xr, TOP_HEIGHT);
            ctx.stroke();

            ctx.set_fill_style_str("#8B949E");
            let _ = ctx.fill_text(
                &format_signed_duration(tick_sec),
                x + 4.0,
                MINIMAP_HEIGHT + RULER_HEIGHT / 2.0,
            );
        }

        // 3. Digital Step Waveforms (D0..D7)
        let pad_y = (lane_height * 0.2).clamp(5.0, 12.0);
        for (ch, meta) in CHANNELS.iter().enumerate() {
            let bit_mask = 1u8 << ch;
            let y_top = TOP_HEIGHT + (ch as f64) * lane_height;
            let y_high = y_top + pad_y;
            let y_low = y_top + lane_height - pad_y;

            ctx.set_stroke_style_str(meta.color);
            ctx.set_line_width(1.75);

            if px_per_sample >= 1.0 {
                let i_from = (start_idx.floor() as usize).min(total - 1);
                let i_to = (end_idx.ceil() as usize).min(total - 1);

                ctx.begin_path();
                let mut prev_bit = (samples[i_from] & bit_mask) != 0;
                ctx.move_to(
                    sample_to_x(i_from as f64),
                    if prev_bit { y_high } else { y_low },
                );

                for (idx, &sample) in samples.iter().enumerate().take(i_to + 1).skip(i_from + 1) {
                    let cur_bit = (sample & bit_mask) != 0;
                    let x = sample_to_x(idx as f64);
                    ctx.line_to(x, if prev_bit { y_high } else { y_low });
                    if cur_bit != prev_bit {
                        ctx.line_to(x, if cur_bit { y_high } else { y_low });
                    }
                    prev_bit = cur_bit;
                }
                ctx.line_to(
                    sample_to_x((i_to + 1) as f64),
                    if prev_bit { y_high } else { y_low },
                );
                ctx.stroke();

                ctx.set_fill_style_str(&format!("{}1C", meta.color));
                let fill_h = y_low - y_high;
                let mut run_start: Option<usize> = None;
                for (idx, &sample) in samples.iter().enumerate().take(i_to + 1).skip(i_from) {
                    if (sample & bit_mask) != 0 {
                        if run_start.is_none() {
                            run_start = Some(idx);
                        }
                    } else if let Some(rs) = run_start.take() {
                        let sx = sample_to_x(rs as f64);
                        let sw = (sample_to_x(idx as f64) - sx).max(1.0);
                        ctx.fill_rect(sx, y_high, sw, fill_h);
                    }
                }
                if let Some(rs) = run_start {
                    let sx = sample_to_x(rs as f64);
                    let sw = (sample_to_x((i_to + 1) as f64) - sx).max(1.0);
                    ctx.fill_rect(sx, y_high, sw, fill_h);
                }

                if px_per_sample >= 10.0 {
                    ctx.set_fill_style_str(meta.color);
                    for (idx, &sample) in samples.iter().enumerate().take(i_to + 1).skip(i_from) {
                        let cx = sample_to_x(idx as f64);
                        let cy = if (sample & bit_mask) != 0 {
                            y_high
                        } else {
                            y_low
                        };
                        ctx.begin_path();
                        let _ = ctx.arc(cx, cy, 2.3, 0.0, std::f64::consts::TAU);
                        ctx.fill();
                    }
                }
            } else {
                ctx.begin_path();
                let mut prev_last_bit: Option<bool> = None;
                let w_int = width as i32;
                for px in 0..w_int {
                    let pxf = px as f64;
                    let s0 =
                        ((start_idx + (pxf / width) * vis_count).floor() as usize).min(total - 1);
                    let s1 = (((start_idx + ((pxf + 1.0) / width) * vis_count).floor() as usize)
                        .max(s0))
                    .min(total - 1);

                    let mut has_low = false;
                    let mut has_high = false;
                    for &sample in &samples[s0..=s1] {
                        if (sample & bit_mask) != 0 {
                            has_high = true;
                        } else {
                            has_low = true;
                        }
                        if has_high && has_low {
                            break;
                        }
                    }

                    let first_bit = (samples[s0] & bit_mask) != 0;
                    let last_bit = (samples[s1] & bit_mask) != 0;

                    if let Some(plb) = prev_last_bit {
                        if first_bit != plb {
                            ctx.move_to(pxf, y_high);
                            ctx.line_to(pxf, y_low);
                        }
                    }

                    if has_high && has_low {
                        ctx.move_to(pxf + 0.5, y_high);
                        ctx.line_to(pxf + 0.5, y_low);
                    } else {
                        let y = if has_high { y_high } else { y_low };
                        ctx.move_to(pxf, y);
                        ctx.line_to(pxf + 1.0, y);
                    }
                    prev_last_bit = Some(last_bit);
                }
                ctx.stroke();
            }
        }

        // 3b. Inline Protocol Decoder Bubbles
        if !frames.is_empty() {
            ctx.save();
            ctx.set_font("600 10px 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace");
            ctx.set_text_align("center");
            ctx.set_text_baseline("middle");

            let draw_bubble = |lane_ch: usize,
                               frame: &DecodedFrameAnnotation,
                               label: &str,
                               kind: FrameBadgeKind| {
                if (frame.end_sample as f64) < start_idx || (frame.start_sample as f64) > end_idx {
                    return;
                }
                let x0 = sample_to_x(frame.start_sample as f64).max(-2.0);
                let x1 = sample_to_x(frame.end_sample as f64).min(width + 2.0);
                let bw = (x1 - x0).max(3.0);
                let y_top = TOP_HEIGHT + (lane_ch as f64) * lane_height;
                let bh = (lane_height * 0.38).clamp(10.0, 15.0);
                let by = y_top + lane_height - bh - 2.0;
                let (bg, border, text_col) = frame_badge_colors(kind);
                let is_sel = sel_id == Some(frame.id);

                ctx.set_fill_style_str(bg);
                ctx.set_stroke_style_str(if is_sel { "#FFFFFF" } else { border });
                ctx.set_line_width(if is_sel { 1.6 } else { 1.0 });
                ctx.fill_rect(x0 + 1.0, by, (bw - 2.0).max(2.0), bh);
                if bw >= 5.0 {
                    ctx.stroke_rect(x0 + 1.0, by, (bw - 2.0).max(2.0), bh);
                }

                if bw >= 22.0 {
                    ctx.save();
                    ctx.begin_path();
                    ctx.rect(x0 + 3.0, by, (bw - 6.0).max(1.0), bh);
                    ctx.clip();
                    ctx.set_fill_style_str(text_col);
                    let _ = ctx.fill_text(label, x0 + bw / 2.0, by + bh / 2.0 + 0.5);
                    ctx.restore();
                }
            };

            for frame in &frames {
                draw_bubble(frame.channel, frame, &frame.label, frame.kind);
                if let (Some(sec_ch), Some(ref sec_lbl)) =
                    (frame.secondary_channel, &frame.secondary_label)
                {
                    draw_bubble(sec_ch, frame, sec_lbl, FrameBadgeKind::Data);
                }
            }
            ctx.restore();
        }

        // 4. Vertical Trigger Marker
        if has_trigger_marker {
            let trig_x = sample_to_x(cap.trigger_index as f64);
            if trig_x >= 0.0 && trig_x <= width {
                ctx.save();
                let trig_col = if cap.auto_triggered {
                    "#8B949E"
                } else {
                    "#F0883E"
                };
                ctx.set_stroke_style_str(trig_col);
                ctx.set_line_width(1.5);
                let dash = js_sys::Array::new();
                dash.push(&4.0.into());
                dash.push(&4.0.into());
                let _ = ctx.set_line_dash(&dash);
                ctx.begin_path();
                ctx.move_to(trig_x, TOP_HEIGHT);
                ctx.line_to(trig_x, height);
                ctx.stroke();
                let _ = ctx.set_line_dash(&js_sys::Array::new());

                ctx.set_fill_style_str(trig_col);
                ctx.fill_rect(trig_x - 8.0, MINIMAP_HEIGHT + 4.0, 16.0, 16.0);
                ctx.set_fill_style_str("#0D1117");
                ctx.set_font("bold 10px ui-monospace, monospace");
                ctx.set_text_align("center");
                ctx.set_text_baseline("middle");
                let _ = ctx.fill_text("T", trig_x, MINIMAP_HEIGHT + 12.0);
                ctx.restore();
            }
        }

        // 5. Box Zoom Overlay
        if let Some((x0, x1)) = cur_box {
            let bx = x0.min(x1);
            let bw = (x1 - x0).abs();
            if bw >= 2.0 {
                ctx.save();
                ctx.set_fill_style_str("rgba(88, 166, 255, 0.16)");
                ctx.fill_rect(bx, TOP_HEIGHT, bw, height - TOP_HEIGHT);
                ctx.set_stroke_style_str("#58A6FF");
                ctx.set_line_width(1.25);
                ctx.stroke_rect(
                    bx + 0.5,
                    TOP_HEIGHT + 0.5,
                    bw - 1.0,
                    height - TOP_HEIGHT - 1.0,
                );
                let span_sec = ((bw / width.max(1.0)) * vis_count) / rate_hz;
                ctx.set_fill_style_str("#58A6FF");
                ctx.set_font("600 11px ui-monospace, monospace");
                ctx.set_text_align("center");
                let _ = ctx.fill_text(&format_duration(span_sec), bx + bw / 2.0, TOP_HEIGHT + 14.0);
                ctx.restore();
            }
        }

        // 6. Hover Crosshair & Pulse Bracket
        if let Some(h) = cur_hover {
            if cur_box.is_none() && h.y >= TOP_HEIGHT {
                ctx.save();
                ctx.set_stroke_style_str("rgba(139, 148, 158, 0.45)");
                ctx.set_line_width(1.0);
                let dash = js_sys::Array::new();
                dash.push(&2.0.into());
                dash.push(&3.0.into());
                let _ = ctx.set_line_dash(&dash);
                ctx.begin_path();
                ctx.move_to(h.x + 0.5, TOP_HEIGHT);
                ctx.line_to(h.x + 0.5, height);
                ctx.stroke();
                let _ = ctx.set_line_dash(&js_sys::Array::new());

                if let Some(m) = h.measurement {
                    let mx0 = sample_to_x(m.start_sample as f64);
                    let mx1 = sample_to_x(m.end_sample as f64);
                    let mw = mx1 - mx0;
                    if mw >= 14.0 && mx1 > 0.0 && mx0 < width {
                        let y_top = TOP_HEIGHT + (m.channel as f64) * lane_height;
                        let y_mid = y_top + lane_height * 0.5;
                        let cx0 = mx0.max(0.0);
                        let cx1 = mx1.min(width);
                        ctx.set_stroke_style_str("#F0F6FC");
                        ctx.set_line_width(1.25);
                        ctx.begin_path();
                        ctx.move_to(cx0, y_mid - 5.0);
                        ctx.line_to(cx0, y_mid + 5.0);
                        ctx.move_to(cx1, y_mid - 5.0);
                        ctx.line_to(cx1, y_mid + 5.0);
                        ctx.move_to(cx0, y_mid);
                        ctx.line_to(cx1, y_mid);
                        ctx.stroke();

                        if mw >= 52.0 {
                            let label_text = format_duration(m.width_sec);
                            ctx.set_font("600 10px ui-monospace, monospace");
                            let tw = ctx
                                .measure_text(&label_text)
                                .map(|tm| tm.width())
                                .unwrap_or(44.0)
                                + 8.0;
                            let cx = (cx0 + cx1) / 2.0;
                            ctx.set_fill_style_str("rgba(13, 17, 23, 0.9)");
                            ctx.fill_rect(cx - tw / 2.0, y_mid - 8.0, tw, 16.0);
                            ctx.set_fill_style_str("#F0F6FC");
                            ctx.set_text_align("center");
                            ctx.set_text_baseline("middle");
                            let _ = ctx.fill_text(&label_text, cx, y_mid);
                        }
                    }
                }
                ctx.restore();
            }
        }

        // 7. Cursors A & B + Snap Marker
        if cur_show_cursors {
            let draw_cursor = |sample_pos: usize, label: &str, color: &str| {
                let x = sample_to_x(sample_pos as f64);
                if x < -12.0 || x > width + 12.0 {
                    return;
                }
                ctx.save();
                ctx.set_stroke_style_str(color);
                ctx.set_line_width(1.5);
                ctx.begin_path();
                ctx.move_to(x, TOP_HEIGHT);
                ctx.line_to(x, height);
                ctx.stroke();

                ctx.set_fill_style_str(color);
                ctx.fill_rect(x - 9.0, MINIMAP_HEIGHT + 4.0, 18.0, 17.0);
                ctx.set_fill_style_str("#0D1117");
                ctx.set_font("bold 11px ui-monospace, monospace");
                ctx.set_text_align("center");
                ctx.set_text_baseline("middle");
                let _ = ctx.fill_text(label, x, MINIMAP_HEIGHT + 12.5);
                ctx.restore();
            };

            draw_cursor(cur_a, "A", "#39C5CF");
            draw_cursor(cur_b, "B", "#D29922");

            if let Some(sm) = cur_snap {
                let sx = sample_to_x(sm.sample_idx as f64);
                let sy = TOP_HEIGHT + (sm.ch as f64) * lane_height + lane_height / 2.0;
                ctx.save();
                ctx.set_stroke_style_str("#FFFFFF");
                ctx.set_fill_style_str("#39C5CF");
                ctx.set_line_width(1.5);
                ctx.begin_path();
                let _ = ctx.arc(sx, sy, 4.0, 0.0, std::f64::consts::TAU);
                ctx.fill();
                ctx.stroke();
                ctx.restore();
            }
        }
    };

    Effect::new(move |_| {
        let _r = resize_rev.get();
        let _c = capture.with(|c| c.is_some());
        let _cap = capturing.get();
        let _v = view.get();
        let _sc = show_cursors.get();
        let _a = cursor_a.get();
        let _b = cursor_b.get();
        let _ch = active_channel.get();
        let _h = hover_state.get();
        let _sn = snap_marker.get();
        let _bx = box_zoom_range.get();
        let _f = decoded_frames.with(|f| f.len());
        let _s = selected_frame_id.get();

        if raf_pending.get_value() {
            return;
        }
        raf_pending.set_value(true);
        if let Some(win) = web_sys::window() {
            let cb = wasm_bindgen::closure::Closure::once_into_js(move || {
                raf_pending.set_value(false);
                render_waveform();
            });
            let _ = win.request_animation_frame(cb.unchecked_ref());
        } else {
            raf_pending.set_value(false);
            render_waveform();
        }
    });

    let x_to_sample = move |x_px: f64, width: f64| -> usize {
        let total = capture
            .get_untracked()
            .map(|c| c.samples.len())
            .unwrap_or(1);
        let v = view.get_untracked();
        let raw = v.start_sample + (x_px / width.max(1.0)) * v.visible_samples;
        (raw.round() as isize).clamp(0, (total.saturating_sub(1)) as isize) as usize
    };

    let y_to_channel = move |y_px: f64, height: f64| -> usize {
        let lane_height = ((height - TOP_HEIGHT) / 8.0).max(16.0);
        (((y_px - TOP_HEIGHT) / lane_height).floor() as isize).clamp(0, 7) as usize
    };

    let scrub_minimap = move |x_px: f64, width: f64| {
        if let Some(cap) = capture.get_untracked() {
            let total = cap.samples.len();
            if total == 0 {
                return;
            }
            let frac = (x_px / width.max(1.0)).clamp(0.0, 1.0);
            let center = frac * (total as f64);
            view.update(|v| {
                *v = clamp_view(center - v.visible_samples / 2.0, v.visible_samples, total)
            });
        }
    };

    let snap_cursor_sample =
        move |x_px: f64, y_px: f64, width: f64, height: f64, alt_key: bool| -> usize {
            let raw = x_to_sample(x_px, width);
            let Some(cap) = capture.get_untracked() else {
                snap_marker.set(None);
                return raw;
            };
            if alt_key || y_px < TOP_HEIGHT {
                snap_marker.set(None);
                return raw;
            }
            let ch = y_to_channel(y_px, height);
            let v = view.get_untracked();
            let snap_radius = ((10.0 / width.max(1.0)) * v.visible_samples)
                .round()
                .max(1.0) as usize;
            if let Some(snapped) = find_nearest_edge(&cap.samples, ch, raw as f64, snap_radius) {
                snap_marker.set(Some(SnapMarker {
                    sample_idx: snapped,
                    ch,
                }));
                snapped
            } else {
                snap_marker.set(None);
                raw
            }
        };

    let on_wheel = move |ev: web_sys::WheelEvent| {
        let Some(cap) = capture.get_untracked() else {
            return;
        };
        if cap.samples.is_empty() {
            return;
        }
        ev.prevent_default();
        ev.stop_propagation();
        let Some(canvas) = canvas_ref.get() else {
            return;
        };
        let rect = canvas.get_bounding_client_rect();
        let x = ev.client_x() as f64 - rect.left();
        let width_px = rect.width().max(1.0);
        let unit_scale = match ev.delta_mode() {
            1 => 18.0,
            2 => width_px,
            _ => 1.0,
        };
        let dx = ev.delta_x() * unit_scale;
        let dy = ev.delta_y() * unit_scale;

        if ev.shift_key() || dx.abs() > dy.abs() {
            let pan_px = if ev.shift_key() && dy.abs() >= dx.abs() {
                dy
            } else {
                dx
            };
            let total = cap.samples.len();
            view.update(|v| {
                *v = clamp_view(
                    v.start_sample + (pan_px / width_px) * v.visible_samples,
                    v.visible_samples,
                    total,
                );
            });
            return;
        }

        let clamped_delta = dy.clamp(-280.0, 280.0);
        let factor = (clamped_delta * 0.0022).exp();
        zoom_around_x(factor, x);
    };

    let on_pointer_down = move |ev: web_sys::PointerEvent| {
        if capture
            .get_untracked()
            .map(|c| c.samples.is_empty())
            .unwrap_or(true)
        {
            return;
        }
        let Some(canvas) = canvas_ref.get() else {
            return;
        };
        let rect = canvas.get_bounding_client_rect();
        let width = rect.width().max(1.0);
        let x = ev.client_x() as f64 - rect.left();
        let y = ev.client_y() as f64 - rect.top();
        let _ = canvas.set_pointer_capture(ev.pointer_id());

        let mut ptr_count = 0usize;
        gesture_tracker.update_value(|gt| {
            gt.pointer_down(ev.pointer_id(), x, y);
            ptr_count = gt.active_count();
        });
        down_pos.set_value((x, y, false));

        if ptr_count >= 2 {
            drag_mode.set_value(DragMode::Pinch);
            return;
        }

        if y < MINIMAP_HEIGHT {
            drag_mode.set_value(DragMode::Minimap);
            scrub_minimap(x, width);
            return;
        }

        if ev.shift_key() && y >= TOP_HEIGHT {
            drag_mode.set_value(DragMode::BoxZoom);
            box_zoom_range.set(Some((x, x)));
            return;
        }

        if show_cursors.get_untracked() {
            let v = view.get_untracked();
            let ax = ((cursor_a.get_untracked() as f64 - v.start_sample)
                / v.visible_samples.max(1.0))
                * width;
            let bx = ((cursor_b.get_untracked() as f64 - v.start_sample)
                / v.visible_samples.max(1.0))
                * width;
            let dist_a = (x - ax).abs();
            let dist_b = (x - bx).abs();
            let thresh = if y <= TOP_HEIGHT + 8.0 { 16.0 } else { 9.0 };
            if dist_a <= thresh && dist_a <= dist_b {
                drag_mode.set_value(DragMode::CursorA);
                return;
            }
            if dist_b <= thresh {
                drag_mode.set_value(DragMode::CursorB);
                return;
            }
        }

        drag_mode.set_value(DragMode::Pan);
    };

    let on_pointer_move = move |ev: web_sys::PointerEvent| {
        let Some(cap) = capture.get_untracked() else {
            return;
        };
        if cap.samples.is_empty() {
            return;
        }
        let Some(canvas) = canvas_ref.get() else {
            return;
        };
        let rect = canvas.get_bounding_client_rect();
        let width = rect.width().max(1.0);
        let height = rect.height().max(1.0);
        let x = ev.client_x() as f64 - rect.left();
        let y = ev.client_y() as f64 - rect.top();

        let mut gesture_delta = None;
        let mut active_cnt = 0usize;
        gesture_tracker.update_value(|gt| {
            active_cnt = gt.active_count();
            if active_cnt > 0 {
                gesture_delta = gt.pointer_move(ev.pointer_id(), x, y);
            }
        });
        if active_cnt == 0 {
            if y >= TOP_HEIGHT {
                let ch = y_to_channel(y, height);
                let sample_idx = x_to_sample(x, width);
                let measurement =
                    measure_pulse_at_sample(&cap.samples, ch, sample_idx, cap.sample_rate_hz);
                hover_state.set(Some(HoverState {
                    x,
                    y,
                    ch,
                    measurement,
                }));
            } else {
                hover_state.set(None);
            }
            return;
        }

        let (dx0, dy0, _) = down_pos.get_value();
        if (x - dx0).hypot(y - dy0) > 4.0 {
            down_pos.set_value((dx0, dy0, true));
        }

        let mode = drag_mode.get_value();
        let total = cap.samples.len();
        let total_f = total.max(1) as f64;
        let max_zoom = (total_f / 4.0).max(1.0);

        match mode {
            DragMode::Pinch => {
                if let Some(GestureDelta::Pinch {
                    scale_ratio,
                    center_x,
                    pan_dx,
                    ..
                }) = gesture_delta
                {
                    let v = view.get_untracked();
                    let cur_zoom = (total_f / v.visible_samples.max(1.0)).clamp(1.0, max_zoom);
                    let cur_pan = (v.start_sample / total_f).clamp(0.0, 1.0);
                    let anchor = (center_x / width).clamp(0.0, 1.0);
                    let (next_z, zoomed_pan) =
                        apply_anchored_zoom(cur_zoom, cur_pan, scale_ratio, anchor, 1.0, max_zoom);
                    let panned = apply_horizontal_pan(next_z, zoomed_pan, pan_dx, width);
                    view.set(clamp_view(panned * total_f, total_f / next_z, total));
                }
            }
            DragMode::Minimap => scrub_minimap(x, width),
            DragMode::BoxZoom => {
                box_zoom_range.update(|r| {
                    *r = match *r {
                        Some((x0, _)) => Some((x0, x)),
                        None => Some((x, x)),
                    };
                });
            }
            DragMode::CursorA => {
                cursor_a.set(snap_cursor_sample(x, y, width, height, ev.alt_key()));
            }
            DragMode::CursorB => {
                cursor_b.set(snap_cursor_sample(x, y, width, height, ev.alt_key()));
            }
            DragMode::Pan => {
                if let Some(GestureDelta::Pan { dx, .. }) = gesture_delta {
                    let v = view.get_untracked();
                    let cur_zoom = (total_f / v.visible_samples.max(1.0)).clamp(1.0, max_zoom);
                    let cur_pan = (v.start_sample / total_f).clamp(0.0, 1.0);
                    let next_pan = apply_horizontal_pan(cur_zoom, cur_pan, dx, width);
                    view.set(clamp_view(next_pan * total_f, v.visible_samples, total));
                }
            }
            DragMode::None => {}
        }
    };

    let on_pointer_up_or_cancel = move |ev: web_sys::PointerEvent| {
        let is_cancel = ev.type_() == "pointercancel";
        if is_cancel {
            box_zoom_range.set(None);
        } else if let Some(canvas) = canvas_ref.get() {
            let rect = canvas.get_bounding_client_rect();
            let width = rect.width().max(1.0);
            let height = rect.height().max(1.0);
            let x = ev.client_x() as f64 - rect.left();
            let y = ev.client_y() as f64 - rect.top();
            let mode = drag_mode.get_value();

            if mode == DragMode::BoxZoom {
                if let Some((x0, _)) = box_zoom_range.get_untracked() {
                    let min_px = x0.min(x);
                    let max_px = x0.max(x);
                    if max_px - min_px >= 8.0 {
                        capture.with_untracked(|cap_opt| {
                            if let Some(cap) = cap_opt {
                                let v = view.get_untracked();
                                let s0 = v.start_sample + (min_px / width) * v.visible_samples;
                                let s1 = v.start_sample + (max_px / width) * v.visible_samples;
                                view.set(clamp_view(s0, (s1 - s0).max(4.0), cap.samples.len()));
                            }
                        });
                    }
                }
                box_zoom_range.set(None);
            } else if mode == DragMode::Pan && !down_pos.get_value().2 && y >= TOP_HEIGHT {
                let ch = y_to_channel(y, height);
                active_channel.set(ch);
                let clicked_sample = x_to_sample(x, width);
                let hit = decoded_frames.with_untracked(|frames| {
                    frames
                        .iter()
                        .find(|f| {
                            (f.channel == ch || f.secondary_channel == Some(ch))
                                && clicked_sample >= f.start_sample
                                && clicked_sample <= f.end_sample
                        })
                        .cloned()
                });
                if let Some(hit) = hit {
                    on_select_frame.run(hit);
                }
            }
        }

        let mut remaining = 0usize;
        gesture_tracker.update_value(|gt| {
            gt.pointer_up(ev.pointer_id());
            remaining = gt.active_count();
        });
        snap_marker.set(None);

        if drag_mode.get_value() == DragMode::Pinch && remaining == 1 {
            drag_mode.set_value(DragMode::Pan);
            return;
        }
        if remaining == 0 {
            drag_mode.set_value(DragMode::None);
        }
    };

    view! {
        <div class="waveform-pane">
            <canvas
                node_ref=canvas_ref
                class="waveform-canvas"
                on:wheel=on_wheel
                on:pointerdown=on_pointer_down
                on:pointermove=on_pointer_move
                on:pointerup=on_pointer_up_or_cancel
                on:pointercancel=on_pointer_up_or_cancel
                on:pointerleave=move |_| hover_state.set(None)
            />

            <Show when=move || capture.with(|c| c.is_some())>
                <div class="waveform-overlay-controls">
                    <button
                        type="button"
                        class="overlay-btn"
                        title="Zoom In (+)"
                        on:click=move |_| {
                            let (w, _) = get_canvas_dims();
                            zoom_around_x(0.65, w / 2.0);
                        }
                    >
                        "+"
                    </button>
                    <button
                        type="button"
                        class="overlay-btn"
                        title="Zoom Out (-)"
                        on:click=move |_| {
                            let (w, _) = get_canvas_dims();
                            zoom_around_x(1.5, w / 2.0);
                        }
                    >
                        "−"
                    </button>
                    <button
                        type="button"
                        class="overlay-btn"
                        title="Fit full capture (F)"
                        on:click=move |_| fit_all()
                    >
                        "Fit"
                    </button>
                    <Show when=move || {
                        capture
                            .get()
                            .map(|c| c.triggered || c.auto_triggered || c.trigger_index > 0)
                            .unwrap_or(false)
                    }>
                        <button
                            type="button"
                            class="overlay-btn"
                            title="Center on Trigger (T)"
                            on:click=move |_| jump_to_trigger()
                        >
                            "Trig"
                        </button>
                    </Show>
                    <button
                        type="button"
                        class=move || {
                            if show_cursors.get() { "overlay-btn active" } else { "overlay-btn" }
                        }
                        title="Toggle Measurement Cursors (C) — hold Alt to disable edge snap"
                        on:click=move |_| show_cursors.update(|v| *v = !*v)
                    >
                        "Cursors"
                    </button>
                </div>
            </Show>

            {move || {
                capture.get()?;
                let h = hover_state.get()?;
                let m = h.measurement?;
                let labels = channel_labels.get();
                let ch_name = {
                    let trimmed = labels[h.ch].trim();
                    if trimmed.is_empty() {
                        CHANNELS[h.ch].label.to_string()
                    } else {
                        trimmed.to_string()
                    }
                };
                let color = CHANNELS[h.ch].color;
                Some(view! {
                    <div class="pulse-hud" aria-live="polite">
                        <span class="pulse-hud-ch" style=format!("color: {color}")>{ch_name}</span>
                        <span>{if m.level != 0 { "HIGH" } else { "LOW" }}</span>
                        <span>{format!("W: {}", format_duration(m.width_sec))}</span>
                        {m.period_sec.map(|p| view! { <span>{format!("T: {}", format_duration(p))}</span> })}
                        {m.frequency_hz.map(|f| view! { <span>{format_frequency(f)}</span> })}
                        {m.duty_percent.map(|d| view! { <span>{format!("Duty: {d:.1}%")}</span> })}
                    </div>
                })
            }}

            {move || {
                let cap = capture.get()?;
                let sc = show_cursors.get();
                if !sc && !cap.aborted_early && !cap.auto_triggered {
                    return None;
                }
                let rate_hz = cap.sample_rate_hz.max(1) as f64;
                let a = cursor_a.get();
                let b = cursor_b.get();
                let delta_samples = a.abs_diff(b);
                let delta_sec = (delta_samples as f64) / rate_hz;
                let freq_hz = if delta_sec > 0.0 { 1.0 / delta_sec } else { 0.0 };
                let act_ch = active_channel.get();
                let (rising, falling) = if sc {
                    count_channel_edges(&cap.samples, act_ch, a, b)
                } else {
                    (0, 0)
                };
                let labels = channel_labels.get();
                let act_label = {
                    let trimmed = labels[act_ch].trim();
                    if trimmed.is_empty() {
                        CHANNELS[act_ch].label.to_string()
                    } else {
                        trimmed.to_string()
                    }
                };
                Some(view! {
                    <div class="delta-badge" aria-live="polite">
                        {sc.then(|| {
                            view! {
                                <span class="cursor-a-tag">
                                    {format!(
                                        "A: {}",
                                        format_signed_duration((a as f64 - cap.trigger_index as f64) / rate_hz)
                                    )}
                                </span>
                                <span class="cursor-b-tag">
                                    {format!(
                                        "B: {}",
                                        format_signed_duration((b as f64 - cap.trigger_index as f64) / rate_hz)
                                    )}
                                </span>
                                <span class="delta-tag">
                                    {format!(
                                        "Δt: {} ({})",
                                        format_duration(delta_sec),
                                        if freq_hz > 0.0 { format_frequency(freq_hz) } else { "∞".to_string() }
                                    )}
                                </span>
                                <span
                                    class="edge-count-tag"
                                    title=format!("Edges on {act_label} between A and B")
                                >
                                    {format!("{act_label}: ↑{rising} ↓{falling}")}
                                </span>
                            }
                        })}
                        {cap.aborted_early.then(|| view! { <span class="flag-tag flag-warn">"ABORTED"</span> })}
                        {cap.auto_triggered.then(|| view! { <span class="flag-tag flag-muted">"AUTO-TRIG"</span> })}
                    </div>
                })
            }}
        </div>
    }
}
