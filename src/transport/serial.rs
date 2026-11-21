pub use hotwire_core::transport::{
    HotWireTransport as SerialTransport, SerialConfig, TransportSnapshot,
};

use hotwire_core::transport::DemoBackend;

use crate::protocol::codec::{
    build_bootloader_cmd, build_get_caps_cmd, build_la_abort_cmd, build_ping_status_cmd,
};
use crate::transport::demo::{DemoAction, DemoSimulator};

struct LaDemoAdapter {
    sim: DemoSimulator,
    capture_ticks_left: Option<u32>,
    short_ticks_left: Option<(u32, u8)>,
}

impl LaDemoAdapter {
    fn new() -> Self {
        Self {
            sim: DemoSimulator::new(),
            capture_ticks_left: None,
            short_ticks_left: None,
        }
    }
}

impl DemoBackend for LaDemoAdapter {
    fn device_name(&self) -> &str {
        "XIAO-ESP32-S3 (Demo)"
    }

    fn vid_pid(&self) -> &str {
        "DEMO:0000"
    }

    fn tick_interval_ms(&self) -> Option<i32> {
        Some(40) // 25 Hz telemetry
    }

    fn on_start(&mut self) -> Vec<u8> {
        self.sim.reset();
        self.capture_ticks_left = None;
        self.short_ticks_left = None;
        Vec::new()
    }

    fn handle_command(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        // Process 8-byte binary commands sequentially (init sends 2 concatenated commands)
        let mut pos = 0;
        while pos + 8 <= bytes.len() && bytes[pos] == 0xaa && bytes[pos + 1] == 0x55 {
            let (chunks, action) = self.sim.handle_tx(&bytes[pos..pos + 8]);
            for c in chunks {
                out.extend_from_slice(&c);
            }
            self.apply_action(action, &mut out);
            pos += 8;
        }
        if pos < bytes.len() {
            let (chunks, action) = self.sim.handle_tx(&bytes[pos..]);
            for c in chunks {
                out.extend_from_slice(&c);
            }
            self.apply_action(action, &mut out);
        }
        out
    }

    fn tick(&mut self) -> Option<Vec<u8>> {
        let mut out = self.sim.tick_telemetry();

        if let Some(left) = self.capture_ticks_left {
            if left <= 1 {
                self.capture_ticks_left = None;
                if let Some(frame) = self.sim.finish_capture(false) {
                    out.extend_from_slice(&frame);
                }
            } else {
                self.capture_ticks_left = Some(left - 1);
            }
        }

        if let Some((left, pin)) = self.short_ticks_left {
            if left <= 1 {
                self.short_ticks_left = None;
                for c in self.sim.trigger_short_sim(pin) {
                    out.extend_from_slice(&c);
                }
            } else {
                self.short_ticks_left = Some((left - 1, pin));
            }
        }

        Some(out)
    }
}

impl LaDemoAdapter {
    fn apply_action(&mut self, action: Option<DemoAction>, out: &mut Vec<u8>) {
        match action {
            Some(DemoAction::ScheduleCapture { duration_ms }) => {
                let ticks = (duration_ms / 40).max(1);
                self.capture_ticks_left = Some(ticks);
            }
            Some(DemoAction::AbortCapture) => {
                self.capture_ticks_left = None;
                if let Some(frame) = self.sim.finish_capture(true) {
                    out.extend_from_slice(&frame);
                }
            }
            Some(DemoAction::ScheduleShortSim { pin }) => {
                self.short_ticks_left = Some((1, pin));
            }
            None => {}
        }
    }
}

pub fn create_logic_transport() -> SerialTransport {
    let cfg = SerialConfig::hotwire_cdc("hotwire_la_last_device");
    let transport = SerialTransport::with_demo(cfg, LaDemoAdapter::new());

    // Abort any previously armed capture before requesting 0x83 capabilities + telemetry,
    // matching Oscilloscope and SDR reconnect behavior.
    let mut init_cmds = Vec::with_capacity(24);
    init_cmds.extend_from_slice(&build_la_abort_cmd());
    init_cmds.extend_from_slice(&build_get_caps_cmd());
    init_cmds.extend_from_slice(&build_ping_status_cmd());
    transport.set_init_commands(init_cmds);
    transport.set_bootloader_command(build_bootloader_cmd().to_vec());
    transport
}
