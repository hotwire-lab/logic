// Browser Web Serial, WebUSB CDC-ACM, WakeLock, and esptool-js Web Flasher bridge for HotWire Logic Analyzer.

const WEBUSB_FILTERS = [
  { vendorId: 0x303a },
  { vendorId: 0x2886 },
  { classCode: 2, subclassCode: 2 },
  { classCode: 239, subclassCode: 2, protocolCode: 1 },
];

function formatVidPid(vid, pid) {
  if (!vid && !pid) return '';
  const v = (vid ?? 0).toString(16).toUpperCase().padStart(4, '0');
  const p = (pid ?? 0).toString(16).toUpperCase().padStart(4, '0');
  return `${v}:${p}`;
}

function encodeCdcLineCoding(baudRate = 115200) {
  const buf = new ArrayBuffer(7);
  const view = new DataView(buf);
  view.setUint32(0, baudRate, true);
  view.setUint8(4, 0);
  view.setUint8(5, 0);
  view.setUint8(6, 8);
  return new Uint8Array(buf);
}

function findCdcEndpoints(device) {
  const config = device.configuration ?? device.configurations?.[0];
  if (!config) return null;
  const interfaces = config.interfaces;
  for (let i = 0; i < interfaces.length; i++) {
    const iface = interfaces[i];
    const alt = iface.alternate;
    if (alt.interfaceClass === 0xff) continue;

    let inEp = null;
    let outEp = null;
    let inPacketSize = 64;
    for (const ep of alt.endpoints) {
      if (ep.type !== 'bulk') continue;
      if (ep.direction === 'in' && inEp === null) {
        inEp = ep.endpointNumber;
        inPacketSize = ep.packetSize || 64;
      }
      if (ep.direction === 'out' && outEp === null) {
        outEp = ep.endpointNumber;
      }
    }
    if (inEp !== null && outEp !== null) {
      let controlIface = iface.interfaceNumber;
      if (alt.interfaceClass === 10) {
        for (let j = i - 1; j >= 0; j--) {
          if (interfaces[j].alternate.interfaceClass === 2) {
            controlIface = interfaces[j].interfaceNumber;
            break;
          }
        }
      }
      return {
        controlInterfaceNumber: controlIface,
        dataInterfaceNumber: iface.interfaceNumber,
        inEndpointNumber: inEp,
        outEndpointNumber: outEp,
        inPacketSize,
      };
    }
  }
  return null;
}

function detectPreferredBackend() {
  if (typeof navigator === 'undefined') return 'none';
  const ua = navigator.userAgent ?? '';
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  const hasWebSerial = 'serial' in navigator && Boolean(navigator.serial);
  const hasWebUSB = 'usb' in navigator && Boolean(navigator.usb);
  if (isMobile && hasWebUSB) return 'webusb';
  if (hasWebSerial) return 'webserial';
  if (hasWebUSB) return 'webusb';
  return 'none';
}

class WebUsbCdcSerialPort {
  constructor(device) {
    this.device = device;
    this.readable = null;
    this.writable = null;
    this.desc = null;
    this.currentDtr = false;
    this.currentRts = false;
    this.readLoopRunning = false;
    this.controlQueue = Promise.resolve();
  }

  getInfo() {
    return { usbVendorId: this.device.vendorId, usbProductId: this.device.productId };
  }

  async open(options = { baudRate: 115200 }) {
    if (this.device.opened) await this.close();
    await this.device.open();
    if (!this.device.configuration) await this.device.selectConfiguration(1);
    const desc = findCdcEndpoints(this.device);
    if (!desc) {
      await this.device.close();
      throw new Error('No USB CDC-ACM bulk endpoints found on selected device.');
    }
    if (desc.controlInterfaceNumber !== desc.dataInterfaceNumber) {
      try { await this.device.claimInterface(desc.controlInterfaceNumber); } catch {}
    }
    await this.device.claimInterface(desc.dataInterfaceNumber);
    this.desc = desc;
    await this.setBaudRate(options.baudRate || 115200);
    this.currentDtr = false;
    this.currentRts = false;
    await this.setSignals({ dataTerminalReady: false, requestToSend: false });
    this.createStreams();
  }

