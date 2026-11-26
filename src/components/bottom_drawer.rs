use hotwire_core::flasher::{FirmwareProfile, FlasherPanel};
use hotwire_core::protocol::{BoardIdentity, FirmwareMismatch, ToolId};
use hotwire_core::ui::BottomSheet;
use leptos::prelude::*;

use crate::transport::serial::SerialTransport;

fn logic_firmware_profiles() -> Vec<FirmwareProfile> {
    FirmwareProfile::standard_profiles(ToolId::LogicAnalyzer)
}

#[component]
pub fn BottomDrawer(
    open: RwSignal<bool>,
    on_close: Callback<()>,
    identity: RwSignal<Option<BoardIdentity>>,
    mismatch: RwSignal<Option<FirmwareMismatch>>,
    serial_transport: StoredValue<SerialTransport, LocalStorage>,
) -> impl IntoView {
    view! {
        <BottomSheet
            open=open
            on_close=on_close
            title="⚡ Logic Analyzer Web Flasher & Pinout"
        >
            <div class="drawer-col">
                <h4>"Web Flasher"</h4>
                <FlasherPanel
                    profiles=logic_firmware_profiles()
                    transport=serial_transport
                    expected_tool=ToolId::LogicAnalyzer
                    identity=identity
                    mismatch=mismatch
                />
            </div>

            <div class="drawer-col">
                <h4>"8-Channel Pin Mapping (3.3 V Logic)"</h4>
                <p class="hw-flash-hint">
                    "XIAO ESP32-S3: D0–D5 → GPIO1–6, D6–D7 → GPIO43–44. XIAO ESP32-C6: D0–D2 → GPIO0–2, D3–D5 → GPIO21–23, D6–D7 → GPIO16–17. Internal USB pins are never touched."
                </p>
                <p class="hw-flash-hint">
                    "Tri-State Force I/O includes automatic 20 ms bus contention auto-cutoff (SHORT!) to protect external drivers."
                </p>
            </div>
        </BottomSheet>
    }
}
