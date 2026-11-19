use std::cell::RefCell;
use std::rc::Rc;

use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::spawn_local;

use crate::protocol::codec::{build_get_caps_cmd, build_ping_status_cmd};
use crate::transport::demo::{DemoAction, DemoSimulator};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportKind {
    None,
    WebSerial,
    WebUsb,
    Demo,
}

impl TransportKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            TransportKind::None => "none",
            TransportKind::WebSerial => "webserial",
            TransportKind::WebUsb => "webusb",
            TransportKind::Demo => "demo",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionStatus {
    Waiting,
    Connecting,
    Connected,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportSnapshot {
    pub status: ConnectionStatus,
    pub transport: TransportKind,
    pub device_name: String,
    pub vid_pid: String,
    pub error_message: Option<String>,
}

impl Default for TransportSnapshot {
    fn default() -> Self {
        Self {
            status: ConnectionStatus::Waiting,
            transport: TransportKind::None,
            device_name: "Waiting for USB...".to_string(),
            vid_pid: String::new(),
            error_message: None,
        }
    }
}

#[wasm_bindgen(module = "/js/web_serial_bridge.js")]
extern "C" {
    fn js_init_transport(on_state: &js_sys::Function, on_bytes: &js_sys::Function, init_cmds: &[u8]);
    fn js_connect_usb(init_cmds: &[u8]) -> js_sys::Promise;
    fn js_disconnect_usb() -> js_sys::Promise;
    fn js_write_bytes(bytes: &[u8]) -> js_sys::Promise;
    fn js_flash_firmware(
        target_board: &str,
        force_other_port: bool,
        flash_offset: &str,
        custom_file: Option<&web_sys::File>,
        init_cmds: &[u8],
        on_log: &js_sys::Function,
        on_progress: &js_sys::Function,
    ) -> js_sys::Promise;
}

fn init_command_bytes() -> Vec<u8> {
    let mut cmds = Vec::with_capacity(16);
    cmds.extend_from_slice(&build_get_caps_cmd());
    cmds.extend_from_slice(&build_ping_status_cmd());
    cmds
}

type StateCallback = Rc<RefCell<Option<Box<dyn FnMut(TransportSnapshot)>>>>;
type BytesCallback = Rc<RefCell<Option<Box<dyn FnMut(&[u8])>>>>;
type TimerClosureSlot = Rc<RefCell<Option<Closure<dyn FnMut()>>>>;

#[derive(Clone)]
pub struct SerialTransport {
    snapshot: Rc<RefCell<TransportSnapshot>>,
    demo: Rc<RefCell<DemoSimulator>>,
    demo_tel_timer: Rc<RefCell<Option<i32>>>,
    demo_tel_cb: TimerClosureSlot,
    demo_cap_timer: Rc<RefCell<Option<i32>>>,
    demo_cap_cb: TimerClosureSlot,
    on_state: StateCallback,
    on_bytes: BytesCallback,
}

impl Default for SerialTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl SerialTransport {
    pub fn new() -> Self {
        Self {
            snapshot: Rc::new(RefCell::new(TransportSnapshot::default())),
            demo: Rc::new(RefCell::new(DemoSimulator::new())),
            demo_tel_timer: Rc::new(RefCell::new(None)),
            demo_tel_cb: Rc::new(RefCell::new(None)),
            demo_cap_timer: Rc::new(RefCell::new(None)),
            demo_cap_cb: Rc::new(RefCell::new(None)),
            on_state: Rc::new(RefCell::new(None)),
            on_bytes: Rc::new(RefCell::new(None)),
        }
    }

    pub fn snapshot(&self) -> TransportSnapshot {
        self.snapshot.borrow().clone()
    }

    pub fn init<FS, FB>(&self, on_state: FS, on_bytes: FB)
    where
        FS: FnMut(TransportSnapshot) + 'static,
        FB: FnMut(&[u8]) + 'static,
    {
        *self.on_state.borrow_mut() = Some(Box::new(on_state));
        *self.on_bytes.borrow_mut() = Some(Box::new(on_bytes));

        let snap_ref = self.snapshot.clone();
        let on_state_ref = self.on_state.clone();
        let js_state_cb = Closure::<dyn FnMut(String, String, String, String, String)>::new(
            move |status_s: String,
                  transport_s: String,
                  device_name: String,
                  vid_pid: String,
                  error_s: String| {
                let status = match status_s.as_str() {
                    "connected" => ConnectionStatus::Connected,
                    "connecting" => ConnectionStatus::Connecting,
                    _ => ConnectionStatus::Waiting,
                };
                let transport = match transport_s.as_str() {
                    "webserial" => TransportKind::WebSerial,
                    "webusb" => TransportKind::WebUsb,
                    "demo" => TransportKind::Demo,
                    _ => TransportKind::None,
                };
                let snap = TransportSnapshot {
                    status,
                    transport,
                    device_name,
                    vid_pid,
                    error_message: if error_s.is_empty() { None } else { Some(error_s) },
                };
                *snap_ref.borrow_mut() = snap.clone();
                if let Some(cb) = on_state_ref.borrow_mut().as_mut() {
                    cb(snap);
                }
            },
        );

        let on_bytes_ref = self.on_bytes.clone();
        let js_bytes_cb =
            Closure::<dyn FnMut(js_sys::Uint8Array)>::new(move |arr: js_sys::Uint8Array| {
                let data = arr.to_vec();
                if let Some(cb) = on_bytes_ref.borrow_mut().as_mut() {
                    cb(&data);
                }
            });

        let init_cmds = init_command_bytes();
        js_init_transport(
            js_state_cb.as_ref().unchecked_ref(),
            js_bytes_cb.as_ref().unchecked_ref(),
            &init_cmds,
        );

        js_state_cb.forget();
        js_bytes_cb.forget();
    }

    pub fn connect(&self) {
        self.stop_demo_timers();
        let init_cmds = init_command_bytes();
        let promise = js_connect_usb(&init_cmds);
        spawn_local(async move {
            let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
        });
    }

    pub fn disconnect(&self) {
        self.stop_demo_timers();
        let kind = self.snapshot.borrow().transport;
        if kind == TransportKind::Demo {
            let snap = TransportSnapshot::default();
            *self.snapshot.borrow_mut() = snap.clone();
            if let Some(cb) = self.on_state.borrow_mut().as_mut() {
                cb(snap);
            }
            return;
        }
        let promise = js_disconnect_usb();
        spawn_local(async move {
            let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
        });
    }

    pub fn start_demo(&self) {
        self.stop_demo_timers();
        let promise = js_disconnect_usb();
        let this = self.clone();
        spawn_local(async move {
            let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
            this.demo.borrow_mut().reset();
            let snap = TransportSnapshot {
                status: ConnectionStatus::Connected,
                transport: TransportKind::Demo,
                device_name: "HotWire XIAO-ESP32-S3 (Demo)".to_string(),
                vid_pid: "303A:1001".to_string(),
                error_message: None,
            };
            *this.snapshot.borrow_mut() = snap.clone();
            if let Some(cb) = this.on_state.borrow_mut().as_mut() {
                cb(snap);
            }
            let caps = this.demo.borrow().build_caps_frame();
            let tel = this.demo.borrow().build_telemetry_frame();
            this.emit_bytes(&caps);
            this.emit_bytes(&tel);
            this.emit_bytes(
                b"\r\n[Demo] Simulated XIAO-ESP32-S3 ready.\r\nType 'help', 'status', 'pins', or 'short 7'.\r\n",
            );
            this.start_demo_telemetry_timer();
        });
    }

    pub fn write_bytes(&self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let snap = self.snapshot.borrow().clone();
        if snap.status != ConnectionStatus::Connected {
            return;
        }

        if snap.transport == TransportKind::Demo {
            let (outputs, action) = self.demo.borrow_mut().handle_tx(bytes);
            for chunk in outputs {
                self.emit_bytes(&chunk);
            }
            if let Some(act) = action {
                match act {
                    DemoAction::ScheduleCapture { duration_ms } => {
                        self.schedule_demo_capture(duration_ms);
                    }
                    DemoAction::AbortCapture => {
                        self.clear_demo_capture_timer();
                        if let Some(frame) = self.demo.borrow_mut().finish_capture(true) {
                            self.emit_bytes(&frame);
                        }
                    }
                    DemoAction::ScheduleShortSim { pin } => {
                        let this = self.clone();
                        let cb = Closure::once(move || {
                            if this.snapshot.borrow().transport != TransportKind::Demo {
                                return;
                            }
                            let outs = this.demo.borrow_mut().trigger_short_sim(pin);
                            for c in outs {
                                this.emit_bytes(&c);
                            }
                        });
                        if let Some(win) = web_sys::window() {
                            let _ = win.set_timeout_with_callback_and_timeout_and_arguments_0(
                                cb.as_ref().unchecked_ref(),
                                25,
                            );
                        }
                        cb.forget();
                    }
                }
            }
            return;
        }

        let promise = js_write_bytes(bytes);
        spawn_local(async move {
            let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
        });
    }

    pub async fn flash_firmware(
        &self,
        target_board: &str,
        force_other_port: bool,
        flash_offset: &str,
        custom_file: Option<&web_sys::File>,
        on_log: impl FnMut(String) + 'static,
        on_progress: impl FnMut(u32) + 'static,
    ) -> Result<(), String> {
        self.stop_demo_timers();
        let init_cmds = init_command_bytes();
        let log_cb = Closure::<dyn FnMut(String)>::new(on_log);
        let prog_cb = Closure::<dyn FnMut(u32)>::new(on_progress);

        let promise = js_flash_firmware(
            target_board,
            force_other_port,
            flash_offset,
            custom_file,
            &init_cmds,
            log_cb.as_ref().unchecked_ref(),
            prog_cb.as_ref().unchecked_ref(),
        );

        let res = wasm_bindgen_futures::JsFuture::from(promise).await;
        drop(log_cb);
        drop(prog_cb);

        match res {
            Ok(_) => Ok(()),
            Err(err) => {
                let msg = err
                    .as_string()
                    .or_else(|| {
                        js_sys::Reflect::get(&err, &JsValue::from_str("message"))
                            .ok()
                            .and_then(|v| v.as_string())
                    })
                    .unwrap_or_else(|| format!("{err:?}"));
                Err(msg)
            }
        }
    }

    fn emit_bytes(&self, bytes: &[u8]) {
        if let Some(cb) = self.on_bytes.borrow_mut().as_mut() {
            cb(bytes);
        }
    }

    fn start_demo_telemetry_timer(&self) {
        self.stop_demo_timers();
        let this = self.clone();
        let cb = Closure::<dyn FnMut()>::new(move || {
            let frame = this.demo.borrow_mut().tick_telemetry();
            this.emit_bytes(&frame);
        });
        if let Some(win) = web_sys::window() {
            if let Ok(id) = win.set_interval_with_callback_and_timeout_and_arguments_0(
                cb.as_ref().unchecked_ref(),
                40, // 25 Hz telemetry
            ) {
                *self.demo_tel_timer.borrow_mut() = Some(id);
                *self.demo_tel_cb.borrow_mut() = Some(cb);
            }
        }
    }

    fn schedule_demo_capture(&self, duration_ms: u32) {
        self.clear_demo_capture_timer();
        let this = self.clone();
        let cb = Closure::<dyn FnMut()>::new(move || {
            *this.demo_cap_timer.borrow_mut() = None;
            if let Some(frame) = this.demo.borrow_mut().finish_capture(false) {
                this.emit_bytes(&frame);
            }
        });
        if let Some(win) = web_sys::window() {
            if let Ok(id) = win.set_timeout_with_callback_and_timeout_and_arguments_0(
                cb.as_ref().unchecked_ref(),
                duration_ms as i32,
            ) {
                *self.demo_cap_timer.borrow_mut() = Some(id);
                *self.demo_cap_cb.borrow_mut() = Some(cb);
            }
        }
    }

    fn clear_demo_capture_timer(&self) {
        if let Some(id) = self.demo_cap_timer.borrow_mut().take() {
            if let Some(win) = web_sys::window() {
                win.clear_timeout_with_handle(id);
            }
        }
        *self.demo_cap_cb.borrow_mut() = None;
    }

    fn stop_demo_timers(&self) {
        if let Some(id) = self.demo_tel_timer.borrow_mut().take() {
            if let Some(win) = web_sys::window() {
                win.clear_interval_with_handle(id);
            }
        }
        *self.demo_tel_cb.borrow_mut() = None;
        self.clear_demo_capture_timer();
    }
}
