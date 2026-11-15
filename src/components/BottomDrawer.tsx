import '@xterm/xterm/css/xterm.css';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CanvasAddon } from '@xterm/addon-canvas';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import {
  ESPLoader,
  IEspLoaderTerminal,
  Transport as EspTransport,
} from 'esptool-js';
import { WebSerialPort } from '../transport/web-apis';

export type DrawerTab = 'terminal' | 'flasher';
export type LineEnding = 'CRLF' | 'LF';
export type FlashTargetBoard = 'auto' | 'esp32s3' | 'esp32c6';

const BOARD_FLASH_PROFILES = {
  esp32s3: {
    label: 'XIAO-ESP32-S3',
    prefix: 'HotWire_XIAO_ESP32S3.ino',
    flashSize: '8MB' as const,
  },
  esp32c6: {
    label: 'XIAO-ESP32-C6',
    prefix: 'HotWire_XIAO_ESP32C6.ino',
    flashSize: '4MB' as const,
  },
};

interface BottomDrawerProps {
  connected: boolean;
  isDemo: boolean;
  onSendText: (text: string) => void;
  onRegisterTerminalWriter: (writer: (bytes: Uint8Array) => void) => () => void;
  onPrepareBootloaderPort: (forcePromptPort?: boolean) => Promise<WebSerialPort | null>;
  onFlashComplete: (flashedPort?: WebSerialPort | null) => Promise<void>;
}

const TERMINAL_MACROS = ['help', 'status', 'pins', 'release', 'version'] as const;