  async setBaudRate(baudRate) {
    await this.enqueueControl(async () => {
      if (!this.device.opened || !this.desc) throw new Error('USB CDC device is not open');
      try {
        await this.device.controlTransferOut(
          {
            requestType: 'class',
            recipient: 'interface',
            request: 0x20,
            value: 0,
            index: this.desc.controlInterfaceNumber,
          },
          encodeCdcLineCoding(baudRate),
        );
      } catch {}
    });
  }

  async setSignals(signals = {}) {
    if (signals.dataTerminalReady !== undefined) this.currentDtr = signals.dataTerminalReady;
    if (signals.requestToSend !== undefined) this.currentRts = signals.requestToSend;
    const value = (this.currentDtr ? 0x01 : 0) | (this.currentRts ? 0x02 : 0);
    await this.enqueueControl(async () => {
      if (!this.device.opened || !this.desc) throw new Error('USB CDC device is not open');
      await this.device.controlTransferOut({
        requestType: 'class',
        recipient: 'interface',
        request: 0x22,
        value,
        index: this.desc.controlInterfaceNumber,
      });
    });
  }

  async close() {
    this.readLoopRunning = false;
    this.readable = null;
    this.writable = null;
    const desc = this.desc;
    this.desc = null;
    if (this.device.opened) {
      if (desc) {
        try {
          await this.device.controlTransferOut({
            requestType: 'class',
            recipient: 'interface',
            request: 0x22,
            value: 0,
            index: desc.controlInterfaceNumber,
          });
        } catch {}
        try { await this.device.releaseInterface(desc.dataInterfaceNumber); } catch {}
        if (desc.controlInterfaceNumber !== desc.dataInterfaceNumber) {
          try { await this.device.releaseInterface(desc.controlInterfaceNumber); } catch {}
        }
      }
      try { await this.device.close(); } catch {}
    }
  }

  addEventListener() {}
  removeEventListener() {}

  enqueueControl(task) {
    const run = this.controlQueue.then(task);
    this.controlQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  createStreams() {
    const desc = this.desc;
    const readSize = Math.max(64, desc.inPacketSize);
    this.readLoopRunning = true;

    this.readable = new ReadableStream({
      pull: async (controller) => {
        while (this.readLoopRunning && this.device.opened) {
          try {
            const result = await this.device.transferIn(desc.inEndpointNumber, readSize);
            if (!this.readLoopRunning || !this.device.opened) break;
            if (result.status === 'stall') {
              await this.device.clearHalt?.('in', desc.inEndpointNumber);
              continue;
            }
            if (result.status === 'ok' && result.data && result.data.byteLength > 0) {
              controller.enqueue(
                new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength),
              );
              return;
            }
          } catch (err) {
            if (!this.readLoopRunning || !this.device.opened) break;
            throw err;
          }
        }
        try { controller.close(); } catch {}
      },
      cancel: () => { this.readLoopRunning = false; },
    });

    this.writable = new WritableStream({
      write: async (chunk) => {
        if (!this.device.opened) throw new Error('USB CDC device is not open');
        const payload =
          chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
            ? chunk
            : chunk.slice();
        let res = await this.device.transferOut(desc.outEndpointNumber, payload);
        if (res.status === 'stall') {
          await this.device.clearHalt?.('out', desc.outEndpointNumber);
          res = await this.device.transferOut(desc.outEndpointNumber, payload);
        }
        if (res.status !== 'ok') throw new Error(`USB transferOut failed: ${res.status}`);
      },
    });
  }
}

const state = {
  webSerialPort: null,
  webSerialReader: null,
  webSerialWriter: null,
  webUsbDevice: null,
  webUsbDesc: null,
  webUsbReadActive: false,
  wakeLockSentinel: null,
  sessionEpoch: 0,
  autoReconnectPaused: false,
  onState: null,
  onBytes: null,
  status: 'waiting',
  transport: 'none',
};

function notifyState(status, transport, deviceName, vidPid, errorMessage) {
  state.status = status;
  state.transport = transport;
  if (state.onState) {
    state.onState(status, transport, deviceName, vidPid, errorMessage ?? '');
  }
}

async function acquireWakeLock() {
  if (typeof navigator === 'undefined' || !navigator.wakeLock) return;
  if (state.wakeLockSentinel && !state.wakeLockSentinel.released) return;
  try { state.wakeLockSentinel = await navigator.wakeLock.request('screen'); } catch {}
}

