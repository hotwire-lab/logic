import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BottomDrawer } from './components/BottomDrawer';
import { ChannelStrip, ChannelUiState } from './components/ChannelStrip';
import { CaptureConfig, TopToolbar } from './components/TopToolbar';
import { WaveformCanvas } from './components/WaveformCanvas';
import { ProtocolDemuxer } from './protocol/ProtocolDemuxer';
import {
  buildLaAbortCmd,
  buildLaCaptureCmd,
  buildPinForceCmd,
  buildReleaseAllCmd,
} from './protocol/codec';
import {
  BoardCapabilities,
  CaptureDataFrame,
  PinForceMode,
  PinPullMode,
  StatusTelemetry,
  TYPE_BOARD_CAPABILITIES,
  TYPE_LA_CAPTURE_DATA,
  TYPE_STATUS_TELEMETRY,
} from './protocol/types';
import { SerialTransport, TransportSnapshot } from './transport/SerialTransport';
import { WebSerialPort } from './transport/web-apis';

const INITIAL_TELEMETRY: StatusTelemetry = {
  physicalLevels: 0,
  forceEnableMask: 0,
  forcedLevels: 0,
  contentionMask: 0,
};

function createDefaultChannelConfigs(): ChannelUiState[] {
  return Array.from({ length: 8 }, () => ({ mode: 0, pull: 0, protect: true }));
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

  const continuousRef = useRef(continuous);
  continuousRef.current = continuous;
  const captureConfigRef = useRef(captureConfig);
  captureConfigRef.current = captureConfig;
  const statusRef = useRef(snapshot.status);
  statusRef.current = snapshot.status;

  const terminalWriterRef = useRef<((bytes: Uint8Array) => void) | null>(null);
  const continuousTimerRef = useRef<number | null>(null);

  const triggerCapture = useCallback(() => {
    const transport = transportRef.current;
    if (!transport || statusRef.current !== 'connected') return;
    const cfg = captureConfigRef.current;
    setCapturing(true);
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
          setTelemetry(tel);
          setChannelConfigs((prev) =>
            prev.map((cfg, ch) => {
              const bit = 1 << ch;
              const isForced = (tel.forceEnableMask & bit) !== 0;
              const isHigh = (tel.forcedLevels & bit) !== 0;
              const nextMode: PinForceMode = isForced ? (isHigh ? 2 : 1) : 0;
              if (cfg.mode !== nextMode) {
                return { ...cfg, mode: nextMode };
              }
              return cfg;
            })
          );
        } else if (packet.typeId === TYPE_BOARD_CAPABILITIES) {
          setBoardCaps(packet.capabilities);
        } else if (packet.typeId === TYPE_LA_CAPTURE_DATA) {
          setCapture(packet.capture);
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
      if (continuousTimerRef.current !== null) {
        window.clearTimeout(continuousTimerRef.current);
      }
      unsubBytes();
      unsubState();
      transport.destroy();
    };
  }, [triggerCapture]);

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

  const handleAbortCapture = () => {
    setContinuous(false);
    void transportRef.current?.writeBytes(buildLaAbortCmd());
  };

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

  const hasWebSerial = typeof navigator !== 'undefined' && 'serial' in navigator && Boolean(navigator.serial);
  const hasWebUSB = typeof navigator !== 'undefined' && 'usb' in navigator && Boolean(navigator.usb);
  const displayDeviceName = boardCaps?.board || snapshot.deviceName;

  return (
    <div className="app-shell">
      <TopToolbar
        connectionStatus={snapshot.status}
        transportKind={snapshot.transport}
        deviceName={displayDeviceName}
        errorMessage={snapshot.errorMessage}
        hasWebSerial={hasWebSerial}
        hasWebUSB={hasWebUSB}
        captureConfig={captureConfig}
        capturing={capturing}
        continuous={continuous}
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
      />

      <main className="workspace-split">
        <ChannelStrip
          connected={snapshot.status === 'connected'}
          telemetry={telemetry}
          channelConfigs={channelConfigs}
          onForceChannel={handleForceChannel}
        />
        <WaveformCanvas capture={capture} capturing={capturing} />
      </main>

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
