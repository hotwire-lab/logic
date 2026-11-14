import { describe, expect, it } from 'vitest';
import {
  countChannelEdges,
  decodeI2c,
  decodeSpi,
  decodeUart,
  exportCaptureToCsv,
  exportCaptureToVcd,
  findNearestEdge,
  findNextChannelEdge,
  measurePulseAtSample,
} from '../protocol/decoders';
import { CaptureDataFrame } from '../protocol/types';

function makeUartSamples(
  text: string,
  sampleRateHz: number,
  baud: number,
  ch = 6,
  invert = false,
  badStopByteIdx: number | null = null
): Uint8Array {
  const bitSamples = sampleRateHz / baud;
  const idle = invert ? 0 : 1;
  const leadSamples = Math.round(bitSamples * 3);
  const totalSamples = Math.ceil(leadSamples + text.length * 11 * bitSamples + bitSamples * 4);
  const buf = new Uint8Array(totalSamples).fill(idle ? 1 << ch : 0);

  let cursor = leadSamples;
  for (let idx = 0; idx < text.length; idx++) {
    const byte = text.charCodeAt(idx) & 0xff;
    const bits: number[] = [0]; // start bit (logical 0)
    for (let b = 0; b < 8; b++) {
      bits.push((byte >> b) & 1);
    }
    bits.push(badStopByteIdx === idx ? 0 : 1); // stop bit (logical 1 unless forced framing error)

    for (let k = 0; k < bits.length; k++) {
      const start = Math.round(cursor + k * bitSamples);
      const end = Math.round(cursor + (k + 1) * bitSamples);
      const physical = invert ? bits[k] ^ 1 : bits[k];
      const level = physical ? 1 << ch : 0;
      for (let s = start; s < end && s < buf.length; s++) {
        buf[s] = level;
      }
    }
    // Slight inter-byte idle gap
    cursor = Math.round(cursor + 10.5 * bitSamples);
  }

  return buf;
}

describe('signal measurements and edge helpers', () => {
  it('measures enclosed pulse width, period, frequency, and high duty cycle', () => {
    // 1 MHz sample rate: low 10, high 25, low 75 (period = 100 samples = 100 us = 10 kHz, duty = 25%)
    const samples = new Uint8Array(150);
    for (let i = 10; i < 35; i++) samples[i] = 1; // HIGH for 25 samples on ch 0
    for (let i = 110; i < 135; i++) samples[i] = 1; // second HIGH pulse (25 samples) starting at 110

    const highPulse = measurePulseAtSample(samples, 0, 20, 1_000_000);
    expect(highPulse).not.toBeNull();
    expect(highPulse!.level).toBe(1);
    expect(highPulse!.startSample).toBe(10);
    expect(highPulse!.endSample).toBe(35);
    expect(highPulse!.widthSamples).toBe(25);
    expect(highPulse!.periodSamples).toBe(100);
    expect(highPulse!.frequencyHz).toBeCloseTo(10_000, 1);
    expect(highPulse!.dutyPercent).toBeCloseTo(25, 1);

    const lowPulse = measurePulseAtSample(samples, 0, 50, 1_000_000);
    expect(lowPulse).not.toBeNull();
    expect(lowPulse!.level).toBe(0);
    expect(lowPulse!.widthSamples).toBe(75);
    expect(lowPulse!.periodSamples).toBe(100);
    expect(lowPulse!.dutyPercent).toBeCloseTo(25, 1);

    // Unbounded segments at edges return null
    expect(measurePulseAtSample(samples, 0, 2, 1_000_000)).toBeNull();
  });

  it('finds nearest edges, next/prev edges, and counts rising/falling edges between cursors', () => {
    const samples = new Uint8Array(64);
    for (let i = 10; i < 20; i++) samples[i] = 0b00000100; // ch 2 pulse [10..20)
    for (let i = 30; i < 45; i++) samples[i] = 0b00000100; // ch 2 pulse [30..45)

    expect(findNearestEdge(samples, 2, 11.2, 4)).toBe(10);
    expect(findNearestEdge(samples, 2, 15, 2)).toBeNull();
    expect(findNextChannelEdge(samples, 2, 12, 1)).toBe(20);
    expect(findNextChannelEdge(samples, 2, 12, -1)).toBe(10);
    expect(countChannelEdges(samples, 2, 5, 50)).toEqual({ rising: 2, falling: 2 });
  });
});

