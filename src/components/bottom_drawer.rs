use leptos::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::spawn_local;

use crate::transport::serial::SerialTransport;

#[component]
pub fn BottomDrawer(
    connected: Signal<bool>,
    is_demo: Signal<bool>,
    serial_transport: StoredValue<SerialTransport, LocalStorage>,
) -> impl IntoView {
    let expanded = RwSignal::new(false);

    // Flasher state
    let target_board = RwSignal::new("auto".to_string());
    let show_custom_bin = RwSignal::new(false);
    let selected_file_name = RwSignal::new(None::<String>);
    let selected_file = StoredValue::new_local(None::<web_sys::File>);
    let flash_offset = RwSignal::new("full".to_string());
    let flashing = RwSignal::new(false);
    let flash_progress = RwSignal::new(0u32);
    let flash_logs = RwSignal::new(vec![
        "Ready. Select a .bin image or use the bundled XIAO-ESP32-S3 / XIAO-ESP32-C6 firmware."
            .to_string(),
    ]);

    let start_flash = move |force_prompt: bool| {
        if flashing.get_untracked() {
            return;
        }
        if is_demo.get_untracked() {
            flash_logs.update(|logs| {
                logs.push(
                    "Demo mode active — connect a physical XIAO-ESP32-S3 or XIAO-ESP32-C6 via USB to flash."
                        .to_string(),
                );
            });
            return;
        }

        flashing.set(true);
        flash_progress.set(0);
        flash_logs.set(Vec::new());

        let board = target_board.get_untracked();
        let offset = flash_offset.get_untracked();
        let file = selected_file.get_value();
        let transport = serial_transport.get_value();

        spawn_local(async move {
            let res = transport
                .flash_firmware(
                    &board,
                    force_prompt,
                    &offset,
                    file.as_ref(),
                    move |line| {
                        flash_logs.update(|logs| {
                            logs.push(line);
                            if logs.len() > 80 {
                                let drain = logs.len() - 80;
                                logs.drain(0..drain);
                            }
                        });
                    },
                    move |pct| flash_progress.set(pct),
                )
                .await;

            if let Err(msg) = res {
                flash_logs.update(|logs| logs.push(format!("FLASH ERROR: {msg}")));
            }
            flashing.set(false);
        });
    };

    view! {
        <section class=move || {
            if expanded.get() {
                "bottom-drawer drawer-expanded"
            } else {
                "bottom-drawer drawer-collapsed"
            }
        }>
            <div class="drawer-header">
                <div class="drawer-tabs">
                    <button
                        type="button"
                        class="drawer-tab active"
                        on:click=move |_| expanded.update(|v| *v = !*v)
                    >
                        "⚡ Web Flasher"
                    </button>
                </div>

                <button
                    type="button"
                    class="btn btn-secondary btn-compact"
                    on:click=move |_| expanded.update(|v| *v = !*v)
                >
                    {move || if expanded.get() { "▼ Collapse" } else { "▲ Expand Flasher" }}
                </button>
            </div>

            <div
                class="drawer-body"
                style=move || if expanded.get() { "display: flex" } else { "display: none" }
            >
                <div class="drawer-panel flasher-panel" style="display: flex">
                    <div class="flasher-controls">
                        <label class="ctrl-field">
                            <span class="ctrl-label">"Board"</span>
                            <select
                                aria-label="Target board"
                                class="ctrl-select"
                                prop:value=move || target_board.get()
                                disabled=move || flashing.get()
                                on:change=move |ev| target_board.set(event_target_value(&ev))
                            >
                                <option value="auto">"Auto-Detect (ESP32-S3 / ESP32-C6)"</option>
                                <option value="esp32s3">"Seeed XIAO ESP32-S3 (8MB)"</option>
                                <option value="esp32c6">"Seeed XIAO ESP32-C6 (4MB)"</option>
                            </select>
                        </label>

                        <button
                            type="button"
                            class="btn btn-accent"
                            disabled=move || flashing.get()
                            on:click=move |_| start_flash(false)
                        >
                            {move || {
                                if flashing.get() {
                                    format!("Flashing {}%...", flash_progress.get())
                                } else {
                                    "Flash Firmware".to_string()
                                }
                            }}
                        </button>

                        <Show when=move || connected.get()>
                            <button
                                type="button"
                                class="btn btn-secondary btn-compact"
                                disabled=move || flashing.get()
                                on:click=move |_| start_flash(true)
                            >
                                "Select Other Port..."
                            </button>
                        </Show>

                        <button
                            type="button"
                            class=move || {
                                if show_custom_bin.get() {
                                    "btn btn-secondary btn-compact active"
                                } else {
                                    "btn btn-secondary btn-compact"
                                }
                            }
                            disabled=move || flashing.get()
                            on:click=move |_| {
                                let next = !show_custom_bin.get_untracked();
                                show_custom_bin.set(next);
                                if !next {
                                    selected_file.set_value(None);
                                    selected_file_name.set(None);
                                    flash_offset.set("full".to_string());
                                }
                            }
                        >
                            "Custom .bin..."
                        </button>

                        <Show when=move || show_custom_bin.get()>
                            <label class="ctrl-field">
                                <span class="ctrl-label">"Target Image"</span>
                                <select
                                    class="ctrl-select"
                                    prop:value=move || flash_offset.get()
                                    disabled=move || flashing.get()
                                    on:change=move |ev| flash_offset.set(event_target_value(&ev))
                                >
                                    <option value="full">"Bundled Full Image (Boot + Partitions + App)"</option>
                                    <option value="0x10000">"App Firmware @ 0x10000"</option>
                                    <option value="0x0">"Merged .bin @ 0x0"</option>
                                </select>
                            </label>

                            <label class="file-picker-label">
                                <span>
                                    {move || {
                                        selected_file_name.get().unwrap_or_else(|| {
                                            match target_board.get().as_str() {
                                                "esp32s3" => "Choose .bin (HotWire_XIAO_ESP32S3.ino)".to_string(),
                                                "esp32c6" => "Choose .bin (HotWire_XIAO_ESP32C6.ino)".to_string(),
                                                _ => "Choose .bin file...".to_string(),
                                            }
                                        })
                                    }}
                                </span>
                                <input
                                    type="file"
                                    accept=".bin"
                                    disabled=move || flashing.get()
                                    on:change=move |ev| {
                                        let input = ev
                                            .target()
                                            .and_then(|t| t.dyn_into::<web_sys::HtmlInputElement>().ok());
                                        let file = input
                                            .and_then(|i| i.files())
                                            .and_then(|fl| fl.get(0));
                                        if let Some(f) = file {
                                            selected_file_name.set(Some(f.name()));
                                            selected_file.set_value(Some(f));
                                            if flash_offset.get_untracked() == "full" {
                                                flash_offset.set("0x10000".to_string());
                                            }
                                        } else {
                                            selected_file_name.set(None);
                                            selected_file.set_value(None);
                                        }
                                    }
                                />
                            </label>

                            <Show when=move || selected_file_name.get().is_some()>
                                <button
                                    type="button"
                                    class="btn btn-secondary btn-compact"
                                    disabled=move || flashing.get()
                                    on:click=move |_| {
                                        selected_file.set_value(None);
                                        selected_file_name.set(None);
                                    }
                                >
                                    "Use Bundled"
                                </button>
                            </Show>
                        </Show>
                    </div>

                    <div class="flash-progress-track" aria-label="Flashing progress">
                        <div
                            class="flash-progress-fill"
                            style=move || format!("width: {}%", flash_progress.get())
                        />
                    </div>

                    <pre class="flash-log-box">{move || flash_logs.get().join("\n")}</pre>
                </div>
            </div>
        </section>
    }
}