async function releaseWakeLock() {
  if (!state.wakeLockSentinel) return;
  try {
    if (!state.wakeLockSentinel.released) await state.wakeLockSentinel.release();
  } catch {}
  state.wakeLockSentinel = null;
}

async function closeAllHandles(preserveSerialPortRef = false) {
  state.webUsbReadActive = false;

  if (state.webSerialReader) {
    try { await state.webSerialReader.cancel(); } catch {}
    try { state.webSerialReader.releaseLock(); } catch {}
    state.webSerialReader = null;
  }

  if (state.webSerialWriter) {
    try { state.webSerialWriter.releaseLock(); } catch {}
    state.webSerialWriter = null;
  }

  if (state.webSerialPort) {
    const port = state.webSerialPort;
    if (!preserveSerialPortRef) state.webSerialPort = null;
    try { await port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch {}
    try { await port.close(); } catch {}
  }

  if (state.webUsbDevice) {
    const dev = state.webUsbDevice;
    const desc = state.webUsbDesc;
    state.webUsbDevice = null;
    state.webUsbDesc = null;
    if (desc) {
      try {
        await dev.controlTransferOut({
          requestType: 'class',
          recipient: 'interface',
          request: 0x22,
          value: 0,
          index: desc.controlInterfaceNumber,
        });
      } catch {}
      try { await dev.releaseInterface(desc.dataInterfaceNumber); } catch {}
      if (desc.controlInterfaceNumber !== desc.dataInterfaceNumber) {
        try { await dev.releaseInterface(desc.controlInterfaceNumber); } catch {}
      }
    }
    try { if (dev.opened) await dev.close(); } catch {}
  }
}

async function handleDisconnect(msg) {
  state.sessionEpoch += 1;
  await closeAllHandles(false);
  await releaseWakeLock();
  notifyState('waiting', 'none', 'Waiting for USB...', '', msg);
}

async function runWebSerialReadLoop(port, epoch) {
  if (!port.readable) return;
  const reader = port.readable.getReader();
  state.webSerialReader = reader;
  try {
    while (epoch === state.sessionEpoch) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0 && state.onBytes) {
        state.onBytes(value);
      }
    }
  } catch (err) {
    if (epoch === state.sessionEpoch) {
      await handleDisconnect(err instanceof Error ? err.message : String(err));
    }
  } finally {
    try { reader.releaseLock(); } catch {}
    if (state.webSerialReader === reader) state.webSerialReader = null;
  }
}

async function openWebSerialPort(port, initCmds) {
  await closeAllHandles(false);
  const epoch = ++state.sessionEpoch;
  const info = port.getInfo ? port.getInfo() : {};
  const vidPid = formatVidPid(info.usbVendorId, info.usbProductId);

  notifyState('connecting', 'webserial', 'Connecting...', vidPid, null);
  try {
    await port.open({
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
      bufferSize: 65536,
    });
    if (epoch !== state.sessionEpoch) {
      try { await port.close(); } catch {}
      return;
    }
    try { await port.setSignals({ dataTerminalReady: true, requestToSend: true }); } catch {}

    state.webSerialPort = port;
    if (port.writable) state.webSerialWriter = port.writable.getWriter();

    notifyState('connected', 'webserial', 'HotWire USB', vidPid, null);
    void acquireWakeLock();
    void runWebSerialReadLoop(port, epoch);

    if (initCmds && initCmds.length > 0) {
      await js_write_bytes(initCmds);
      window.setTimeout(() => {
        if (epoch === state.sessionEpoch && state.status === 'connected') {
          void js_write_bytes(initCmds);
        }
      }, 250);
    }
  } catch (err) {
    await closeAllHandles(false);
    const msg = err instanceof Error ? err.message : String(err);
    notifyState('waiting', 'none', 'Waiting for USB...', '', `Failed to open serial port: ${msg}`);
  }
}

async function runWebUsbReadLoop(device, desc, epoch) {
  const readSize = Math.max(64, desc.inPacketSize);
  while (state.webUsbReadActive && epoch === state.sessionEpoch && device.opened) {
    try {
      const result = await device.transferIn(desc.inEndpointNumber, readSize);
      if (!state.webUsbReadActive || epoch !== state.sessionEpoch) break;
      if (result.status === 'ok' && result.data && result.data.byteLength > 0 && state.onBytes) {
        const chunk = new Uint8Array(
          result.data.buffer,
          result.data.byteOffset,
          result.data.byteLength,
        );
        state.onBytes(chunk);
      }
    } catch (err) {
      if (state.webUsbReadActive && epoch === state.sessionEpoch) {
        await handleDisconnect(err instanceof Error ? err.message : String(err));
      }
      break;
    }
  }
}

