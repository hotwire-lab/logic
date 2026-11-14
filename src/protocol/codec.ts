import {
  BoardCapabilities,
  CMD_BATCH_FORCE,
  CMD_BOOTLOADER,
  CMD_GET_CAPS,
  CMD_LA_ABORT,
  CMD_LA_CAPTURE,
  CMD_PING_STATUS,
  CMD_PIN_FORCE,
  CMD_SIG_GEN,
  CaptureDataFrame,
  DecodedPacket,
  LA_FLAG_ABORTED_EARLY,
  LA_FLAG_AUTO_TIMEOUT,
  LA_FLAG_TRIGGERED,
  PROTOCOL_SYNC_0,
  PROTOCOL_SYNC_1,
  PinForceMode,
  PinPullMode,
  PreTriggerRatio,
  SignalGenMode,
  StatusTelemetry,
  TYPE_BOARD_CAPABILITIES,
  TYPE_LA_CAPTURE_DATA,
  TYPE_STATUS_TELEMETRY,
  TriggerEdge,
} from './types';

export function computeXorChecksum(bytes: Uint8Array, length = bytes.byteLength): number {
  let xor = 0;
  for (let i = 0; i < length; i++) {
    xor ^= bytes[i];
  }
  return xor & 0xff;
}

export function buildCommandFrame(
  cmdId: number,
  p1 = 0,
  p2 = 0,
  p3 = 0,
  p4 = 0
): Uint8Array {
  const frame = new Uint8Array(8);
  frame[0] = PROTOCOL_SYNC_0;
  frame[1] = PROTOCOL_SYNC_1;
  frame[2] = cmdId & 0xff;
  frame[3] = p1 & 0xff;
  frame[4] = p2 & 0xff;
  frame[5] = p3 & 0xff;
  frame[6] = p4 & 0xff;
  frame[7] = computeXorChecksum(frame, 7);
  return frame;
}

export function buildPingStatusCmd(): Uint8Array {
  return buildCommandFrame(CMD_PING_STATUS);
}

export function buildGetCapsCmd(): Uint8Array {
  return buildCommandFrame(CMD_GET_CAPS);
}

export function buildPinForceCmd(
  channel: number,
  mode: PinForceMode,
  pull: PinPullMode = 0,
  protect = true
): Uint8Array {
  return buildCommandFrame(
    CMD_PIN_FORCE,
    channel & 0xff,
    mode & 0xff,
    pull & 0xff,
    protect ? 1 : 0
  );
}

export function buildReleaseAllCmd(): Uint8Array {
  return buildPinForceCmd(0xff, 0, 0, true);
}

export function buildBatchForceCmd(
  forceEnableMask: number,
  forcedLevelMask: number,
  pullupMask: number
): Uint8Array {
  return buildCommandFrame(
    CMD_BATCH_FORCE,
    forceEnableMask & 0xff,
    forcedLevelMask & 0xff,
    pullupMask & 0xff,
    0x00
  );
}

export function buildSigGenCmd(mode: SignalGenMode): Uint8Array {
  return buildCommandFrame(CMD_SIG_GEN, mode & 0xff, 0x00, 0x00, 0x00);
}

export function encodeTriggerConfig(edge: TriggerEdge, preTrigger: PreTriggerRatio): number {
  return (edge & 0x03) | ((preTrigger & 0x03) << 4);
}

export function buildLaCaptureCmd(options: {
  rateId: number;
  triggerChannel: number | null;
  edge: TriggerEdge;
  preTrigger: PreTriggerRatio;
  blocksKb: number;
}): Uint8Array {
  const rateId = Math.max(0, Math.min(10, Math.trunc(options.rateId)));
  const trigCh = options.triggerChannel === null ? 0xff : Math.max(0, Math.min(7, options.triggerChannel));
  const trigCfg = encodeTriggerConfig(options.edge, options.preTrigger);
  const blocksKb = Math.max(1, Math.min(32, Math.trunc(options.blocksKb)));
  return buildCommandFrame(CMD_LA_CAPTURE, rateId, trigCh, trigCfg, blocksKb);
}

export function buildLaAbortCmd(): Uint8Array {
  return buildCommandFrame(CMD_LA_ABORT);
}

export function buildBootloaderCmd(): Uint8Array {
  return buildCommandFrame(CMD_BOOTLOADER);
}

export function encodeResponseFrame(typeId: number, payload: Uint8Array): Uint8Array {
  const len = payload.byteLength;
  const frame = new Uint8Array(6 + len);
  frame[0] = PROTOCOL_SYNC_0;
  frame[1] = PROTOCOL_SYNC_1;
  frame[2] = typeId & 0xff;
  frame[3] = len & 0xff;
  frame[4] = (len >> 8) & 0xff;
  frame.set(payload, 5);
  frame[5 + len] = computeXorChecksum(frame, 5 + len);
  return frame;
}

export function decodeStatusTelemetry(payload: Uint8Array): StatusTelemetry | null {
  if (payload.byteLength !== 4) return null;
  return {
    physicalLevels: payload[0],
    forceEnableMask: payload[1],
    forcedLevels: payload[2],
    contentionMask: payload[3],
  };
}

export function decodeCaptureData(payload: Uint8Array): CaptureDataFrame | null {
  if (payload.byteLength < 8) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const sampleRateHz = view.getUint32(0, true);
  const triggerIndex = view.getUint16(4, true);
  const flags = view.getUint16(6, true);
  const samples = payload.slice(8);
  return {
    sampleRateHz,
    triggerIndex,
    flags,
    triggered: (flags & LA_FLAG_TRIGGERED) !== 0,
    autoTriggered: (flags & LA_FLAG_AUTO_TIMEOUT) !== 0,
    abortedEarly: (flags & LA_FLAG_ABORTED_EARLY) !== 0,
    samples,
  };
}

export function decodeBoardCapabilities(payload: Uint8Array): BoardCapabilities | null {
  try {
    const jsonText = new TextDecoder().decode(payload);
    const parsed = JSON.parse(jsonText) as Partial<BoardCapabilities>;
    if (!parsed || typeof parsed.board !== 'string' || typeof parsed.channels !== 'number') {
      return null;
    }
    return {
      board: parsed.board,
      firmware: typeof parsed.firmware === 'string' ? parsed.firmware : undefined,
      channels: parsed.channels,
      maxRateHz: typeof parsed.maxRateHz === 'number' ? parsed.maxRateHz : 20_000_000,
      maxDepth: typeof parsed.maxDepth === 'number' ? parsed.maxDepth : 32768,
      pins: Array.isArray(parsed.pins) ? parsed.pins : [],
    };
  } catch {
    return null;
  }
}

export function decodeResponsePayload(typeId: number, payload: Uint8Array): DecodedPacket | null {
  switch (typeId) {
    case TYPE_STATUS_TELEMETRY: {
      const telemetry = decodeStatusTelemetry(payload);
      return telemetry ? { typeId, telemetry } : null;
    }
    case TYPE_LA_CAPTURE_DATA: {
      const capture = decodeCaptureData(payload);
      return capture ? { typeId, capture } : null;
    }
    case TYPE_BOARD_CAPABILITIES: {
      const capabilities = decodeBoardCapabilities(payload);
      return capabilities ? { typeId, capabilities } : null;
    }
    default:
      return null;
  }
}
