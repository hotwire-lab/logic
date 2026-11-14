import React from 'react';
import { formatDuration, formatResolution } from '../protocol/timeFormat';
import {
  CHANNELS,
  DEPTH_PRESETS,
  PreTriggerRatio,
  RATE_PRESETS,
  TriggerEdge,
} from '../protocol/types';
import { ConnectionStatus, TransportKind } from '../transport/SerialTransport';

export interface CaptureConfig {
  rateId: number;
  blocksKb: number;
  triggerChannel: number | null; // null = Free Run
  edge: TriggerEdge;
  preTrigger: PreTriggerRatio;
}

interface TopToolbarProps {
  connectionStatus: ConnectionStatus;
  transportKind: TransportKind;
  deviceName: string;
  errorMessage: string | null;
  hasWebSerial: boolean;
  hasWebUSB: boolean;
  captureConfig: CaptureConfig;
  capturing: boolean;
  continuous: boolean;
  onConnect: (backend?: 'webserial' | 'webusb') => void;
  onStartDemo: () => void;
  onDisconnect: () => void;
  onUpdateCaptureConfig: (partial: Partial<CaptureConfig>) => void;
  onCapture: () => void;
  onAbort: () => void;
  onToggleContinuous: () => void;
  onReleaseAll: () => void;
}

export const TopToolbar: React.FC<TopToolbarProps> = ({
  connectionStatus,
  transportKind,
  deviceName,
  errorMessage,
  hasWebSerial,
  hasWebUSB,
  captureConfig,
  capturing,
  continuous,
  onConnect,
  onStartDemo,
  onDisconnect,
  onUpdateCaptureConfig,
  onCapture,
  onAbort,
  onToggleContinuous,
  onReleaseAll,
}) => {
  const isConnected = connectionStatus === 'connected';
  const rate = RATE_PRESETS[captureConfig.rateId] ?? RATE_PRESETS[6];
  const samples = captureConfig.blocksKb * 1024;
  const windowDurationSec = samples / rate.hz;

  const pillClass =
    connectionStatus === 'connected'
      ? 'status-pill status-connected'
      : connectionStatus === 'connecting'
        ? 'status-pill status-connecting'
        : 'status-pill status-waiting';

  const pillText = isConnected
    ? `Connected: ${deviceName}`
    : connectionStatus === 'connecting'
      ? 'Connecting...'
      : 'Waiting for USB...';

  return (
    <header className="top-toolbar">
      <div className="toolbar-row toolbar-primary">
        <div className="brand-group">
          <span className="brand-title">HotWire</span>
          <span className="brand-sub">8-Ch Pocket Lab</span>
          <span className={pillClass} title={errorMessage ?? undefined}>
            <span className="status-dot" />
            <span className="status-label">{pillText}</span>
          </span>
        </div>

        <div className="toolbar-actions-right">
          {!isConnected ? (
            <>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => onConnect()}
                title="Connect via default browser USB transport"
              >
                Connect
              </button>
              {hasWebSerial && hasWebUSB && (
                <button
                  type="button"
                  className="btn btn-secondary btn-compact"
                  onClick={() => onConnect('webusb')}
                  title="Force WebUSB CDC-ACM transport (DTR+RTS control transfer)"
                >
                  WebUSB
                </button>
              )}
              <button
                type="button"
                className="btn btn-secondary"
                onClick={onStartDemo}
                title="Launch offline XIAO ESP32-S3 hardware simulator"
              >
                Demo
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onDisconnect}
              title={`Disconnect (${transportKind})`}
            >
              Disconnect
            </button>
          )}

          <button
            type="button"
            className="btn btn-danger release-all-btn"
            disabled={!isConnected}
            onClick={onReleaseAll}
            title="Release all 8 channels (D0–D7) to High-Z Input (Z) and clear contention flags"
          >
            Release All (Z)
          </button>
        </div>
      </div>

      {errorMessage && <div className="toolbar-error-banner">{errorMessage}</div>}

      <div className="toolbar-row toolbar-capture">
        <div className="capture-control-group">
          <label className="ctrl-field">
            <span className="ctrl-label">Rate</span>
            <select
              aria-label="Sample rate"
              className="ctrl-select"
              value={captureConfig.rateId}
              disabled={capturing}
              onChange={(e) => onUpdateCaptureConfig({ rateId: Number(e.target.value) })}
            >
              {RATE_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
          </label>

          <label className="ctrl-field">
            <span className="ctrl-label">Depth</span>
            <select
              aria-label="Sample depth"
              className="ctrl-select"
              value={captureConfig.blocksKb}
              disabled={capturing}
              onChange={(e) => onUpdateCaptureConfig({ blocksKb: Number(e.target.value) })}
            >
              {DEPTH_PRESETS.map((d) => (
                <option key={d.blocksKb} value={d.blocksKb}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>

          <span className="window-badge" title="Calculated capture duration and sample resolution">
            Window: {formatDuration(windowDurationSec)} | Res: {formatResolution(rate.hz)}
          </span>
        </div>

        <div className="capture-control-group">
          <label className="ctrl-field">
            <span className="ctrl-label">Trig</span>
            <select
              aria-label="Trigger channel"
              className="ctrl-select"
              value={captureConfig.triggerChannel === null ? 'free' : String(captureConfig.triggerChannel)}
              disabled={capturing}
              onChange={(e) => {
                const v = e.target.value;
                onUpdateCaptureConfig({
                  triggerChannel: v === 'free' ? null : Number(v),
                });
              }}
            >
              <option value="free">Free Run</option>
              {CHANNELS.map((c) => (
                <option key={c.ch} value={String(c.ch)}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          <div className="seg-group" role="group" aria-label="Trigger edge">
            {(
              [
                { val: 1, label: '↑', title: 'Rising edge' },
                { val: 0, label: '↓', title: 'Falling edge' },
                { val: 2, label: '↕', title: 'Any edge' },
              ] as Array<{ val: TriggerEdge; label: string; title: string }>
            ).map((opt) => (
              <button
                key={opt.val}
                type="button"
                title={opt.title}
                disabled={capturing || captureConfig.triggerChannel === null}
                className={`seg-btn ${captureConfig.edge === opt.val ? 'active' : ''}`}
                onClick={() => onUpdateCaptureConfig({ edge: opt.val })}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="seg-group" role="group" aria-label="Pre-trigger ratio">
            {(
              [
                { val: 0, label: '0%' },
                { val: 1, label: '25%' },
                { val: 2, label: '50%' },
              ] as Array<{ val: PreTriggerRatio; label: string }>
            ).map((opt) => (
              <button
                key={opt.val}
                type="button"
                title={`Pre-trigger buffer ${opt.label}`}
                disabled={capturing || captureConfig.triggerChannel === null}
                className={`seg-btn ${captureConfig.preTrigger === opt.val ? 'active' : ''}`}
                onClick={() => onUpdateCaptureConfig({ preTrigger: opt.val })}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="capture-action-group">
          {!capturing ? (
            <button
              type="button"
              className="btn btn-accent"
              disabled={!isConnected}
              onClick={onCapture}
            >
              Capture
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-danger"
              onClick={onAbort}
              title="Abort ongoing capture and retrieve partial buffer"
            >
              Abort
            </button>
          )}

          <button
            type="button"
            className={`btn btn-toggle ${continuous ? 'active' : ''}`}
            disabled={!isConnected}
            onClick={onToggleContinuous}
            title="Auto / Continuous capture loop"
          >
            Auto
          </button>
        </div>
      </div>
    </header>
  );
};