async function openWebUsbDevice(device, initCmds) {
  await closeAllHandles(false);
  const epoch = ++state.sessionEpoch;
  const vidPid = formatVidPid(device.vendorId, device.productId);
  notifyState('connecting', 'webusb', device.productName?.trim() || 'Connecting USB...', vidPid, null);

  try {
    if (!device.opened) await device.open();
    if (!device.configuration) await device.selectConfiguration(1);
    if (epoch !== state.sessionEpoch) return;

    const desc = findCdcEndpoints(device);
    if (!desc) {
      await device.close();
      notifyState('waiting', 'none', 'Waiting for USB...', '', 'No USB CDC-ACM bulk endpoints found on selected device.');
      return;
    }

    if (desc.controlInterfaceNumber !== desc.dataInterfaceNumber) {
      try { await device.claimInterface(desc.controlInterfaceNumber); } catch {}
    }
    await device.claimInterface(desc.dataInterfaceNumber);
    if (epoch !== state.sessionEpoch) return;

    try {
      await device.controlTransferOut(
        { requestType: 'class', recipient: 'interface', request: 0x20, value: 0, index: desc.controlInterfaceNumber },
        encodeCdcLineCoding(115200),
      );
    } catch {}

    await device.controlTransferOut({
      requestType: 'class',
      recipient: 'interface',
      request: 0x22,
      value: 0x0003,
      index: desc.controlInterfaceNumber,
    });

    state.webUsbDevice = device;
    state.webUsbDesc = desc;
    notifyState('connected', 'webusb', device.productName?.trim() || 'HotWire USB', vidPid, null);
    void acquireWakeLock();
    state.webUsbReadActive = true;
    void runWebUsbReadLoop(device, desc, epoch);

    if (initCmds && initCmds.length > 0) {
      await js_write_bytes(initCmds);
      window.setTimeout(() => {
        if (epoch === state.sessionEpoch && state.status === 'connected') {
          void js_write_bytes(initCmds);
        }
      }, 250);
    }
  } catch (err) {
    await closeAllHandles(false);
    const msg = err instanceof Error ? err.message : String(err);
    const hint = msg.toLowerCase().includes('claim')
      ? `${msg} (Close Arduino IDE / Serial Monitor or use Web Serial on Desktop.)`
      : msg;
    notifyState('waiting', 'none', 'Waiting for USB...', '', hint);
  }
}

export function js_init_transport(onState, onBytes, initCmds) {
  state.onState = onState;
  state.onBytes = onBytes;

  const onConnect = () => {
    if (state.autoReconnectPaused || state.status !== 'waiting') return;
    void js_probe_authorized(initCmds);
  };
  const onDisconnect = (ev) => {
    if (state.transport === 'webusb') {
      if (!ev.device || ev.device === state.webUsbDevice) {
        void handleDisconnect('USB device unplugged');
      }
    } else if (state.transport === 'webserial') {
      if (!ev.target || ev.target === state.webSerialPort) {
        void handleDisconnect('Serial port disconnected');
      }
    }
  };

  navigator.serial?.addEventListener('connect', onConnect);
  navigator.serial?.addEventListener('disconnect', onDisconnect);
  navigator.usb?.addEventListener('connect', onConnect);
  navigator.usb?.addEventListener('disconnect', onDisconnect);

  void js_probe_authorized(initCmds);
}

export async function js_probe_authorized(initCmds) {
  if (state.autoReconnectPaused || state.status !== 'waiting') return;
  const preferred = detectPreferredBackend();
  try {
    if (preferred === 'webserial' && navigator.serial) {
      const ports = await navigator.serial.getPorts();
      if (ports.length > 0) {
        await openWebSerialPort(ports[0], initCmds);
        return;
      }
    }
    if (navigator.usb) {
      const devices = await navigator.usb.getDevices();
      if (devices.length > 0) {
        await openWebUsbDevice(devices[0], initCmds);
      }
    }
  } catch {}
}

