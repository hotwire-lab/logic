import { describe, expect, it } from 'vitest';
import { ProtocolDemuxer } from '../protocol/ProtocolDemuxer';
import { encodeResponseFrame } from '../protocol/codec';
import {
  DecodedPacket,
  TYPE_BOARD_CAPABILITIES,
  TYPE_LA_CAPTURE_DATA,
  TYPE_STATUS_TELEMETRY,
} from '../protocol/types';

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((acc, a) => acc + a.byteLength, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of arrays) {
    out.set(a, pos);
    pos += a.byteLength;
  }
  return out;
}

describe('ProtocolDemuxer', () => {
  it('separates mixed UTF-8 logs and valid binary packets across fragmented chunks', () => {
    const packets: DecodedPacket[] = [];
    const textBytes: number[] = [];

    const demux = new ProtocolDemuxer({
      onPacket: (pkt) => packets.push(pkt),
      onText: (bytes) => textBytes.push(...bytes),
    });

    const log1 = new TextEncoder().encode('[HotWire] Boot OK\r\n');
    const tel = encodeResponseFrame(TYPE_STATUS_TELEMETRY, new Uint8Array([0x12, 0x03, 0x01, 0x00]));
    const caps = encodeResponseFrame(
      TYPE_BOARD_CAPABILITIES,
      new TextEncoder().encode('{"board":"XIAO-ESP32-S3","channels":8}')
    );
    const log2 = new TextEncoder().encode('Ready> ');

    const stream = concatBytes(log1, tel, caps, log2);

    // Feed in odd 3-byte fragments to stress header/payload/checksum boundaries
    for (let i = 0; i < stream.byteLength; i += 3) {
      demux.push(stream.subarray(i, Math.min(stream.byteLength, i + 3)));
    }

    expect(packets).toHaveLength(2);
    expect(packets[0]).toEqual({
      typeId: TYPE_STATUS_TELEMETRY,
      telemetry: {
        physicalLevels: 0x12,
        forceEnableMask: 0x03,
        forcedLevels: 0x01,
        contentionMask: 0x00,
      },
    });
    expect(packets[1].typeId).toBe(TYPE_BOARD_CAPABILITIES);
    if (packets[1].typeId === TYPE_BOARD_CAPABILITIES) {
      expect(packets[1].capabilities.board).toBe('XIAO-ESP32-S3');
    }

    const decodedText = new TextDecoder().decode(new Uint8Array(textBytes));
    expect(decodedText).toBe('[HotWire] Boot OK\r\nReady> ');
  });

  it('handles max-depth 32,768-sample LA capture frame (32,776-byte payload)', () => {
    const packets: DecodedPacket[] = [];
    const demux = new ProtocolDemuxer({
      onPacket: (pkt) => packets.push(pkt),
      onText: () => {},
    });

    const payload = new Uint8Array(8 + 32768);
    const dv = new DataView(payload.buffer);
    dv.setUint32(0, 20_000_000, true);
    dv.setUint16(4, 16384, true);
    dv.setUint16(6, 0x0001, true);
    for (let i = 0; i < 32768; i++) {
      payload[8 + i] = i & 0xff;
    }

    const frame = encodeResponseFrame(TYPE_LA_CAPTURE_DATA, payload);
    demux.push(frame.subarray(0, 512));
    demux.push(frame.subarray(512, 16000));
    demux.push(frame.subarray(16000));

    expect(packets).toHaveLength(1);
    const pkt = packets[0];
    expect(pkt.typeId).toBe(TYPE_LA_CAPTURE_DATA);
    if (pkt.typeId === TYPE_LA_CAPTURE_DATA) {
      expect(pkt.capture.sampleRateHz).toBe(20_000_000);
      expect(pkt.capture.triggerIndex).toBe(16384);
      expect(pkt.capture.samples.byteLength).toBe(32768);
      expect(pkt.capture.samples[255]).toBe(255);
    }
  });

  it('flushes invalid checksum or false sync bytes to terminal text and recovers real frames', () => {
    const packets: DecodedPacket[] = [];
    const textBytes: number[] = [];

    const demux = new ProtocolDemuxer({
      onPacket: (pkt) => packets.push(pkt),
      onText: (bytes) => textBytes.push(...bytes),
    });

    // Bad checksum frame + stray 0xAA followed immediately by a valid telemetry frame
    const badTel = encodeResponseFrame(TYPE_STATUS_TELEMETRY, new Uint8Array([1, 2, 3, 4]));
    badTel[badTel.byteLength - 1] ^= 0xff; // corrupt XOR checksum

    const straySync = new Uint8Array([0xaa]);
    const goodTel = encodeResponseFrame(TYPE_STATUS_TELEMETRY, new Uint8Array([0xff, 0x00, 0x00, 0x00]));

    demux.push(concatBytes(badTel, straySync, goodTel));

    expect(packets).toHaveLength(1);
    expect(packets[0]).toEqual({
      typeId: TYPE_STATUS_TELEMETRY,
      telemetry: {
        physicalLevels: 0xff,
        forceEnableMask: 0x00,
        forcedLevels: 0x00,
        contentionMask: 0x00,
      },
    });
    expect(textBytes).toEqual([...badTel, 0xaa]);
  });
});
