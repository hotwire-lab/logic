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

interface BottomDrawerProps {
  connected: boolean;
  isDemo: boolean;
  onSendText: (text: string) => void;
  onRegisterTerminalWriter: (writer: (bytes: Uint8Array) => void) => () => void;
  onPrepareBootloaderPort: () => Promise<WebSerialPort | null>;
  onFlashComplete: () => Promise<void>;
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
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [flashOffset, setFlashOffset] = useState<'0x10000' | '0x0' | 'full'>('0x10000');
  const [flashing, setFlashing] = useState(false);
  const [flashProgress, setFlashProgress] = useState(0);
  const [flashLogs, setFlashLogs] = useState<string[]>([
    'Ready. Select a .bin image or use the bundled XIAO-ESP32-S3 firmware.',
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

  const handleFlash = async () => {
    if (flashing) return;
    if (typeof navigator === 'undefined' || !navigator.serial) {
      appendFlashLog('ERROR: Web Serial API (navigator.serial) is required for esptool-js flashing.');
      return;
    }
    if (isDemo) {
      appendFlashLog('Demo mode active — connect a physical XIAO-ESP32-S3 via USB to flash.');
      return;
    }

    setFlashing(true);
    setFlashProgress(0);
    setFlashLogs(['[1/4] Preparing firmware image & rebooting XIAO-ESP32-S3 to bootloader...']);

    let espTransport: EspTransport | null = null;

    try {
      // Load firmware bytes first before touching serial state
      const fileArray: Array<{ data: Uint8Array; address: number }> = [];

      if (selectedFile) {
        const buf = new Uint8Array(await selectedFile.arrayBuffer());
        const addr = flashOffset === '0x0' ? 0x0 : 0x10000;
        fileArray.push({ data: buf, address: addr });
        appendFlashLog(`Loaded ${selectedFile.name} (${buf.byteLength} bytes) -> 0x${addr.toString(16)}`);
      } else if (flashOffset === 'full') {
        const [bootRes, partRes, appRes] = await Promise.all([
          fetch('./firmware/HotWire_XIAO_ESP32S3.ino.bootloader.bin'),
          fetch('./firmware/HotWire_XIAO_ESP32S3.ino.partitions.bin'),
          fetch('./firmware/HotWire_XIAO_ESP32S3.ino.bin'),
        ]);
        if (!bootRes.ok || !partRes.ok || !appRes.ok) {
          throw new Error('Failed to fetch bundled firmware binaries.');
        }
        fileArray.push(
          { data: new Uint8Array(await bootRes.arrayBuffer()), address: 0x0 },
          { data: new Uint8Array(await partRes.arrayBuffer()), address: 0x8000 },
          { data: new Uint8Array(await appRes.arrayBuffer()), address: 0x10000 }
        );
        appendFlashLog('Loaded bundled Bootloader (0x0), Partitions (0x8000), and App (0x10000).');
      } else {
        const appRes = await fetch('./firmware/HotWire_XIAO_ESP32S3.ino.bin');
        if (!appRes.ok) {
          throw new Error('Failed to fetch bundled HotWire_XIAO_ESP32S3.ino.bin.');
        }
        const appBuf = new Uint8Array(await appRes.arrayBuffer());
        fileArray.push({ data: appBuf, address: 0x10000 });
        appendFlashLog(`Loaded bundled HotWire_XIAO_ESP32S3.ino.bin (${appBuf.byteLength} bytes) -> 0x10000`);
      }

      // Send 0xF0 CMD_BOOTLOADER (if connected) and acquire Web Serial port
      let port = await onPrepareBootloaderPort();
      if (!port) {
        appendFlashLog('Select the ESP32-S3 Bootloader COM port in the browser prompt...');
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
        baudrate: 921600,
        romBaudrate: 921600,
        terminal: terminalAdapter,
      });

      appendFlashLog('[2/4] Syncing with ESP32-S3 ROM bootloader...');
      try {
        await loader.main('no_reset');
      } catch {
        appendFlashLog('Retrying sync with hardware reset...');
        await loader.main('default_reset');
      }

      appendFlashLog('[3/4] Writing flash...');
      const totalBytes = fileArray.reduce((acc, f) => acc + f.data.byteLength, 0);
      let completedPrevFiles = 0;

      await loader.writeFlash({
        fileArray,
        flashSize: 'keep',
        flashMode: 'keep',
        flashFreq: 'keep',
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

      appendFlashLog('[4/4] Hard resetting XIAO-ESP32-S3...');
      await loader.after('hard_reset');
      setFlashProgress(100);
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
      await onFlashComplete();
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
              placeholder={connected ? 'Send ASCII command to XIAO ESP32-S3...' : 'Connect device to send serial commands'}
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
              <span className="ctrl-label">Target Image</span>
              <select
                className="ctrl-select"
                value={flashOffset}
                disabled={flashing}
                onChange={(e) => setFlashOffset(e.target.value as '0x10000' | '0x0' | 'full')}
              >
                <option value="0x10000">App Firmware @ 0x10000</option>
                <option value="full">Bundled Full Image (Boot + Partitions + App)</option>
                <option value="0x0">Merged .bin @ 0x0</option>
              </select>
            </label>

            <label className="file-picker-label">
              <span>{selectedFile ? selectedFile.name : 'Using bundled HotWire_XIAO_ESP32S3.ino.bin'}</span>
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

            <button
              type="button"
              className="btn btn-accent"
              disabled={flashing}
              onClick={() => void handleFlash()}
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