export async function js_connect_usb(initCmds) {
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    notifyState('waiting', 'none', 'Waiting for USB...', '', 'Web Serial and WebUSB require HTTPS or localhost.');
    return;
  }
  const backend = detectPreferredBackend();
  if (backend === 'none') {
    notifyState(
      'waiting',
      'none',
      'Waiting for USB...',
      '',
      'Web Serial / WebUSB is unavailable in this browser. Try Chrome or Edge, or use Demo.',
    );
    return;
  }
  try {
    if (backend === 'webserial' && navigator.serial) {
      const port = await navigator.serial.requestPort();
      await openWebSerialPort(port, initCmds);
    } else if (navigator.usb) {
      const device = await navigator.usb.requestDevice({ filters: WEBUSB_FILTERS });
      await openWebUsbDevice(device, initCmds);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('No port selected') || msg.includes('No device selected') || msg.includes('NotFoundError')) {
      notifyState('waiting', 'none', 'Waiting for USB...', '', null);
    } else {
      notifyState('waiting', 'none', 'Waiting for USB...', '', msg);
    }
  }
}

export async function js_disconnect_usb() {
  state.sessionEpoch += 1;
  await closeAllHandles(false);
  await releaseWakeLock();
  notifyState('waiting', 'none', 'Waiting for USB...', '', null);
}

export async function js_write_bytes(bytes) {
  if (!bytes || bytes.byteLength === 0 || state.status !== 'connected') return;
  if (state.transport === 'webusb' && state.webUsbDevice && state.webUsbDesc) {
    await state.webUsbDevice.transferOut(state.webUsbDesc.outEndpointNumber, bytes);
    return;
  }
  if (state.transport === 'webserial' && state.webSerialWriter) {
    await state.webSerialWriter.write(bytes);
  }
}

