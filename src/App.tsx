import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BottomDrawer } from './components/BottomDrawer';
import { ChannelStrip, ChannelUiState } from './components/ChannelStrip';
import { CaptureConfig, TopToolbar } from './components/TopToolbar';
import { WaveformCanvas, WaveformCanvasHandle } from './components/WaveformCanvas';
import { ProtocolDemuxer } from './protocol/ProtocolDemuxer';
import {
  buildLaAbortCmd,
  buildLaCaptureCmd,
  buildPinForceCmd,
  buildReleaseAllCmd,
} from './protocol/codec';
import {
  DEFAULT_DECODER_CONFIG,
  DecodedFrameAnnotation,
  DecoderConfig,
  decodeProtocol,
  exportCaptureToCsv,
  exportCaptureToVcd,
} from './protocol/decoders';
import { formatSignedDuration } from './protocol/timeFormat';
import {
  BoardCapabilities,
  CaptureDataFrame,
  PinForceMode,
  PinPullMode,
  RATE_PRESETS,
  StatusTelemetry,
  TYPE_BOARD_CAPABILITIES,
  TYPE_LA_CAPTURE_DATA,
  TYPE_STATUS_TELEMETRY,
} from './protocol/types';
import { SerialTransport, TransportSnapshot } from './transport/SerialTransport';
import { WebSerialPort } from './transport/web-apis';

const CHANNEL_LABELS_STORAGE_KEY = 'hotwire.channelLabels.v1';

const INITIAL_TELEMETRY: StatusTelemetry = {
  physicalLevels: 0,
  forceEnableMask: 0,
  forcedLevels: 0,
  contentionMask: 0,
};

function createDefaultChannelConfigs(): ChannelUiState[] {
  return Array.from({ length: 8 }, () => ({ mode: 0, pull: 0, protect: true }));
}

function loadChannelLabels(): string[] {
  const empty = Array.from({ length: 8 }, () => '');
  if (typeof window === 'undefined') return empty;
  try {
    const raw = window.localStorage.getItem(CHANNEL_LABELS_STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length === 8) {
      return parsed.map((v) => (typeof v === 'string' ? v.slice(0, 14) : ''));
    }
  } catch {
    // Ignore storage errors
  }
  return empty;
}

