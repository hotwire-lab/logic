import { describe, expect, it } from 'vitest';
import {
  buildBatchForceCmd,
  buildBootloaderCmd,
  buildGetCapsCmd,
  buildLaAbortCmd,
  buildLaCaptureCmd,
  buildPingStatusCmd,
  buildPinForceCmd,
  buildReleaseAllCmd,
  computeXorChecksum,
  decodeBoardCapabilities,
  decodeCaptureData,
  decodeStatusTelemetry,
  encodeResponseFrame,
} from '../protocol/codec';
import {
  formatDuration,
  formatFrequency,
  formatResolution,
  formatSignedDuration,
} from '../protocol/timeFormat';
import {
  CMD_BATCH_FORCE,
  CMD_BOOTLOADER,
  CMD_GET_CAPS,
  CMD_LA_ABORT,
  CMD_LA_CAPTURE,
  CMD_PING_STATUS,
  CMD_PIN_FORCE,
  LA_FLAG_ABORTED_EARLY,
  LA_FLAG_AUTO_TIMEOUT,
  LA_FLAG_TRIGGERED,
  PROTOCOL_SYNC_0,
  PROTOCOL_SYNC_1,
  TYPE_BOARD_CAPABILITIES,
  TYPE_LA_CAPTURE_DATA,
  TYPE_STATUS_TELEMETRY,
} from '../protocol/types';

function assertValidCmdXor(frame: Uint8Array): void {
  expect(frame.byteLength).toBe(8);
  expect(frame[0]).toBe(PROTOCOL_SYNC_0);
  expect(frame[1]).toBe(PROTOCOL_SYNC_1);
  expect(frame[7]).toBe(computeXorChecksum(frame, 7));
}

describe('protocol codec', () => {
  it('builds valid 8-byte Host-to-Device command frames with XOR checksum', () => {
    const ping = buildPingStatusCmd();
    assertValidCmdXor(ping);
    expect(ping[2]).toBe(CMD_PING_STATUS);

    const caps = buildGetCapsCmd();
    assertValidCmdXor(caps);
    expect(caps[2]).toBe(CMD_GET_CAPS);

    const force = buildPinForceCmd(6, 2, 1, true);
    assertValidCmdXor(force);
    expect(Array.from(force.subarray(2, 7))).toEqual([CMD_PIN_FORCE, 6, 2, 1, 1]);

    const releaseAll = buildReleaseAllCmd();
    assertValidCmdXor(releaseAll);
    expect(Array.from(releaseAll.subarray(2, 7))).toEqual([CMD_PIN_FORCE, 0xff, 0, 0, 1]);

    const batch = buildBatchForceCmd(0x0f, 0x05, 0xf0);
    assertValidCmdXor(batch);
    expect(Array.from(batch.subarray(2, 7))).toEqual([CMD_BATCH_FORCE, 0x0f, 0x05, 0xf0, 0x00]);

    const laCap = buildLaCaptureCmd({
      rateId: 10,
      triggerChannel: 3,
      edge: 1,
      preTrigger: 2,
      blocksKb: 32,
    });
    assertValidCmdXor(laCap);
    expect(Array.from(laCap.subarray(2, 7))).toEqual([CMD_LA_CAPTURE, 10, 3, 0x21, 32]);

    const laFree = buildLaCaptureCmd({
      rateId: 0,
      triggerChannel: null,
      edge: 0,
      preTrigger: 0,
      blocksKb: 16,
    });
    assertValidCmdXor(laFree);
    expect(Array.from(laFree.subarray(2, 7))).toEqual([CMD_LA_CAPTURE, 0, 0xff, 0x00, 16]);

    const abort = buildLaAbortCmd();
    assertValidCmdXor(abort);
    expect(abort[2]).toBe(CMD_LA_ABORT);

    const boot = buildBootloaderCmd();
    assertValidCmdXor(boot);
    expect(boot[2]).toBe(CMD_BOOTLOADER);
  });

  it('encodes and decodes 0x81 telemetry, 0x82 capture, and 0x83 capabilities', () => {
    const telPayload = new Uint8Array([0b10100101, 0b00001111, 0b00000101, 0b10000000]);
    const telFrame = encodeResponseFrame(TYPE_STATUS_TELEMETRY, telPayload);
    expect(telFrame.byteLength).toBe(10);
    expect(telFrame[telFrame.byteLength - 1]).toBe(computeXorChecksum(telFrame, 9));
    expect(decodeStatusTelemetry(telPayload)).toEqual({
      physicalLevels: 0xa5,
      forceEnableMask: 0x0f,
      forcedLevels: 0x05,
      contentionMask: 0x80,
    });

    const capPayload = new Uint8Array(8 + 4);
    const dv = new DataView(capPayload.buffer);
    dv.setUint32(0, 20_000_000, true);
    dv.setUint16(4, 2, true);
    dv.setUint16(6, LA_FLAG_TRIGGERED | LA_FLAG_ABORTED_EARLY, true);
    capPayload.set([0x01, 0x02, 0x03, 0x04], 8);
    const capFrame = encodeResponseFrame(TYPE_LA_CAPTURE_DATA, capPayload);
    expect(capFrame[2]).toBe(TYPE_LA_CAPTURE_DATA);
    const decodedCap = decodeCaptureData(capPayload);
    expect(decodedCap).not.toBeNull();
    expect(decodedCap!.sampleRateHz).toBe(20_000_000);
    expect(decodedCap!.triggerIndex).toBe(2);
    expect(decodedCap!.triggered).toBe(true);
    expect(decodedCap!.autoTriggered).toBe(false);
    expect(decodedCap!.abortedEarly).toBe(true);
    expect(Array.from(decodedCap!.samples)).toEqual([1, 2, 3, 4]);

    const timeoutPayload = new Uint8Array(8);
    new DataView(timeoutPayload.buffer).setUint16(6, LA_FLAG_AUTO_TIMEOUT, true);
    expect(decodeCaptureData(timeoutPayload)!.autoTriggered).toBe(true);

    const jsonBytes = new TextEncoder().encode(
      JSON.stringify({
        board: 'XIAO-ESP32-S3',
        channels: 8,
        maxRateHz: 20_000_000,
        maxDepth: 32768,
        pins: [{ ch: 0, label: 'D0', gpio: 1 }],
      })
    );
    const capsFrame = encodeResponseFrame(TYPE_BOARD_CAPABILITIES, jsonBytes);
    expect(capsFrame[2]).toBe(TYPE_BOARD_CAPABILITIES);
    const caps = decodeBoardCapabilities(jsonBytes);
    expect(caps?.board).toBe('XIAO-ESP32-S3');
    expect(caps?.maxDepth).toBe(32768);
  });

  it('formats durations, resolutions, and frequencies cleanly', () => {
    expect(formatDuration(50e-9)).toBe('50.0 ns');
    expect(formatDuration(16.384e-3)).toBe('16.4 ms');
    expect(formatDuration(16.384)).toBe('16.38 s');
    expect(formatSignedDuration(-100e-6)).toBe('-100.0 µs');
    expect(formatResolution(20_000_000)).toBe('50 ns');
    expect(formatResolution(1_000_000)).toBe('1.0 µs');
    expect(formatResolution(1_000)).toBe('1.0 ms');
    expect(formatFrequency(5_000_000)).toBe('5.00 MHz');
    expect(formatFrequency(25_000)).toBe('25.00 kHz');
  });
});
