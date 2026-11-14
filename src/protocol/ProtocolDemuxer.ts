import { computeXorChecksum, decodeResponsePayload } from './codec';
import {
  DecodedPacket,
  MAX_FRAME_PAYLOAD_LEN,
  PROTOCOL_SYNC_0,
  PROTOCOL_SYNC_1,
  TYPE_BOARD_CAPABILITIES,
  TYPE_LA_CAPTURE_DATA,
  TYPE_STATUS_TELEMETRY,
} from './types';

function isValidFrameType(typeId: number): boolean {
  return (
    typeId === TYPE_STATUS_TELEMETRY ||
    typeId === TYPE_LA_CAPTURE_DATA ||
    typeId === TYPE_BOARD_CAPABILITIES
  );
}

function isValidLengthForType(typeId: number, len: number): boolean {
  if (len > MAX_FRAME_PAYLOAD_LEN) return false;
  if (typeId === TYPE_STATUS_TELEMETRY) return len === 4;
  if (typeId === TYPE_LA_CAPTURE_DATA) return len >= 8;
  if (typeId === TYPE_BOARD_CAPABILITIES) return len >= 2 && len <= 4096;
  return false;
}

export interface DemuxerCallbacks {
  onPacket: (packet: DecodedPacket) => void;
  onText: (bytes: Uint8Array) => void;
}

/**
 * Streaming binary/UTF-8 demultiplexer for the single USB CDC stream.
 * Scans for [0xAA, 0x55], validates frame type, length <= 32776, and trailing XOR checksum.
 * Valid binary frames go to onPacket; plain UTF-8 bytes and failed candidates flush to onText.
 */
export class ProtocolDemuxer {
  private buffer = new Uint8Array(0);
  private readonly callbacks: DemuxerCallbacks;

  constructor(callbacks: DemuxerCallbacks) {
    this.callbacks = callbacks;
  }

  reset(): void {
    this.buffer = new Uint8Array(0);
  }

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;

    const combined = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    combined.set(this.buffer, 0);
    combined.set(chunk, this.buffer.byteLength);

    let cursor = 0;
    const textChunks: Uint8Array[] = [];

    const flushTextRange = (start: number, end: number) => {
      if (end > start) {
        textChunks.push(combined.subarray(start, end));
      }
    };

    let textStart = 0;

    while (cursor < combined.byteLength) {
      if (combined[cursor] !== PROTOCOL_SYNC_0) {
        cursor += 1;
        continue;
      }

      // Need at least 2 bytes to check sync pair [0xAA, 0x55]
      if (cursor + 1 >= combined.byteLength) {
        break;
      }

      if (combined[cursor + 1] !== PROTOCOL_SYNC_1) {
        cursor += 1;
        continue;
      }

      // Need 5-byte header [0xAA, 0x55, TYPE_ID, LEN_L, LEN_H]
      if (cursor + 5 > combined.byteLength) {
        break;
      }

      const typeId = combined[cursor + 2];
      const payloadLen = combined[cursor + 3] | (combined[cursor + 4] << 8);

      if (!isValidFrameType(typeId) || !isValidLengthForType(typeId, payloadLen)) {
        // False sync header: advance by 1 byte so text byte 0xAA flushes and inner 0xAA 0x55 can still sync
        cursor += 1;
        continue;
      }

      const totalFrameLen = 6 + payloadLen; // 5 header + payload + 1 XOR
      if (cursor + totalFrameLen > combined.byteLength) {
        // Incomplete frame; wait for next USB chunk
        break;
      }

      const frameSlice = combined.subarray(cursor, cursor + totalFrameLen);
      const expectedXor = computeXorChecksum(frameSlice, totalFrameLen - 1);
      const actualXor = frameSlice[totalFrameLen - 1];

      if (expectedXor !== actualXor) {
        // Checksum mismatch: treat leading byte as plain stream data and resume scanning
        cursor += 1;
        continue;
      }

      const payload = frameSlice.subarray(5, 5 + payloadLen);
      const decoded = decodeResponsePayload(typeId, payload);
      if (!decoded) {
        cursor += 1;
        continue;
      }

      // Flush any plain text preceding this valid binary packet
      flushTextRange(textStart, cursor);
      this.emitTextChunks(textChunks);
      textChunks.length = 0;

      this.callbacks.onPacket(decoded);
      cursor += totalFrameLen;
      textStart = cursor;
    }

    // Flush confirmed plain-text bytes up to cursor (leaving any incomplete candidate in buffer)
    flushTextRange(textStart, cursor);
    this.emitTextChunks(textChunks);

    this.buffer = cursor < combined.byteLength ? combined.slice(cursor) : new Uint8Array(0);
  }

  private emitTextChunks(chunks: Uint8Array[]): void {
    if (chunks.length === 0) return;
    if (chunks.length === 1) {
      this.callbacks.onText(chunks[0].slice());
      return;
    }
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const merged = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) {
      merged.set(c, pos);
      pos += c.byteLength;
    }
    this.callbacks.onText(merged);
  }
}