// --- Web Flasher (esptool-js loaded on demand via ESM) ---
export async function js_flash_firmware(
  targetBoard,
  forceOtherPort,
  flashOffset,
  customFile,
  initCmds,
  onLog,
  onProgress,
) {
  if (typeof navigator === 'undefined' || (!navigator.serial && !navigator.usb)) {
    throw new Error('Web Serial or WebUSB API is required for esptool-js flashing.');
  }

  const profiles = {
    esp32s3: { label: 'XIAO-ESP32-S3', prefix: 'HotWire_XIAO_ESP32S3.ino', flashSize: '8MB' },
    esp32c6: { label: 'XIAO-ESP32-C6', prefix: 'HotWire_XIAO_ESP32C6.ino', flashSize: '4MB' },
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  state.autoReconnectPaused = true;
  const preferredBackend = detectPreferredBackend();
  const useWebUsb =
    state.transport === 'webusb' ||
    (state.transport !== 'webserial' && preferredBackend === 'webusb');

  let port = null;
  let webUsbDevice = null;
  let espTransport = null;
  let flashedSucceeded = false;

  try {
    onLog('[1/4] Selecting serial port & connecting to ROM bootloader...');
    if (useWebUsb && navigator.usb) {
      const activeUsb = forceOtherPort ? null : state.webUsbDevice;
      if (!forceOtherPort && state.transport === 'webusb' && activeUsb) {
        state.sessionEpoch += 1;
        await closeAllHandles(true);
        await sleep(150);
        webUsbDevice = activeUsb;
      } else {
        webUsbDevice = await navigator.usb.requestDevice({ filters: WEBUSB_FILTERS });
      }
      port = new WebUsbCdcSerialPort(webUsbDevice);
    } else if (navigator.serial) {
      let serialPort = forceOtherPort ? null : state.webSerialPort;
      if (!forceOtherPort && state.transport === 'webserial' && serialPort) {
        state.sessionEpoch += 1;
        await closeAllHandles(true);
        await sleep(150);
      } else {
        onLog('Select the XIAO ESP32-S3 / ESP32-C6 COM port in the browser prompt...');
        serialPort = await navigator.serial.requestPort();
      }
      port = serialPort;
    }

    if (!port) throw new Error('No serial or USB port selected.');

    const { ESPLoader, Transport } = await import('https://esm.sh/esptool-js@0.7.1');
    espTransport = new Transport(port, false);
    const loader = new ESPLoader({
      transport: espTransport,
      baudrate: 115200,
      romBaudrate: 115200,
      terminal: {
        clean: () => {},
        writeLine: (line) => onLog(line),
        write: (text) => {
          const clean = text.replace(/\r/g, '').trim();
          if (clean.length > 0) onLog(clean);
        },
      },
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

    onLog('[2/4] Entering & syncing with ESP32 ROM bootloader...');
    let chipName = '';
    try {
      chipName = await loader.main('default_reset');
    } catch {
      onLog('Reset sync did not answer; retrying direct no_reset sync...');
      try { await espTransport.disconnect(); } catch {}
      await sleep(150);
      chipName = await loader.main('no_reset');
    }

    const detectedUpper = (chipName || loader.chip?.CHIP_NAME || '').toUpperCase();
    let resolvedKey;
    if (targetBoard === 'esp32c6' || targetBoard === 'esp32s3') {
      resolvedKey = targetBoard;
    } else if (detectedUpper.includes('ESP32-C6')) {
      resolvedKey = 'esp32c6';
    } else if (detectedUpper.includes('ESP32-S3')) {
      resolvedKey = 'esp32s3';
    } else {
      throw new Error(`Unsupported chip "${chipName || 'unknown'}". Expected ESP32-S3 or ESP32-C6.`);
    }

    const profile = profiles[resolvedKey];
    onLog(`Target hardware: ${profile.label} (detected: ${chipName || 'unknown'})`);

    const fileArray = [];
    if (customFile) {
      const buf = new Uint8Array(await customFile.arrayBuffer());
      const addr = flashOffset === '0x0' ? 0x0 : 0x10000;
      fileArray.push({ data: buf, address: addr });
      onLog(`Loaded ${customFile.name} (${buf.byteLength} bytes) -> 0x${addr.toString(16)}`);
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
        { data: new Uint8Array(await appRes.arrayBuffer()), address: 0x10000 },
      );
      onLog(`Loaded ${profile.prefix}: Bootloader (0x0), Partitions (0x8000), boot_app0 (0xe000), and App (0x10000).`);
    } else {
      const appRes = await fetch(`./firmware/${profile.prefix}.bin`);
      if (!appRes.ok) throw new Error(`Failed to fetch bundled ${profile.prefix}.bin.`);
      const appBuf = new Uint8Array(await appRes.arrayBuffer());
      fileArray.push({ data: appBuf, address: 0x10000 });
      onLog(`Loaded bundled ${profile.prefix}.bin (${appBuf.byteLength} bytes) -> 0x10000`);
    }

    onLog('[3/4] Writing flash...');
    const totalBytes = fileArray.reduce((acc, f) => acc + f.data.byteLength, 0);
    const isBundledFull = !customFile && flashOffset === 'full';

    await loader.writeFlash({
      fileArray,
      flashSize: isBundledFull ? profile.flashSize : 'keep',
      flashMode: isBundledFull ? 'dio' : 'keep',
      flashFreq: isBundledFull ? '80m' : 'keep',
      eraseAll: false,
      compress: true,
      reportProgress: (fileIndex, written, total) => {
        const prev = fileArray.slice(0, fileIndex).reduce((acc, f) => acc + f.data.byteLength, 0);
        const cur = fileArray[fileIndex]
          ? fileArray[fileIndex].data.byteLength * (written / Math.max(1, total))
          : written;
        const ratio = totalBytes > 0 ? (prev + cur) / totalBytes : written / Math.max(1, total);
        onProgress(Math.min(100, Math.round(ratio * 100)));
      },
    });

    onLog(`[4/4] Hard resetting ${profile.label}...`);
    try { await loader.after('hard_reset'); } catch {}
    try {
      await espTransport.setDTR(false);
      await espTransport.setRTS(true);
      await sleep(100);
      await espTransport.setRTS(false);
      await sleep(80);
    } catch {}
    onProgress(100);
    flashedSucceeded = true;
    onLog('Flash complete! Reconnecting HotWire...');
  } finally {
    if (espTransport) {
      try { await espTransport.disconnect(); } catch {}
    }
    await sleep(600);
    state.autoReconnectPaused = false;
    if (flashedSucceeded) {
      if (webUsbDevice) {
        try { await openWebUsbDevice(webUsbDevice, initCmds); } catch {
          await sleep(900);
          await js_probe_authorized(initCmds);
        }
      } else if (port) {
        try { await openWebSerialPort(port, initCmds); } catch {
          await sleep(900);
          await js_probe_authorized(initCmds);
        }
      }
    }
  }
}
