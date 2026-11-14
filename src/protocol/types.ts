export const PROTOCOL_SYNC_0 = 0xaa;
export const PROTOCOL_SYNC_1 = 0x55;
export const MAX_FRAME_PAYLOAD_LEN = 32776; // 8-byte header + 32,768 samples

export const CMD_PING_STATUS = 0x01;
export const CMD_GET_CAPS = 0x02;
export const CMD_PIN_FORCE = 0x10;
export const CMD_BATCH_FORCE = 0x11;
export const CMD_LA_CAPTURE = 0x20;
export const CMD_LA_ABORT = 0x21;
export const CMD_BOOTLOADER = 0xf0;

export const TYPE_STATUS_TELEMETRY = 0x81;
export const TYPE_LA_CAPTURE_DATA = 0x82;
export const TYPE_BOARD_CAPABILITIES = 0x83;

export const LA_FLAG_TRIGGERED = 0x0001;
export const LA_FLAG_AUTO_TIMEOUT = 0x0002;
export const LA_FLAG_ABORTED_EARLY = 0x0004;

export type PinForceMode = 0 | 1 | 2; // 0 = Z, 1 = Force 0, 2 = Force 1
export type PinPullMode = 0 | 1 | 2; // 0 = None, 1 = Pull-Up, 2 = Pull-Down
export type TriggerEdge = 0 | 1 | 2; // 0 = Falling, 1 = Rising, 2 = Any
export type PreTriggerRatio = 0 | 1 | 2; // 0 = 0%, 1 = 25%, 2 = 50%

export interface ChannelDescriptor {
  ch: number;
  label: string;
  gpio: number;
  color: string;
}

export const CHANNELS: readonly ChannelDescriptor[] = [
  { ch: 0, label: 'D0', gpio: 1, color: '#58A6FF' },
  { ch: 1, label: 'D1', gpio: 2, color: '#3FB950' },
  { ch: 2, label: 'D2', gpio: 3, color: '#D29922' },
  { ch: 3, label: 'D3', gpio: 4, color: '#F778BA' },
  { ch: 4, label: 'D4', gpio: 5, color: '#A371F7' },
  { ch: 5, label: 'D5', gpio: 6, color: '#39C5CF' },
  { ch: 6, label: 'D6', gpio: 43, color: '#FFA657' },
  { ch: 7, label: 'D7', gpio: 44, color: '#FF7B72' },
] as const;

export interface RatePreset {
  id: number;
  label: string;
  hz: number;
  isLowSpeed: boolean;
}

export const RATE_PRESETS: readonly RatePreset[] = [
  { id: 0, label: '1 kHz', hz: 1_000, isLowSpeed: true },
  { id: 1, label: '10 kHz', hz: 10_000, isLowSpeed: true },
  { id: 2, label: '50 kHz', hz: 50_000, isLowSpeed: true },
  { id: 3, label: '100 kHz', hz: 100_000, isLowSpeed: false },
  { id: 4, label: '250 kHz', hz: 250_000, isLowSpeed: false },
  { id: 5, label: '500 kHz', hz: 500_000, isLowSpeed: false },
  { id: 6, label: '1 MHz', hz: 1_000_000, isLowSpeed: false },
  { id: 7, label: '2 MHz', hz: 2_000_000, isLowSpeed: false },
  { id: 8, label: '5 MHz', hz: 5_000_000, isLowSpeed: false },
  { id: 9, label: '10 MHz', hz: 10_000_000, isLowSpeed: false },
  { id: 10, label: '20 MHz', hz: 20_000_000, isLowSpeed: false },
] as const;

export interface DepthPreset {
  blocksKb: number;
  label: string;
  samples: number;
}

export const DEPTH_PRESETS: readonly DepthPreset[] = [
  { blocksKb: 1, label: '1k', samples: 1024 },
  { blocksKb: 4, label: '4k', samples: 4096 },
  { blocksKb: 8, label: '8k', samples: 8192 },
  { blocksKb: 16, label: '16k', samples: 16384 },
  { blocksKb: 32, label: '32k', samples: 32768 },
] as const;

export interface StatusTelemetry {
  physicalLevels: number;
  forceEnableMask: number;
  forcedLevels: number;
  contentionMask: number;
}

export interface CaptureDataFrame {
  sampleRateHz: number;
  triggerIndex: number;
  flags: number;
  triggered: boolean;
  autoTriggered: boolean;
  abortedEarly: boolean;
  samples: Uint8Array;
}

export interface BoardCapabilities {
  board: string;
  firmware?: string;
  channels: number;
  maxRateHz: number;
  maxDepth: number;
  pins: Array<{ ch: number; label: string; gpio: number }>;
}

export type DecodedPacket =
  | { typeId: typeof TYPE_STATUS_TELEMETRY; telemetry: StatusTelemetry }
  | { typeId: typeof TYPE_LA_CAPTURE_DATA; capture: CaptureDataFrame }
  | { typeId: typeof TYPE_BOARD_CAPABILITIES; capabilities: BoardCapabilities };