function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const App: React.FC = () => {
  const transportRef = useRef<SerialTransport | null>(null);
  if (!transportRef.current) {
    transportRef.current = new SerialTransport();
  }

  const [snapshot, setSnapshot] = useState<TransportSnapshot>(() =>
    transportRef.current!.getSnapshot()
  );
  const [boardCaps, setBoardCaps] = useState<BoardCapabilities | null>(null);
  const [telemetry, setTelemetry] = useState<StatusTelemetry>(INITIAL_TELEMETRY);
  const [channelConfigs, setChannelConfigs] = useState<ChannelUiState[]>(
    createDefaultChannelConfigs
  );
  const [channelLabels, setChannelLabels] = useState<string[]>(loadChannelLabels);
  const [decoderConfig, setDecoderConfig] = useState<DecoderConfig>(DEFAULT_DECODER_CONFIG);
  const [selectedFrameId, setSelectedFrameId] = useState<number | null>(null);
  const [captureConfig, setCaptureConfig] = useState<CaptureConfig>({
    rateId: 6, // 1 MHz default
    blocksKb: 16, // 16k samples default
    triggerChannel: null, // Free Run
    edge: 1, // Rising
    preTrigger: 1, // 25%
  });
  const [capture, setCapture] = useState<CaptureDataFrame | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [continuous, setContinuous] = useState(false);

  const waveformRef = useRef<WaveformCanvasHandle | null>(null);
  const continuousRef = useRef(continuous);
  continuousRef.current = continuous;
  const captureConfigRef = useRef(captureConfig);
  captureConfigRef.current = captureConfig;
  const capturingRef = useRef(capturing);
  capturingRef.current = capturing;
  const statusRef = useRef(snapshot.status);
  statusRef.current = snapshot.status;

  const terminalWriterRef = useRef<((bytes: Uint8Array) => void) | null>(null);
  const continuousTimerRef = useRef<number | null>(null);
  const captureWatchdogRef = useRef<number | null>(null);
  const abortWatchdogRef = useRef<number | null>(null);

  const clearCaptureWatchdogs = useCallback(() => {
    if (captureWatchdogRef.current !== null) {
      window.clearTimeout(captureWatchdogRef.current);
      captureWatchdogRef.current = null;
    }
    if (abortWatchdogRef.current !== null) {
      window.clearTimeout(abortWatchdogRef.current);
      abortWatchdogRef.current = null;
    }
  }, []);

  const triggerCapture = useCallback(() => {
    const transport = transportRef.current;
    if (!transport || statusRef.current !== 'connected') return;
    const cfg = captureConfigRef.current;
    setCapturing(true);
    if (captureWatchdogRef.current !== null) {
      window.clearTimeout(captureWatchdogRef.current);
    }
    const rateHz = RATE_PRESETS[cfg.rateId]?.hz ?? 1_000_000;
    const timeoutMs = Math.ceil(((cfg.blocksKb * 1024) / rateHz) * 1000) + 6500;
    captureWatchdogRef.current = window.setTimeout(() => {
      captureWatchdogRef.current = null;
      setCapturing(false);
    }, timeoutMs);
    void transport.writeBytes(
      buildLaCaptureCmd({
        rateId: cfg.rateId,
        triggerChannel: cfg.triggerChannel,
        edge: cfg.edge,
        preTrigger: cfg.preTrigger,
        blocksKb: cfg.blocksKb,
      })
    );
  }, []);

  useEffect(() => {
    const transport = transportRef.current!;
    const demuxer = new ProtocolDemuxer({
      onPacket: (packet) => {
        if (packet.typeId === TYPE_STATUS_TELEMETRY) {
          const tel = packet.telemetry;
          setTelemetry((prev) =>
            prev.physicalLevels === tel.physicalLevels &&
            prev.forceEnableMask === tel.forceEnableMask &&
            prev.forcedLevels === tel.forcedLevels &&
            prev.contentionMask === tel.contentionMask
              ? prev
              : tel
          );
          setChannelConfigs((prev) => {
            let anyChanged = false;
            const next = prev.map((cfg, ch) => {
              const bit = 1 << ch;
              const isForced = (tel.forceEnableMask & bit) !== 0;
              const isHigh = (tel.forcedLevels & bit) !== 0;
              const nextMode: PinForceMode = isForced ? (isHigh ? 2 : 1) : 0;
              if (cfg.mode !== nextMode) {
                anyChanged = true;
                return { ...cfg, mode: nextMode };
              }
              return cfg;
            });
            return anyChanged ? next : prev;
          });
        } else if (packet.typeId === TYPE_BOARD_CAPABILITIES) {
          setBoardCaps(packet.capabilities);
        } else if (packet.typeId === TYPE_LA_CAPTURE_DATA) {
          clearCaptureWatchdogs();
          setCapture(packet.capture);
          setSelectedFrameId(null);
          setCapturing(false);
          if (continuousRef.current && statusRef.current === 'connected') {
            if (continuousTimerRef.current !== null) {
              window.clearTimeout(continuousTimerRef.current);
            }
            continuousTimerRef.current = window.setTimeout(() => {
              triggerCapture();
            }, 80);
          }
        }
      },
      onText: (bytes) => {
        terminalWriterRef.current?.(bytes);
      },
    });

    const unsubState = transport.onStateChange((next) => {
      setSnapshot(next);
      if (next.status !== 'connected') {
        demuxer.reset();
        setBoardCaps(null);
        setCapturing(false);
        setContinuous(false);
        clearCaptureWatchdogs();
        if (continuousTimerRef.current !== null) {
          window.clearTimeout(continuousTimerRef.current);
          continuousTimerRef.current = null;
        }
      }
    });

    const unsubBytes = transport.onBytes((bytes) => {
      demuxer.push(bytes);
    });

    transport.init();

    return () => {
      clearCaptureWatchdogs();
      if (continuousTimerRef.current !== null) {
        window.clearTimeout(continuousTimerRef.current);
      }
      unsubBytes();
      unsubState();
      transport.destroy();
    };
  }, [clearCaptureWatchdogs, triggerCapture]);

  const handleConnect = (backend?: 'webserial' | 'webusb') => {
    void transportRef.current?.connect(backend);
  };

  const handleStartDemo = () => {
    void transportRef.current?.startDemo();
  };

  const handleDisconnect = () => {
    setContinuous(false);
    setCapturing(false);
    setChannelConfigs(createDefaultChannelConfigs());
    setTelemetry(INITIAL_TELEMETRY);
    void transportRef.current?.disconnect();
  };

  const handleReleaseAll = () => {
    setChannelConfigs(createDefaultChannelConfigs());
    void transportRef.current?.writeBytes(buildReleaseAllCmd());
  };

  const handleRenameChannel = (ch: number, alias: string) => {
    setChannelLabels((prev) => {
      const next = prev.map((v, idx) => (idx === ch ? alias.slice(0, 14) : v));
      try {
        window.localStorage.setItem(CHANNEL_LABELS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  };

  const handleForceChannel = (
    ch: number,
    mode: PinForceMode,
    pull: PinPullMode,
    protect = true
  ) => {
    setChannelConfigs((prev) =>
      prev.map((cfg, idx) => (idx === ch ? { mode, pull, protect } : cfg))
    );
    void transportRef.current?.writeBytes(buildPinForceCmd(ch, mode, pull, protect));
  };

  const handleAbortCapture = useCallback(() => {
    setContinuous(false);
    void transportRef.current?.writeBytes(buildLaAbortCmd());
    if (abortWatchdogRef.current !== null) {
      window.clearTimeout(abortWatchdogRef.current);
    }
    abortWatchdogRef.current = window.setTimeout(() => {
      abortWatchdogRef.current = null;
      setCapturing(false);
    }, 350);
  }, []);

  const decodedFrames = useMemo<DecodedFrameAnnotation[]>(() => {
    if (!capture || decoderConfig.kind === 'none') return [];
    return decodeProtocol(capture.samples, capture.sampleRateHz, decoderConfig);
  }, [capture, decoderConfig]);

  const handleExportCsv = () => {
    if (!capture) return;
    downloadTextFile(
      'hotwire_capture.csv',
      exportCaptureToCsv(capture, channelLabels),
      'text/csv;charset=utf-8'
    );
  };

  const handleExportVcd = () => {
    if (!capture) return;
    downloadTextFile(
      'hotwire_capture.vcd',
      exportCaptureToVcd(capture, channelLabels),
      'text/plain;charset=utf-8'
    );
  };

  const handleSelectFrame = useCallback((frame: DecodedFrameAnnotation) => {
    setSelectedFrameId(frame.id);
    waveformRef.current?.focusSampleRange(frame.startSample, frame.endSample);
  }, []);

  // Global keyboard shortcuts for waveform navigation & capture
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === 'INPUT' ||
          tag === 'SELECT' ||
          tag === 'TEXTAREA' ||
          target.isContentEditable ||
          target.classList.contains('xterm-helper-textarea')
        ) {
          return;
        }
      }

      if (e.code === 'Space') {
        if (statusRef.current !== 'connected') return;
        e.preventDefault();
        if (capturingRef.current) handleAbortCapture();
        else triggerCapture();
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        waveformRef.current?.zoomIn();
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        waveformRef.current?.zoomOut();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        waveformRef.current?.panByFraction(-0.2);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        waveformRef.current?.panByFraction(0.2);
      } else if (e.key === 'f' || e.key === 'F') {
        waveformRef.current?.fitAll();
      } else if (e.key === 't' || e.key === 'T') {
        waveformRef.current?.jumpToTrigger();
      } else if (e.key === 'c' || e.key === 'C') {
        waveformRef.current?.toggleCursors();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleAbortCapture, triggerCapture]);

  const handleToggleContinuous = () => {
    const next = !continuous;
    setContinuous(next);
    if (next && !capturing) {
      continuousRef.current = true;
      triggerCapture();
    }
  };

  const handleSendText = (text: string) => {
    void transportRef.current?.writeBytes(new TextEncoder().encode(text));
  };

  const handleRegisterTerminalWriter = useCallback((writer: (bytes: Uint8Array) => void) => {
    terminalWriterRef.current = writer;
    return () => {
      if (terminalWriterRef.current === writer) {
        terminalWriterRef.current = null;
      }
    };
  }, []);

  const handlePrepareBootloaderPort = useCallback(
    async (forcePromptPort = false): Promise<WebSerialPort | null> => {
      const transport = transportRef.current!;
      transport.setAutoReconnectPaused(true);

      let chosenPort: WebSerialPort | null = null;
      const snap = transport.getSnapshot();
      const hadWebSerial = snap.status === 'connected' && snap.transport === 'webserial';

      if ((forcePromptPort || !hadWebSerial) && navigator.serial) {
        try {
          chosenPort = await navigator.serial.requestPort();
        } catch (err) {
          transport.setAutoReconnectPaused(false);
          throw err;
        }
      }

      const prevPort = await transport.disconnect(true);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 150));

      return chosenPort ?? (hadWebSerial ? prevPort : null);
    },
    []
  );

  const handleFlashComplete = useCallback(async (flashedPort?: WebSerialPort | null) => {
    const transport = transportRef.current;
    if (!transport) return;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 600));
    transport.setAutoReconnectPaused(false);
    if (flashedPort) {
      await transport.connectWebSerialPort(flashedPort);
    } else {
      await transport.probeAuthorizedDevices();
    }
  }, []);

  const displayDeviceName = boardCaps?.board || snapshot.deviceName;
  const hasActiveOutputs = telemetry.forceEnableMask !== 0 || telemetry.contentionMask !== 0;

  return (
    <div className="app-shell">
      <TopToolbar
        connectionStatus={snapshot.status}
        transportKind={snapshot.transport}
        deviceName={displayDeviceName}
        errorMessage={snapshot.errorMessage}
        captureConfig={captureConfig}
        capturing={capturing}
        continuous={continuous}
        hasActiveOutputs={hasActiveOutputs}
        decoderConfig={decoderConfig}
        hasCapture={Boolean(capture)}
        channelLabels={channelLabels}
        onConnect={handleConnect}
        onStartDemo={handleStartDemo}
        onDisconnect={handleDisconnect}
        onUpdateCaptureConfig={(partial) =>
          setCaptureConfig((prev) => ({ ...prev, ...partial }))
        }
        onCapture={triggerCapture}
        onAbort={handleAbortCapture}
        onToggleContinuous={handleToggleContinuous}
        onReleaseAll={handleReleaseAll}
        onUpdateDecoderConfig={(next) => {
          setSelectedFrameId(null);
          setDecoderConfig(next);
        }}
        onExportCsv={handleExportCsv}
        onExportVcd={handleExportVcd}
      />

      <main className="workspace-split">
        <ChannelStrip
          connected={snapshot.status === 'connected'}
          telemetry={telemetry}
          channelConfigs={channelConfigs}
          channelLabels={channelLabels}
          boardPins={boardCaps?.pins}
          onForceChannel={handleForceChannel}
          onRenameChannel={handleRenameChannel}
        />
        <WaveformCanvas
          ref={waveformRef}
          capture={capture}
          capturing={capturing}
          decodedFrames={decodedFrames}
          selectedFrameId={selectedFrameId}
          onSelectFrame={handleSelectFrame}
          channelLabels={channelLabels}
        />
      </main>

      {capture && decoderConfig.kind !== 'none' && (
        <section className="decoded-strip" aria-label="Decoded protocol frames">
          <span className="decoded-strip-title">
            {decoderConfig.kind.toUpperCase()} ({decodedFrames.length})
          </span>
          {decodedFrames.length === 0 ? (
            <span className="decoded-strip-empty">
              No valid {decoderConfig.kind.toUpperCase()} frames found in capture — check channel/baud settings
            </span>
          ) : (
            <div className="decoded-strip-list">
              {decodedFrames.slice(0, 200).map((frame) => {
                const tSec = (frame.startSample - capture.triggerIndex) / Math.max(1, capture.sampleRateHz);
                return (
                  <button
                    key={frame.id}
                    type="button"
                    className={`decoded-chip decoded-chip-${frame.kind} ${
                      selectedFrameId === frame.id ? 'selected' : ''
                    }`}
                    title={`${frame.detail} @ ${formatSignedDuration(tSec)}`}
                    onClick={() => handleSelectFrame(frame)}
                  >
                    <span className="decoded-chip-time">{formatSignedDuration(tSec)}</span>
                    <span className="decoded-chip-val">{frame.label}</span>
                  </button>
                );
              })}
              {decodedFrames.length > 200 && (
                <span className="decoded-strip-more">+{decodedFrames.length - 200} more</span>
              )}
            </div>
          )}
        </section>
      )}

      <BottomDrawer
        connected={snapshot.status === 'connected'}
        isDemo={snapshot.transport === 'demo'}
        onSendText={handleSendText}
        onRegisterTerminalWriter={handleRegisterTerminalWriter}
        onPrepareBootloaderPort={handlePrepareBootloaderPort}
        onFlashComplete={handleFlashComplete}
      />
    </div>
  );
};