export const BottomDrawer: React.FC<BottomDrawerProps> = ({
  connected,
  isDemo,
  onSendText,
  onRegisterTerminalWriter,
  onPrepareBootloaderPort,
  onFlashComplete,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<DrawerTab>('terminal');
  const [inputText, setInputText] = useState('');
  const [lineEnding, setLineEnding] = useState<LineEnding>('CRLF');

  // Flasher state
  const [targetBoard, setTargetBoard] = useState<FlashTargetBoard>('auto');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [flashOffset, setFlashOffset] = useState<'0x10000' | '0x0' | 'full'>('full');
  const [flashing, setFlashing] = useState(false);
  const [flashProgress, setFlashProgress] = useState(0);
  const [flashLogs, setFlashLogs] = useState<string[]>([
    'Ready. Select a .bin image or use the bundled XIAO-ESP32-S3 / XIAO-ESP32-C6 firmware.',
  ]);

  const termContainerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const pendingChunksRef = useRef<Uint8Array[]>([]);

  const appendFlashLog = useCallback((line: string) => {
    setFlashLogs((prev) => [...prev.slice(-80), line]);
  }, []);

  // Initialize xterm.js terminal
  useEffect(() => {
    const el = termContainerRef.current;
    if (!el) return;

    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      theme: {
        background: '#0D1117',
        foreground: '#E6EDF3',
        cursor: '#58A6FF',
        selectionBackground: '#264F78',
      },
      scrollback: 2000,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);

    try {
      term.loadAddon(new CanvasAddon());
    } catch {
      // Fallback to DOM renderer when canvas addon is unavailable
    }

    try {
      fit.fit();
    } catch {
      // Container may be hidden when collapsed
    }

    termRef.current = term;
    fitAddonRef.current = fit;

    // Flush any bytes queued before mount
    if (pendingChunksRef.current.length > 0) {
      for (const chunk of pendingChunksRef.current) {
        term.write(chunk);
      }
      pendingChunksRef.current = [];
    }

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // Ignore resize error while collapsed
      }
    });
    observer.observe(el);

    return () => {
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  // Register terminal byte writer
  useEffect(() => {
    return onRegisterTerminalWriter((bytes) => {
      if (termRef.current) {
        termRef.current.write(bytes);
      } else {
        pendingChunksRef.current.push(bytes);
      }
    });
  }, [onRegisterTerminalWriter]);

  // Refit terminal when drawer expands or switches to terminal tab
  useEffect(() => {
    if (expanded && activeTab === 'terminal') {
      const id = window.setTimeout(() => {
        try {
          fitAddonRef.current?.fit();
        } catch {
          // Ignore fit errors
        }
      }, 40);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [expanded, activeTab]);

  const sendLine = (raw: string) => {
    const suffix = lineEnding === 'CRLF' ? '\r\n' : '\n';
    onSendText(`${raw}${suffix}`);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!connected) return;
    sendLine(inputText);
    setInputText('');
  };

  const handleFlash = async (forcePromptPort = false) => {
    if (flashing) return;
    if (typeof navigator === 'undefined' || !navigator.serial) {
      appendFlashLog('ERROR: Web Serial API (navigator.serial) is required for esptool-js flashing.');
      return;
    }
    if (isDemo) {
      appendFlashLog('Demo mode active — connect a physical XIAO-ESP32-S3 or XIAO-ESP32-C6 via USB to flash.');
      return;
    }

    setFlashing(true);
    setFlashProgress(0);
    setFlashLogs(['[1/4] Selecting serial port & connecting to ROM bootloader...']);

    const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
    let espTransport: EspTransport | null = null;
    let port: WebSerialPort | null = null;
    let flashedSucceeded = false;

    try {
      // Prompt / release active transport FIRST inside the user click gesture
      port = await onPrepareBootloaderPort(forcePromptPort);
      if (!port) {
        appendFlashLog('Select the XIAO ESP32-S3 / ESP32-C6 COM port in the browser prompt...');
        port = await navigator.serial.requestPort();
      }

      const terminalAdapter: IEspLoaderTerminal = {
        clean: () => setFlashLogs([]),
        writeLine: (line: string) => appendFlashLog(line),
        write: (text: string) => {
          const clean = text.replace(/\r/g, '').trim();
          if (clean.length > 0) appendFlashLog(clean);
        },
      };

      type SerialPortArg = ConstructorParameters<typeof EspTransport>[0];
      espTransport = new EspTransport(port as unknown as SerialPortArg, false);

      const loader = new ESPLoader({
        transport: espTransport,
        baudrate: 115200,
        romBaudrate: 115200,
        terminal: terminalAdapter,
        resetConstructors: {
          usbJTAGSerialReset: (transport) => ({
            transport,
            async reset() {
              await transport.setRTS(false);
              await transport.setDTR(false);
              await sleep(100);
              await transport.setDTR(true);
              await transport.setRTS(false);
              await sleep(100);
              await transport.setRTS(true);
              await transport.setDTR(false);
              await transport.setRTS(true);
              await sleep(100);
              await transport.setRTS(false);
              await transport.setDTR(false);
              await sleep(120);
            },
          }),
        },
      });

      appendFlashLog('[2/4] Entering & syncing with ESP32 ROM bootloader...');
      let chipName = '';
      try {
        chipName = await loader.main('default_reset');
      } catch {
        appendFlashLog('Reset sync did not answer; retrying direct no_reset sync...');
        try {
          await espTransport.disconnect();
        } catch {
          // Ignore close cleanup before retry
        }
        await sleep(150);
        chipName = await loader.main('no_reset');
      }

      const detectedUpper = (chipName || loader.chip?.CHIP_NAME || '').toUpperCase();
      let resolvedKey: 'esp32s3' | 'esp32c6';
      if (targetBoard === 'esp32c6' || targetBoard === 'esp32s3') {
        resolvedKey = targetBoard;
        if (detectedUpper && !detectedUpper.includes(resolvedKey === 'esp32c6' ? 'ESP32-C6' : 'ESP32-S3')) {
          appendFlashLog(`WARNING: Detected "${chipName}" does not match manual target "${resolvedKey}".`);
        }
      } else if (detectedUpper.includes('ESP32-C6')) {
        resolvedKey = 'esp32c6';
      } else if (detectedUpper.includes('ESP32-S3')) {
        resolvedKey = 'esp32s3';
      } else {
        throw new Error(
          `Unsupported chip "${chipName || 'unknown'}". Expected ESP32-S3 or ESP32-C6 (or select board manually).`
        );
      }

      const profile = BOARD_FLASH_PROFILES[resolvedKey];
      appendFlashLog(`Target hardware: ${profile.label} (detected: ${chipName || 'unknown'})`);

      // Load firmware binaries matching the detected/selected target chip
      const fileArray: Array<{ data: Uint8Array; address: number }> = [];

      if (selectedFile) {
        const buf = new Uint8Array(await selectedFile.arrayBuffer());
        const addr = flashOffset === '0x0' ? 0x0 : 0x10000;
        fileArray.push({ data: buf, address: addr });
        appendFlashLog(`Loaded ${selectedFile.name} (${buf.byteLength} bytes) -> 0x${addr.toString(16)}`);
      } else if (flashOffset === 'full') {
        const [bootRes, partRes, bootApp0Res, appRes] = await Promise.all([
          fetch(`./firmware/${profile.prefix}.bootloader.bin`),
          fetch(`./firmware/${profile.prefix}.partitions.bin`),
          fetch('./firmware/boot_app0.bin'),
          fetch(`./firmware/${profile.prefix}.bin`),
        ]);
        if (!bootRes.ok || !partRes.ok || !bootApp0Res.ok || !appRes.ok) {
          throw new Error(`Failed to fetch bundled ${profile.label} firmware binaries.`);
        }
        fileArray.push(
          { data: new Uint8Array(await bootRes.arrayBuffer()), address: 0x0 },
          { data: new Uint8Array(await partRes.arrayBuffer()), address: 0x8000 },
          { data: new Uint8Array(await bootApp0Res.arrayBuffer()), address: 0xe000 },
          { data: new Uint8Array(await appRes.arrayBuffer()), address: 0x10000 }
        );
        appendFlashLog(
          `Loaded ${profile.prefix}: Bootloader (0x0), Partitions (0x8000), boot_app0 (0xe000), and App (0x10000).`
        );
      } else {
        const appRes = await fetch(`./firmware/${profile.prefix}.bin`);
        if (!appRes.ok) {
          throw new Error(`Failed to fetch bundled ${profile.prefix}.bin.`);
        }
        const appBuf = new Uint8Array(await appRes.arrayBuffer());
        fileArray.push({ data: appBuf, address: 0x10000 });
        appendFlashLog(`Loaded bundled ${profile.prefix}.bin (${appBuf.byteLength} bytes) -> 0x10000`);
      }

      appendFlashLog('[3/4] Writing flash...');
      const totalBytes = fileArray.reduce((acc, f) => acc + f.data.byteLength, 0);
      let completedPrevFiles = 0;
      const isBundledFull = !selectedFile && flashOffset === 'full';

      await loader.writeFlash({
        fileArray,
        flashSize: isBundledFull ? profile.flashSize : 'keep',
        flashMode: isBundledFull ? 'dio' : 'keep',
        flashFreq: isBundledFull ? '80m' : 'keep',
        eraseAll: false,
        compress: true,
        reportProgress: (fileIndex: number, written: number, total: number) => {
          if (fileIndex > 0) {
            completedPrevFiles = fileArray
              .slice(0, fileIndex)
              .reduce((acc, f) => acc + f.data.byteLength, 0);
          }
          const ratio = totalBytes > 0 ? (completedPrevFiles + written) / totalBytes : written / Math.max(1, total);
          setFlashProgress(Math.min(100, Math.round(ratio * 100)));
        },
      });

      appendFlashLog(`[4/4] Hard resetting ${profile.label}...`);
      await loader.after('hard_reset');
      await espTransport.setDTR(false);
      await espTransport.setRTS(true);
      await sleep(100);
      await espTransport.setRTS(false);
      await sleep(80);
      setFlashProgress(100);
      flashedSucceeded = true;
      appendFlashLog('Flash complete! Reconnecting HotWire...');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendFlashLog(`FLASH ERROR: ${msg}`);
    } finally {
      if (espTransport) {
        try {
          await espTransport.disconnect();
        } catch {
          // Ignore disconnect error
        }
      }
      setFlashing(false);
      await onFlashComplete(flashedSucceeded ? port : null);
    }
  };

  return (
    <section className={`bottom-drawer ${expanded ? 'drawer-expanded' : 'drawer-collapsed'}`}>
      <div className="drawer-header">
        <div className="drawer-tabs">
          <button
            type="button"
            className={`drawer-tab ${activeTab === 'terminal' ? 'active' : ''}`}
            onClick={() => {
              setActiveTab('terminal');
              setExpanded(true);
            }}
          >
            Serial Terminal
          </button>
          <button
            type="button"
            className={`drawer-tab ${activeTab === 'flasher' ? 'active' : ''}`}
            onClick={() => {
              setActiveTab('flasher');
              setExpanded(true);
            }}
          >
            Web Flasher (esptool-js)
          </button>
        </div>

        <button
          type="button"
          className="btn btn-secondary btn-compact"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? '▼ Collapse' : '▲ Expand Drawer'}
        </button>
      </div>

      <div className="drawer-body" style={{ display: expanded ? 'flex' : 'none' }}>
        <div
          className="drawer-panel terminal-panel"
          style={{ display: activeTab === 'terminal' ? 'flex' : 'none' }}
        >
          <div className="terminal-macros">
            {TERMINAL_MACROS.map((macro) => (
              <button
                key={macro}
                type="button"
                className="macro-chip"
                disabled={!connected}
                onClick={() => sendLine(macro)}
              >
                {macro}
              </button>
            ))}
            <button
              type="button"
              className="macro-chip macro-clear"
              onClick={() => termRef.current?.clear()}
            >
              Clear
            </button>
          </div>

          <div className="terminal-xterm-host" ref={termContainerRef} />

          <form className="terminal-input-bar" onSubmit={handleSubmit}>
            <input
              type="text"
              className="terminal-input"
              placeholder={
                connected ? 'Send ASCII command to XIAO ESP32-S3 / ESP32-C6...' : 'Connect device to send serial commands'
              }
              value={inputText}
              disabled={!connected}
              onChange={(e) => setInputText(e.target.value)}
            />
            <select
              aria-label="Line ending"
              className="ctrl-select"
              value={lineEnding}
              onChange={(e) => setLineEnding(e.target.value as LineEnding)}
            >
              <option value="CRLF">CR+LF</option>
              <option value="LF">LF</option>
            </select>
            <button type="submit" className="btn btn-primary" disabled={!connected}>
              Send
            </button>
          </form>
        </div>

        <div
          className="drawer-panel flasher-panel"
          style={{ display: activeTab === 'flasher' ? 'flex' : 'none' }}
        >
          <div className="flasher-controls">
            <label className="ctrl-field">
              <span className="ctrl-label">Board</span>
              <select
                aria-label="Target board"
                className="ctrl-select"
                value={targetBoard}
                disabled={flashing}
                onChange={(e) => setTargetBoard(e.target.value as FlashTargetBoard)}
              >
                <option value="auto">Auto-Detect (ESP32-S3 / ESP32-C6)</option>
                <option value="esp32s3">Seeed XIAO ESP32-S3 (8MB)</option>
                <option value="esp32c6">Seeed XIAO ESP32-C6 (4MB)</option>
              </select>
            </label>

            <label className="ctrl-field">
              <span className="ctrl-label">Target Image</span>
              <select
                className="ctrl-select"
                value={flashOffset}
                disabled={flashing}
                onChange={(e) => setFlashOffset(e.target.value as '0x10000' | '0x0' | 'full')}
              >
                <option value="full">Bundled Full Image (Boot + Partitions + App) — Recommended</option>
                <option value="0x10000">App Firmware @ 0x10000</option>
                <option value="0x0">Merged .bin @ 0x0</option>
              </select>
            </label>

            <label className="file-picker-label">
              <span>
                {selectedFile
                  ? selectedFile.name
                  : targetBoard === 'auto'
                    ? 'Using bundled firmware (S3 / C6 auto)'
                    : `Using bundled ${BOARD_FLASH_PROFILES[targetBoard].prefix}.bin`}
              </span>
              <input
                type="file"
                accept=".bin"
                disabled={flashing}
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null;
                  setSelectedFile(file);
                  if (file && flashOffset === 'full') {
                    setFlashOffset('0x10000');
                  }
                }}
              />
            </label>

            {selectedFile && (
              <button
                type="button"
                className="btn btn-secondary btn-compact"
                disabled={flashing}
                onClick={() => setSelectedFile(null)}
              >
                Use Bundled
              </button>
            )}

            {connected && (
              <button
                type="button"
                className="btn btn-secondary btn-compact"
                disabled={flashing}
                onClick={() => void handleFlash(true)}
              >
                Select Port &amp; Flash...
              </button>
            )}

            <button
              type="button"
              className="btn btn-accent"
              disabled={flashing}
              onClick={() => void handleFlash(false)}
            >
              {flashing ? `Flashing ${flashProgress}%...` : 'Reboot to Bootloader & Flash .bin'}
            </button>
          </div>

          <div className="flash-progress-track" aria-label="Flashing progress">
            <div className="flash-progress-fill" style={{ width: `${flashProgress}%` }} />
          </div>

          <pre className="flash-log-box">{flashLogs.join('\n')}</pre>
        </div>
      </div>
    </section>
  );
};
