pub use hotwire_core::protocol::{
    BoardIdentity, CMD_BOOTLOADER, CMD_GET_CAPS, CMD_PING_STATUS, PROTOCOL_SYNC_0,
    PROTOCOL_SYNC_1, TYPE_BOARD_CAPABILITIES,
};
use serde::Deserialize;

pub const MAX_FRAME_PAYLOAD_LEN: usize = 32776; // 8-byte header + 32,768 samples

pub const CMD_PIN_FORCE: u8 = 0x10;
pub const CMD_BATCH_FORCE: u8 = 0x11;
pub const CMD_SIG_GEN: u8 = 0x12;
pub const CMD_LA_CAPTURE: u8 = 0x20;
pub const CMD_LA_ABORT: u8 = 0x21;

pub const TYPE_STATUS_TELEMETRY: u8 = 0x81;
pub const TYPE_LA_CAPTURE_DATA: u8 = 0x82;

pub const LA_FLAG_TRIGGERED: u16 = 0x0001;
pub const LA_FLAG_AUTO_TIMEOUT: u16 = 0x0002;
pub const LA_FLAG_ABORTED_EARLY: u16 = 0x0004;

/// 0 = Z, 1 = Force 0, 2 = Force 1
pub type PinForceMode = u8;
/// 0 = None, 1 = Pull-Up, 2 = Pull-Down
pub type PinPullMode = u8;
/// 0 = Falling, 1 = Rising, 2 = Any
pub type TriggerEdge = u8;
/// 0 = 0%, 1 = 25%, 2 = 50%, 3 = 75%
pub type PreTriggerRatio = u8;
/// 0 = Off, 1 = Counter/PWM, 2 = UART 115200, 3 = SPI Burst, 4 = I2C 0x3C
pub type SignalGenMode = u8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChannelDescriptor {
    pub ch: usize,
    pub label: &'static str,
    pub gpio: u8,
    pub color: &'static str,
}

pub const CHANNELS: [ChannelDescriptor; 8] = [
    ChannelDescriptor { ch: 0, label: "D0", gpio: 1, color: "#58A6FF" },
    ChannelDescriptor { ch: 1, label: "D1", gpio: 2, color: "#3FB950" },
    ChannelDescriptor { ch: 2, label: "D2", gpio: 3, color: "#D29922" },
    ChannelDescriptor { ch: 3, label: "D3", gpio: 4, color: "#F778BA" },
    ChannelDescriptor { ch: 4, label: "D4", gpio: 5, color: "#A371F7" },
    ChannelDescriptor { ch: 5, label: "D5", gpio: 6, color: "#39C5CF" },
    ChannelDescriptor { ch: 6, label: "D6", gpio: 43, color: "#FFA657" },
    ChannelDescriptor { ch: 7, label: "D7", gpio: 44, color: "#FF7B72" },
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RatePreset {
    pub id: u8,
    pub label: &'static str,
    pub hz: u32,
}

pub const RATE_PRESETS: [RatePreset; 11] = [
    RatePreset { id: 0, label: "1 kHz", hz: 1_000 },
    RatePreset { id: 1, label: "10 kHz", hz: 10_000 },
    RatePreset { id: 2, label: "50 kHz", hz: 50_000 },
    RatePreset { id: 3, label: "100 kHz", hz: 100_000 },
    RatePreset { id: 4, label: "250 kHz", hz: 250_000 },
    RatePreset { id: 5, label: "500 kHz", hz: 500_000 },
    RatePreset { id: 6, label: "1 MHz", hz: 1_000_000 },
    RatePreset { id: 7, label: "2 MHz", hz: 2_000_000 },
    RatePreset { id: 8, label: "5 MHz", hz: 5_000_000 },
    RatePreset { id: 9, label: "10 MHz", hz: 10_000_000 },
    RatePreset { id: 10, label: "20 MHz", hz: 20_000_000 },
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DepthPreset {
    pub blocks_kb: u8,
    pub label: &'static str,
}

pub const DEPTH_PRESETS: [DepthPreset; 5] = [
    DepthPreset { blocks_kb: 1, label: "1k" },
    DepthPreset { blocks_kb: 4, label: "4k" },
    DepthPreset { blocks_kb: 8, label: "8k" },
    DepthPreset { blocks_kb: 16, label: "16k" },
    DepthPreset { blocks_kb: 32, label: "32k" },
];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StatusTelemetry {
    pub physical_levels: u8,
    pub force_enable_mask: u8,
    pub forced_levels: u8,
    pub contention_mask: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureDataFrame {
    pub sample_rate_hz: u32,
    pub trigger_index: usize,
    pub flags: u16,
    pub triggered: bool,
    pub auto_triggered: bool,
    pub aborted_early: bool,
    pub samples: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct BoardPinMapping {
    pub ch: usize,
    pub label: String,
    pub gpio: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoardCapabilities {
    pub board: String,
    pub firmware: Option<String>,
    pub channels: usize,
    pub max_rate_hz: u32,
    pub max_depth: usize,
    pub pins: Vec<BoardPinMapping>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DecodedPacket {
    StatusTelemetry(StatusTelemetry),
    LaCaptureData(CaptureDataFrame),
    BoardCapabilities(BoardIdentity, BoardCapabilities),
}
