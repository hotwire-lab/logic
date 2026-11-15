import React from 'react';
import { DecoderConfig, DecoderKind } from '../protocol/decoders';
import { formatDuration, formatResolution } from '../protocol/timeFormat';
import {
  CHANNELS,
  DEPTH_PRESETS,
  PreTriggerRatio,
  RATE_PRESETS,
  SIGNAL_GEN_PRESETS,
  SignalGenMode,
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

const UART_BAUD_PRESETS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000];

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
  sigGenMode: SignalGenMode;
  decoderConfig: DecoderConfig;
  hasCapture: boolean;
  channelLabels?: readonly string[];
  onConnect: (backend?: 'webserial' | 'webusb') => void;
  onStartDemo: () => void;
  onDisconnect: () => void;
  onUpdateCaptureConfig: (partial: Partial<CaptureConfig>) => void;
  onCapture: () => void;
  onAbort: () => void;
  onToggleContinuous: () => void;
  onReleaseAll: () => void;
  onChangeSigGen: (mode: SignalGenMode) => void;
  onUpdateDecoderConfig: (next: DecoderConfig) => void;
  onExportCsv: () => void;
  onExportVcd: () => void;
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
  sigGenMode,
  decoderConfig,
  hasCapture,
  channelLabels,
  onConnect,
  onStartDemo,
  onDisconnect,
  onUpdateCaptureConfig,
  onCapture,
  onAbort,
  onToggleContinuous,
  onReleaseAll,
  onChangeSigGen,
  onUpdateDecoderConfig,
  onExportCsv,
  onExportVcd,
}) => {
  const isConnected = connectionStatus === 'connected';
  const rate = RATE_PRESETS[captureConfig.rateId] ?? RATE_PRESETS[6];
  const samples = captureConfig.blocksKb * 1024;
  const windowDurationSec = samples / rate.hz;

  const chDisplay = (ch: number) => {
    const alias = channelLabels?.[ch]?.trim();
    return alias ? `${CHANNELS[ch].label} (${alias})` : CHANNELS[ch].label;
  };

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

  const spiModeNum = (decoderConfig.spi.cpol << 1) | decoderConfig.spi.cpha;

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
                title="Launch offline XIAO ESP32-S3 / ESP32-C6 hardware simulator"
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
            title="Release all 8 channels (D0–D7) to High-Z Input (Z), stop generator, and clear contention flags"
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
                  {chDisplay(c.ch)}
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
                { val: 3, label: '75%' },
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

        <div className="capture-control-group">
          <label
            className="ctrl-field"
            title={
              SIGNAL_GEN_PRESETS.find((p) => p.mode === sigGenMode)?.hint ??
              'Built-in hardware pattern generator'
            }
          >
            <span className="ctrl-label">Gen</span>
            <select
              aria-label="Built-in signal generator"
              className="ctrl-select"
              value={sigGenMode}
              disabled={!isConnected}
              onChange={(e) => onChangeSigGen(Number(e.target.value) as SignalGenMode)}
            >
              {SIGNAL_GEN_PRESETS.map((p) => (
                <option key={p.mode} value={p.mode}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          <label className="ctrl-field">
            <span className="ctrl-label">Decode</span>
            <select
              aria-label="Protocol decoder"
              className="ctrl-select"
              value={decoderConfig.kind}
              onChange={(e) =>
                onUpdateDecoderConfig({ ...decoderConfig, kind: e.target.value as DecoderKind })
              }
            >
              <option value="none">None</option>
              <option value="uart">UART</option>
              <option value="spi">SPI</option>
              <option value="i2c">I2C</option>
            </select>
          </label>

          {decoderConfig.kind === 'uart' && (
            <div className="decoder-subcontrols">
              <select
                aria-label="UART RX channel"
                className="ctrl-select ctrl-select-sm"
                value={decoderConfig.uart.rxCh}
                onChange={(e) =>
                  onUpdateDecoderConfig({
                    ...decoderConfig,
                    uart: { ...decoderConfig.uart, rxCh: Number(e.target.value) },
                  })
                }
              >
                {CHANNELS.map((c) => (
                  <option key={c.ch} value={c.ch}>
                    RX:{c.label}
                  </option>
                ))}
              </select>
              <select
                aria-label="UART baud rate"
                className="ctrl-select ctrl-select-sm"
                value={decoderConfig.uart.baud}
                onChange={(e) =>
                  onUpdateDecoderConfig({
                    ...decoderConfig,
                    uart: { ...decoderConfig.uart, baud: Number(e.target.value) },
                  })
                }
              >
                {UART_BAUD_PRESETS.map((b) => (
                  <option key={b} value={b}>
                    {b >= 1_000_000 ? '1M' : `${b}`}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={`btn btn-secondary btn-compact ${decoderConfig.uart.invert ? 'active' : ''}`}
                title="Invert UART idle/polarity"
                onClick={() =>
                  onUpdateDecoderConfig({
                    ...decoderConfig,
                    uart: { ...decoderConfig.uart, invert: !decoderConfig.uart.invert },
                  })
                }
              >
                Inv
              </button>
            </div>
          )}

          {decoderConfig.kind === 'spi' && (
            <div className="decoder-subcontrols">
              <select
                aria-label="SPI CLK"
                className="ctrl-select ctrl-select-sm"
                value={decoderConfig.spi.clkCh}
                onChange={(e) =>
                  onUpdateDecoderConfig({
                    ...decoderConfig,
                    spi: { ...decoderConfig.spi, clkCh: Number(e.target.value) },
                  })
                }
              >
                {CHANNELS.map((c) => (
                  <option key={c.ch} value={c.ch}>
                    CLK:{c.label}
                  </option>
                ))}
              </select>
              <select
                aria-label="SPI MOSI"
                className="ctrl-select ctrl-select-sm"
                value={decoderConfig.spi.mosiCh}
                onChange={(e) =>
                  onUpdateDecoderConfig({
                    ...decoderConfig,
                    spi: { ...decoderConfig.spi, mosiCh: Number(e.target.value) },
                  })
                }
              >
                {CHANNELS.map((c) => (
                  <option key={c.ch} value={c.ch}>
                    MOSI:{c.label}
                  </option>
                ))}
              </select>
              <select
                aria-label="SPI MISO"
                className="ctrl-select ctrl-select-sm"
                value={decoderConfig.spi.misoCh === null ? 'none' : String(decoderConfig.spi.misoCh)}
                onChange={(e) =>
                  onUpdateDecoderConfig({
                    ...decoderConfig,
                    spi: {
                      ...decoderConfig.spi,
                      misoCh: e.target.value === 'none' ? null : Number(e.target.value),
                    },
                  })
                }
              >
                <option value="none">MISO:-</option>
                {CHANNELS.map((c) => (
                  <option key={c.ch} value={c.ch}>
                    MISO:{c.label}
                  </option>
                ))}
              </select>
              <select
                aria-label="SPI CS"
                className="ctrl-select ctrl-select-sm"
                value={decoderConfig.spi.csCh === null ? 'none' : String(decoderConfig.spi.csCh)}
                onChange={(e) =>
                  onUpdateDecoderConfig({
                    ...decoderConfig,
                    spi: {
                      ...decoderConfig.spi,
                      csCh: e.target.value === 'none' ? null : Number(e.target.value),
                    },
                  })
                }
              >
                <option value="none">CS:-</option>
                {CHANNELS.map((c) => (
                  <option key={c.ch} value={c.ch}>
                    CS:{c.label}
                  </option>
                ))}
              </select>
              <select
                aria-label="SPI Mode"
                className="ctrl-select ctrl-select-sm"
                value={spiModeNum}
                onChange={(e) => {
                  const m = Number(e.target.value);
                  onUpdateDecoderConfig({
                    ...decoderConfig,
                    spi: {
                      ...decoderConfig.spi,
                      cpol: ((m >> 1) & 1) as 0 | 1,
                      cpha: (m & 1) as 0 | 1,
                    },
                  });
                }}
              >
                <option value={0}>M0</option>
                <option value={1}>M1</option>
                <option value={2}>M2</option>
                <option value={3}>M3</option>
              </select>
            </div>
          )}

          {decoderConfig.kind === 'i2c' && (
            <div className="decoder-subcontrols">
              <select
                aria-label="I2C SCL"
                className="ctrl-select ctrl-select-sm"
                value={decoderConfig.i2c.sclCh}
                onChange={(e) =>
                  onUpdateDecoderConfig({
                    ...decoderConfig,
                    i2c: { ...decoderConfig.i2c, sclCh: Number(e.target.value) },
                  })
                }
              >
                {CHANNELS.map((c) => (
                  <option key={c.ch} value={c.ch}>
                    SCL:{c.label}
                  </option>
                ))}
              </select>
              <select
                aria-label="I2C SDA"
                className="ctrl-select ctrl-select-sm"
                value={decoderConfig.i2c.sdaCh}
                onChange={(e) =>
                  onUpdateDecoderConfig({
                    ...decoderConfig,
                    i2c: { ...decoderConfig.i2c, sdaCh: Number(e.target.value) },
                  })
                }
              >
                {CHANNELS.map((c) => (
                  <option key={c.ch} value={c.ch}>
                    SDA:{c.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="capture-action-group">
          {!capturing ? (
            <button
              type="button"
              className="btn btn-accent"
              disabled={!isConnected}
              onClick={onCapture}
              title="Start single capture (Space)"
            >
              Capture
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-danger"
              onClick={onAbort}
              title="Abort ongoing capture and retrieve partial buffer (Space)"
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

          <button
            type="button"
            className="btn btn-secondary btn-compact"
            disabled={!hasCapture}
            onClick={onExportCsv}
            title="Export captured waveform samples as CSV"
          >
            CSV
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-compact"
            disabled={!hasCapture}
            onClick={onExportVcd}
            title="Export captured waveform samples as IEEE-1364 VCD (GTKWave / PulseView)"
          >
            VCD
          </button>
        </div>
      </div>
    </header>
  );
};
