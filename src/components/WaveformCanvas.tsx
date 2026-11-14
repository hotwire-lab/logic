import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  formatDuration,
  formatFrequency,
  formatSignedDuration,
} from '../protocol/timeFormat';
import { CHANNELS, CaptureDataFrame } from '../protocol/types';

const RULER_HEIGHT = 26;

interface WaveformCanvasProps {
  capture: CaptureDataFrame | null;
  capturing: boolean;
}

interface ViewWindow {
  startSample: number;
  visibleSamples: number;
}

function chooseNiceStep(rawStepSec: number): number {
  if (!Number.isFinite(rawStepSec) || rawStepSec <= 0) return 1e-6;
  const exp = Math.floor(Math.log10(rawStepSec));
  const base = Math.pow(10, exp);
  const norm = rawStepSec / base;
  if (norm <= 1) return base;
  if (norm <= 2) return 2 * base;
  if (norm <= 5) return 5 * base;
  return 10 * base;
}

export const WaveformCanvas: React.FC<WaveformCanvasProps> = ({ capture, capturing }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [size, setSize] = useState<{ width: number; height: number }>({ width: 640, height: 360 });
  const [view, setView] = useState<ViewWindow>({ startSample: 0, visibleSamples: 1024 });
  const [showCursors, setShowCursors] = useState(true);
  const [cursorA, setCursorA] = useState(256);
  const [cursorB, setCursorB] = useState(768);

  const activePointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const dragModeRef = useRef<'none' | 'pan' | 'cursorA' | 'cursorB' | 'pinch'>('none');
  const panStartRef = useRef<{ x: number; startSample: number }>({ x: 0, startSample: 0 });
  const pinchStartRef = useRef<{
    dist: number;
    midX: number;
    startSample: number;
    visibleSamples: number;
  }>({ dist: 1, midX: 0, startSample: 0, visibleSamples: 1024 });

  // Reset zoom and cursor positions when a new capture arrives
  useEffect(() => {
    if (!capture || capture.samples.byteLength === 0) return;
    const total = capture.samples.byteLength;
    setView({ startSample: 0, visibleSamples: total });
    const trig = Math.min(total - 1, Math.max(0, capture.triggerIndex));
    setCursorA(Math.max(0, Math.round(total * 0.25)));
    setCursorB(trig > 0 && trig < total - 1 ? trig : Math.min(total - 1, Math.round(total * 0.65)));
  }, [capture]);

  // Track canvas container dimensions
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.max(100, Math.floor(entry.contentRect.width));
        const h = Math.max(180, Math.floor(entry.contentRect.height));
        setSize({ width: w, height: h });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const clampView = useCallback(
    (startSample: number, visibleSamples: number): ViewWindow => {
      const total = capture?.samples.byteLength ?? 1024;
      const minVis = Math.min(total, 16);
      const clampedVis = Math.max(minVis, Math.min(total, visibleSamples));
      const maxStart = Math.max(0, total - clampedVis);
      const clampedStart = Math.max(0, Math.min(maxStart, startSample));
      return { startSample: clampedStart, visibleSamples: clampedVis };
    },
    [capture]
  );

  const zoomAroundX = useCallback(
    (factor: number, xPx: number) => {
      const total = capture?.samples.byteLength ?? 0;
      if (total <= 0) return;
      setView((prev) => {
        const frac = Math.max(0, Math.min(1, xPx / Math.max(1, size.width)));
        const anchorSample = prev.startSample + frac * prev.visibleSamples;
        const nextVis = prev.visibleSamples * factor;
        const nextStart = anchorSample - frac * nextVis;
        return clampView(nextStart, nextVis);
      });
    },
    [capture, clampView, size.width]
  );

  // Render waveforms on canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.width * dpr);
    canvas.height = Math.round(size.height * dpr);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const width = size.width;
    const height = size.height;
    const laneHeight = (height - RULER_HEIGHT) / 8;

    // 1. Background & alternating channel lanes (aligned 1:1 with ChannelStrip)
    ctx.fillStyle = '#0D1117';
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = '#161B22';
    ctx.fillRect(0, 0, width, RULER_HEIGHT);

    for (let ch = 0; ch < 8; ch++) {
      const yTop = RULER_HEIGHT + ch * laneHeight;
      ctx.fillStyle = ch % 2 === 0 ? '#0D1117' : '#10161F';
      ctx.fillRect(0, yTop, width, laneHeight);

      ctx.strokeStyle = '#21262D';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, yTop);
      ctx.lineTo(width, yTop);
      ctx.stroke();
    }

    // Bottom ruler border
    ctx.strokeStyle = '#30363D';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, RULER_HEIGHT - 0.5);
    ctx.lineTo(width, RULER_HEIGHT - 0.5);
    ctx.stroke();

    if (!capture || capture.samples.byteLength === 0) {
      ctx.fillStyle = '#8B949E';
      ctx.font = '13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        capturing
          ? 'Waiting for trigger / capturing samples...'
          : 'Connect XIAO-ESP32-S3 or launch Demo, then click Capture',
        width / 2,
        RULER_HEIGHT + (height - RULER_HEIGHT) / 2
      );
      return;
    }

    const samples = capture.samples;
    const total = samples.byteLength;
    const rateHz = Math.max(1, capture.sampleRateHz);
    const startIdx = Math.max(0, view.startSample);
    const visCount = Math.max(1, view.visibleSamples);
    const endIdx = Math.min(total, startIdx + visCount);
    const pxPerSample = width / visCount;

    const sampleToX = (sampleIdx: number) => ((sampleIdx - startIdx) / visCount) * width;

    // 2. Time Ruler Ticks & Vertical Grid
    const visibleDurationSec = visCount / rateHz;
    const targetTicks = Math.max(3, Math.floor(width / 110));
    const stepSec = chooseNiceStep(visibleDurationSec / targetTicks);
    const originSample = capture.triggerIndex;
    const tStartSec = (startIdx - originSample) / rateHz;
    const tEndSec = (endIdx - originSample) / rateHz;
    const firstTickK = Math.ceil(tStartSec / stepSec);
    const lastTickK = Math.floor(tEndSec / stepSec);

    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    for (let k = firstTickK; k <= lastTickK; k++) {
      const tickSec = k * stepSec;
      const samplePos = originSample + tickSec * rateHz;
      const x = sampleToX(samplePos);
      if (x < -2 || x > width + 2) continue;

      ctx.strokeStyle = '#1E2633';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, RULER_HEIGHT);
      ctx.lineTo(Math.round(x) + 0.5, height);
      ctx.stroke();

      ctx.strokeStyle = '#484F58';
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, RULER_HEIGHT - 6);
      ctx.lineTo(Math.round(x) + 0.5, RULER_HEIGHT);
      ctx.stroke();

      ctx.fillStyle = '#8B949E';
      ctx.fillText(formatSignedDuration(tickSec), x + 4, RULER_HEIGHT / 2);
    }

    // 3. Digital Step Waveforms (D0..D7)
    const padY = Math.max(4, Math.min(10, laneHeight * 0.18));

    for (let ch = 0; ch < 8; ch++) {
      const meta = CHANNELS[ch];
      const bitMask = 1 << ch;
      const yTop = RULER_HEIGHT + ch * laneHeight;
      const yHigh = yTop + padY;
      const yLow = yTop + laneHeight - padY;

      ctx.strokeStyle = meta.color;
      ctx.lineWidth = 1.75;

      if (pxPerSample >= 1.0) {
        // High-zoom exact digital step rendering
        const iFrom = Math.max(0, Math.floor(startIdx));
        const iTo = Math.min(total - 1, Math.ceil(endIdx));

        ctx.beginPath();
        let prevBit = (samples[iFrom] & bitMask) !== 0;
        const x0 = sampleToX(iFrom);
        ctx.moveTo(x0, prevBit ? yHigh : yLow);

        for (let idx = iFrom + 1; idx <= iTo; idx++) {
          const curBit = (samples[idx] & bitMask) !== 0;
          const x = sampleToX(idx);
          const yPrev = prevBit ? yHigh : yLow;
          const yCur = curBit ? yHigh : yLow;
          ctx.lineTo(x, yPrev);
          if (curBit !== prevBit) {
            ctx.lineTo(x, yCur);
          }
          prevBit = curBit;
        }
        ctx.lineTo(sampleToX(iTo + 1), prevBit ? yHigh : yLow);
        ctx.stroke();

        // Subtle high-state fill
        ctx.fillStyle = `${meta.color}1C`;
        for (let idx = iFrom; idx <= iTo; idx++) {
          if ((samples[idx] & bitMask) !== 0) {
            const sx = sampleToX(idx);
            const sw = Math.max(1, sampleToX(idx + 1) - sx);
            ctx.fillRect(sx, yHigh, sw, yLow - yHigh);
          }
        }
      } else {
        // Zoomed-out envelope rendering (preserves single-sample glitches!)
        ctx.beginPath();
        let prevLastBit: boolean | null = null;
        for (let px = 0; px < width; px++) {
          const s0 = Math.max(0, Math.floor(startIdx + (px / width) * visCount));
          const s1 = Math.min(
            total - 1,
            Math.max(s0, Math.floor(startIdx + ((px + 1) / width) * visCount))
          );

          let hasLow = false;
          let hasHigh = false;
          for (let s = s0; s <= s1; s++) {
            if ((samples[s] & bitMask) !== 0) hasHigh = true;
            else hasLow = true;
            if (hasHigh && hasLow) break;
          }

          const firstBit = (samples[s0] & bitMask) !== 0;
          const lastBit = (samples[s1] & bitMask) !== 0;

          if (prevLastBit !== null && firstBit !== prevLastBit) {
            ctx.moveTo(px, yHigh);
            ctx.lineTo(px, yLow);
          }

          if (hasHigh && hasLow) {
            ctx.moveTo(px + 0.5, yHigh);
            ctx.lineTo(px + 0.5, yLow);
          } else {
            const y = hasHigh ? yHigh : yLow;
            ctx.moveTo(px, y);
            ctx.lineTo(px + 1, y);
          }
          prevLastBit = lastBit;
        }
        ctx.stroke();
      }
    }

    // 4. Vertical Trigger Position Marker
    if (capture.triggerIndex >= 0 && capture.triggerIndex < total) {
      const trigX = sampleToX(capture.triggerIndex);
      if (trigX >= 0 && trigX <= width) {
        ctx.save();
        ctx.strokeStyle = capture.autoTriggered ? '#8B949E' : '#F0883E';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(trigX, RULER_HEIGHT);
        ctx.lineTo(trigX, height);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = capture.autoTriggered ? '#8B949E' : '#F0883E';
        ctx.fillRect(trigX - 8, 2, 16, 16);
        ctx.fillStyle = '#0D1117';
        ctx.font = 'bold 10px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('T', trigX, 10);
        ctx.restore();
      }
    }

    // 5. Draggable Measurement Cursors A and B
    if (showCursors) {
      const drawCursor = (samplePos: number, label: string, color: string) => {
        const x = sampleToX(samplePos);
        if (x < -12 || x > width + 12) return;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, RULER_HEIGHT);
        ctx.lineTo(x, height);
        ctx.stroke();

        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(x - 9, RULER_HEIGHT - 18, 18, 17, 3);
        ctx.fill();

        ctx.fillStyle = '#0D1117';
        ctx.font = 'bold 11px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, x, RULER_HEIGHT - 9);
        ctx.restore();
      };

      drawCursor(cursorA, 'A', '#39C5CF');
      drawCursor(cursorB, 'B', '#D29922');
    }
  }, [capture, capturing, cursorA, cursorB, showCursors, size, view]);

  const xToSample = (xPx: number): number => {
    const total = capture?.samples.byteLength ?? 1;
    const raw = view.startSample + (xPx / Math.max(1, size.width)) * view.visibleSamples;
    return Math.max(0, Math.min(total - 1, Math.round(raw)));
  };

  const sampleToClientX = (sampleIdx: number): number =>
    ((sampleIdx - view.startSample) / Math.max(1, view.visibleSamples)) * size.width;

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!capture || capture.samples.byteLength === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore synthetic events
    }

    activePointers.current.set(e.pointerId, { x, y });

    if (activePointers.current.size === 2) {
      const pts = Array.from(activePointers.current.values());
      const dist = Math.max(8, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y));
      const midX = (pts[0].x + pts[1].x) / 2;
      dragModeRef.current = 'pinch';
      pinchStartRef.current = {
        dist,
        midX,
        startSample: view.startSample,
        visibleSamples: view.visibleSamples,
      };
      return;
    }

    if (showCursors) {
      const ax = sampleToClientX(cursorA);
      const bx = sampleToClientX(cursorB);
      const distA = Math.abs(x - ax);
      const distB = Math.abs(x - bx);
      const threshold = y <= RULER_HEIGHT + 8 ? 16 : 9;
      if (distA <= threshold && distA <= distB) {
        dragModeRef.current = 'cursorA';
        return;
      }
      if (distB <= threshold) {
        dragModeRef.current = 'cursorB';
        return;
      }
    }

    dragModeRef.current = 'pan';
    panStartRef.current = { x, startSample: view.startSample };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!capture || capture.samples.byteLength === 0) return;
    if (!activePointers.current.has(e.pointerId)) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    activePointers.current.set(e.pointerId, { x, y });

    if (dragModeRef.current === 'pinch' && activePointers.current.size >= 2) {
      const pts = Array.from(activePointers.current.values());
      const dist = Math.max(8, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y));
      const midX = (pts[0].x + pts[1].x) / 2;
      const scale = pinchStartRef.current.dist / dist;
      const newVis = pinchStartRef.current.visibleSamples * scale;
      const anchorFrac = Math.max(0, Math.min(1, pinchStartRef.current.midX / Math.max(1, size.width)));
      const anchorSample =
        pinchStartRef.current.startSample + anchorFrac * pinchStartRef.current.visibleSamples;
      const curMidFrac = Math.max(0, Math.min(1, midX / Math.max(1, size.width)));
      const newStart = anchorSample - curMidFrac * newVis;
      setView(clampView(newStart, newVis));
      return;
    }

    if (dragModeRef.current === 'cursorA') {
      setCursorA(xToSample(x));
    } else if (dragModeRef.current === 'cursorB') {
      setCursorB(xToSample(x));
    } else if (dragModeRef.current === 'pan') {
      const dx = x - panStartRef.current.x;
      const dSamples = (dx / Math.max(1, size.width)) * view.visibleSamples;
      setView(clampView(panStartRef.current.startSample - dSamples, view.visibleSamples));
    }
  };

  const handlePointerUpOrCancel = (e: React.PointerEvent<HTMLCanvasElement>) => {
    activePointers.current.delete(e.pointerId);
    if (activePointers.current.size < 2 && dragModeRef.current === 'pinch') {
      dragModeRef.current = 'none';
    } else if (activePointers.current.size === 0) {
      dragModeRef.current = 'none';
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!capture || capture.samples.byteLength === 0) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const factor = e.deltaY < 0 ? 0.78 : 1.28;
    zoomAroundX(factor, x);
  };

  const fitAll = () => {
    if (!capture) return;
    setView({ startSample: 0, visibleSamples: capture.samples.byteLength });
  };

  const rateHz = Math.max(1, capture?.sampleRateHz ?? 1_000_000);
  const deltaSamples = Math.abs(cursorB - cursorA);
  const deltaSec = deltaSamples / rateHz;
  const freqHz = deltaSec > 0 ? 1 / deltaSec : 0;

  return (
    <div className="waveform-pane" ref={containerRef}>
      <canvas
        ref={canvasRef}
        className="waveform-canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUpOrCancel}
        onPointerCancel={handlePointerUpOrCancel}
        onWheel={handleWheel}
      />

      {capture && (
        <div className="waveform-overlay-controls">
          <button type="button" className="overlay-btn" onClick={() => zoomAroundX(0.65, size.width / 2)}>
            +
          </button>
          <button type="button" className="overlay-btn" onClick={() => zoomAroundX(1.5, size.width / 2)}>
            −
          </button>
          <button type="button" className="overlay-btn" onClick={fitAll}>
            Fit
          </button>
          <button
            type="button"
            className={`overlay-btn ${showCursors ? 'active' : ''}`}
            onClick={() => setShowCursors((v) => !v)}
          >
            Cursors
          </button>
        </div>
      )}

      {capture && showCursors && (
        <div className="delta-badge" aria-live="polite">
          <span className="cursor-a-tag">
            A: {formatSignedDuration((cursorA - capture.triggerIndex) / rateHz)}
          </span>
          <span className="cursor-b-tag">
            B: {formatSignedDuration((cursorB - capture.triggerIndex) / rateHz)}
          </span>
          <span className="delta-tag">
            Δt: {formatDuration(deltaSec)} ({freqHz > 0 ? formatFrequency(freqHz) : '∞'})
          </span>
          {capture.abortedEarly && <span className="flag-tag flag-warn">ABORTED</span>}
          {capture.autoTriggered && <span className="flag-tag flag-muted">AUTO-TRIG</span>}
        </div>
      )}
    </div>
  );
};