describe('protocol decoders', () => {
  it('decodes 8N1 UART bytes including ASCII and detects framing errors', () => {
    const rate = 2_000_000;
    const samples = makeUartSamples('HW\r\n', rate, 115200, 6, false);
    const frames = decodeUart(samples, rate, { rxCh: 6, baud: 115200, invert: false });
    expect(frames.map((f) => f.rawByte)).toEqual([0x48, 0x57, 0x0d, 0x0a]);
    expect(frames[0].label).toBe("0x48 'H'");
    expect(frames[2].label).toBe('0x0D \\r');
    expect(frames.every((f) => !f.framingError)).toBe(true);

    const badSamples = makeUartSamples('OK', rate, 115200, 6, false, 1);
    const badFrames = decodeUart(badSamples, rate, { rxCh: 6, baud: 115200, invert: false });
    expect(badFrames[0].framingError).toBe(false);
    expect(badFrames[1].framingError).toBe(true);
    expect(badFrames[1].kind).toBe('error');
  });

  it('decodes SPI Mode 0 bytes on MOSI and MISO gated by active-low CS', () => {
    // CLK=ch0, MOSI=ch1, MISO=ch2, CS=ch3
    const mosiBytes = [0xa5, 0x5a];
    const misoBytes = [0x12, 0x34];
    const out: number[] = [];
    const push = (clk: number, mosi: number, miso: number, cs: number, count = 4) => {
      const val = (clk & 1) | ((mosi & 1) << 1) | ((miso & 1) << 2) | ((cs & 1) << 3);
      for (let i = 0; i < count; i++) out.push(val);
    };

    push(0, 0, 0, 1, 8); // idle CS high
    push(0, 0, 0, 0, 4); // CS low
    for (let idx = 0; idx < mosiBytes.length; idx++) {
      for (let b = 7; b >= 0; b--) {
        const mosiBit = (mosiBytes[idx] >> b) & 1;
        const misoBit = (misoBytes[idx] >> b) & 1;
        push(0, mosiBit, misoBit, 0, 4);
        push(1, mosiBit, misoBit, 0, 4);
      }
    }
    push(0, 0, 0, 1, 8); // CS high

    const frames = decodeSpi(new Uint8Array(out), {
      clkCh: 0,
      mosiCh: 1,
      misoCh: 2,
      csCh: 3,
      cpol: 0,
      cpha: 0,
      bitOrder: 'msb',
    });

    expect(frames.map((f) => f.rawByte)).toEqual([0xa5, 0x5a]);
    expect(frames[0].secondaryLabel).toBe('0x12');
    expect(frames[1].secondaryLabel).toBe('0x34');
  });

  it('decodes I2C START, 7-bit address + W/R + ACK, data bytes, and STOP', () => {
    // SCL=ch0, SDA=ch1
    const out: number[] = [];
    const push = (scl: number, sda: number, count = 4) => {
      const v = (scl & 1) | ((sda & 1) << 1);
      for (let i = 0; i < count; i++) out.push(v);
    };

    const writeByteWithAck = (byte: number, ackBit: 0 | 1) => {
      for (let b = 7; b >= 0; b--) {
        const bit = (byte >> b) & 1;
        push(0, bit, 3);
        push(1, bit, 3);
        push(0, bit, 2);
      }
      push(0, ackBit, 3);
      push(1, ackBit, 3);
      push(0, ackBit, 2);
    };

    push(1, 1, 6); // idle
    push(1, 0, 4); // START
    push(0, 0, 2);
    writeByteWithAck((0x3c << 1) | 0, 0); // 0x3C Write ACK
    writeByteWithAck(0xae, 1); // 0xAE NACK
    push(0, 0, 3);
    push(1, 0, 4);
    push(1, 1, 6); // STOP

    const frames = decodeI2c(new Uint8Array(out), { sclCh: 0, sdaCh: 1 });
    expect(frames.map((f) => f.label)).toEqual(['S', '0x3C W ACK', '0xAE NACK', 'P']);
    expect(frames[1].kind).toBe('addr');
    expect(frames[2].kind).toBe('error');
  });
});

describe('capture exporters', () => {
  it('exports capture to CSV and VCD formats', () => {
    const capture: CaptureDataFrame = {
      sampleRateHz: 1_000_000,
      triggerIndex: 1,
      flags: 1,
      triggered: true,
      autoTriggered: false,
      abortedEarly: false,
      samples: new Uint8Array([0b00000000, 0b00000011, 0b00000011, 0b00000001]),
    };

    const csv = exportCaptureToCsv(capture, ['SCL', 'SDA']);
    const csvLines = csv.trim().split('\n');
    expect(csvLines[0]).toBe('sample_index,time_s,D0_SCL,D1_SDA,D2,D3,D4,D5,D6,D7');
    expect(csvLines[1]).toBe('0,0.000000000,0,0,0,0,0,0,0,0');
    expect(csvLines[2]).toBe('1,0.000001000,1,1,0,0,0,0,0,0');

    const vcd = exportCaptureToVcd(capture, ['SCL', 'SDA']);
    expect(vcd).toContain('$timescale 1ps $end');
    expect(vcd).toContain('$var wire 1 ! D0_SCL $end');
    expect(vcd).toContain('$var wire 1 " D1_SDA $end');
    expect(vcd).toContain('#1000000\n1!\n1"');
    expect(vcd).toContain('#3000000\n0"');
  });
});
