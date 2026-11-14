import {
  buildGetCapsCmd,
  buildPingStatusCmd,
  encodeResponseFrame,
} from '../protocol/codec';
import {
  CHANNELS,
  CMD_BATCH_FORCE,
  CMD_BOOTLOADER,
  CMD_GET_CAPS,
  CMD_LA_ABORT,
  CMD_LA_CAPTURE,
  CMD_PING_STATUS,
  CMD_PIN_FORCE,
  LA_FLAG_ABORTED_EARLY,
  LA_FLAG_TRIGGERED,
  PROTOCOL_SYNC_0,
  PROTOCOL_SYNC_1,
  RATE_PRESETS,
  TYPE_BOARD_CAPABILITIES,
  TYPE_LA_CAPTURE_DATA,
  TYPE_STATUS_TELEMETRY,
} from '../protocol/types';
import {
  ScreenWakeLockSentinel,
  WebSerialPort,
  WebUSBDevice,
  WebUSBDeviceFilter,
} from './web-apis';

export type TransportKind = 'none' | 'webserial' | 'webusb' | 'demo';
export type ConnectionStatus = 'waiting' | 'connecting' | 'connected';

export interface TransportSnapshot {
  status: ConnectionStatus;
  transport: TransportKind;
  deviceName: string;
  vidPid: string;
  errorMessage: string | null;
}

export type TransportStateListener = (snapshot: TransportSnapshot) => void;
export type TransportBytesListener = (bytes: Uint8Array) => void;

const WEBUSB_FILTERS: WebUSBDeviceFilter[] = [
  { vendorId: 0x303a }, // Espressif native USB CDC / JTAG
  { vendorId: 0x2886 }, // Seeed Studio
  { classCode: 2, subclassCode: 2 }, // USB CDC-ACM
  { classCode: 239, subclassCode: 2, protocolCode: 1 }, // Composite IAD CDC
];

interface CdcEndpointDescriptor {
  controlInterfaceNumber: number;
  dataInterfaceNumber: number;
  inEndpointNumber: number;
  outEndpointNumber: number;
  inPacketSize: number;
}

function formatVidPid(vid?: number, pid?: number): string {
  if (!vid && !pid) return '';
  const v = (vid ?? 0).toString(16).toUpperCase().padStart(4, '0');
  const p = (pid ?? 0).toString(16).toUpperCase().padStart(4, '0');
  return `${v}:${p}`;
}

function encodeCdcLineCoding(baudRate = 115200): Uint8Array {
  const buf = new ArrayBuffer(7);
  const view = new DataView(buf);
  view.setUint32(0, baudRate, true);
  view.setUint8(4, 0); // 1 stop bit
  view.setUint8(5, 0); // No parity
  view.setUint8(6, 8); // 8 data bits
  return new Uint8Array(buf);
}

function findCdcEndpoints(device: WebUSBDevice): CdcEndpointDescriptor | null {
  const config = device.configuration ?? device.configurations[0];
  if (!config) return null;

  const interfaces = config.interfaces;
  for (let i = 0; i < interfaces.length; i++) {
    const iface = interfaces[i];
    const alt = iface.alternate;

    // Skip non-CDC vendor JTAG debug interface (class 0xFF) if a CDC Data interface exists
    if (alt.interfaceClass === 0xff) {
      continue;
    }

    let inEp: number | null = null;
    let outEp: number | null = null;
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

export function detectPreferredBackend(): 'webserial' | 'webusb' | 'none' {
  if (typeof navigator === 'undefined') return 'none';
  const ua = navigator.userAgent ?? '';
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  const hasWebSerial = 'serial' in navigator && Boolean(navigator.serial);
  const hasWebUSB = 'usb' in navigator && Boolean(navigator.usb);

  // Android Chrome uses WebUSB; Desktop Chrome/Edge defaults to Web Serial with WebUSB fallback
  if (isMobile && hasWebUSB) return 'webusb';
  if (hasWebSerial) return 'webserial';
  if (hasWebUSB) return 'webusb';
  return 'none';
}

export class SerialTransport {
  private snapshot: TransportSnapshot = {
    status: 'waiting',
    transport: 'none',
    deviceName: 'Waiting for USB...',
    vidPid: '',
    errorMessage: null,
  };

  private stateListeners = new Set<TransportStateListener>();
  private bytesListeners = new Set<TransportBytesListener>();

  // Web Serial state
  private webSerialPort: WebSerialPort | null = null;
  private webSerialReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private webSerialWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;

  // WebUSB state
  private webUsbDevice: WebUSBDevice | null = null;
  private webUsbDesc: CdcEndpointDescriptor | null = null;
  private webUsbReadActive = false;

  // Demo hardware simulator state
  private demoTimer: number | null = null;
  private demoCaptureTimer: number | null = null;
  private demoForceEnable = 0x00;
  private demoForcedLevel = 0x00;
  private demoPullUpMask = 0x00;
  private demoPullDownMask = 0x00;
  private demoContentionMask = 0x00;
  private demoShortSimPin: number | null = null;
  private demoTick = 0;
  private demoAsciiLine = '';
  private demoCaptureState: {
    rateId: number;
    trigCh: number;
    edge: number;
    preTrigRatio: number;
    totalSamples: number;
    startMs: number;
  } | null = null;

  private wakeLockSentinel: ScreenWakeLockSentinel | null = null;
  private sessionEpoch = 0;
  private listenersAttached = false;
  private autoReconnectPaused = false;

  private readonly onHardwareConnect = () => {
    if (this.autoReconnectPaused) return;
    if (this.snapshot.status === 'waiting') {
      void this.probeAuthorizedDevices();
    }
  };

  private readonly onHardwareDisconnect = (ev: Event) => {
    if (this.snapshot.transport === 'webusb') {
      const usbEv = ev as Event & { device?: WebUSBDevice };
      if (!usbEv.device || usbEv.device === this.webUsbDevice) {
        void this.handleDisconnect('USB device unplugged');
      }
    } else if (this.snapshot.transport === 'webserial') {
      const serEv = ev as Event & { target?: WebSerialPort };
      if (!serEv.target || serEv.target === this.webSerialPort) {
        void this.handleDisconnect('Serial port disconnected');
      }
    }
  };

  init(): void {
    if (this.listenersAttached || typeof navigator === 'undefined') return;
    this.listenersAttached = true;

    navigator.serial?.addEventListener('connect', this.onHardwareConnect);
    navigator.serial?.addEventListener('disconnect', this.onHardwareDisconnect);
    navigator.usb?.addEventListener('connect', this.onHardwareConnect);
    navigator.usb?.addEventListener('disconnect', this.onHardwareDisconnect);

    void this.probeAuthorizedDevices();
  }

  destroy(): void {
    if (this.listenersAttached && typeof navigator !== 'undefined') {
      navigator.serial?.removeEventListener('connect', this.onHardwareConnect);
      navigator.serial?.removeEventListener('disconnect', this.onHardwareDisconnect);
      navigator.usb?.removeEventListener('connect', this.onHardwareConnect);
      navigator.usb?.removeEventListener('disconnect', this.onHardwareDisconnect);
      this.listenersAttached = false;
    }
    void this.disconnect();
  }

  onStateChange(listener: TransportStateListener): () => void {
    this.stateListeners.add(listener);
    listener({ ...this.snapshot });
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  onBytes(listener: TransportBytesListener): () => void {
    this.bytesListeners.add(listener);
    return () => {
      this.bytesListeners.delete(listener);
    };
  }

  getSnapshot(): TransportSnapshot {
    return { ...this.snapshot };
  }

  getActiveWebSerialPort(): WebSerialPort | null {
    return this.webSerialPort;
  }

  setAutoReconnectPaused(paused: boolean): void {
    this.autoReconnectPaused = paused;
  }

  async connectWebSerialPort(port: WebSerialPort): Promise<void> {
    await this.openWebSerialPort(port);
  }

  async probeAuthorizedDevices(): Promise<void> {
    if (
      this.autoReconnectPaused ||
      this.snapshot.status === 'connected' ||
      this.snapshot.status === 'connecting'
    ) {
      return;
    }
    const preferred = detectPreferredBackend();

    try {
      if (preferred === 'webserial' && navigator.serial) {
        const ports = await navigator.serial.getPorts();
        if (ports.length > 0) {
          await this.openWebSerialPort(ports[0]);
          return;
        }
      }
      if (navigator.usb) {
        const devices = await navigator.usb.getDevices();
        if (devices.length > 0) {
          await this.openWebUsbDevice(devices[0]);
        }
      }
    } catch {
      // Silent zero-touch probe failure if busy elsewhere
    }
  }

  async connect(overrideBackend?: 'webserial' | 'webusb'): Promise<void> {
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      this.updateSnapshot({
        status: 'waiting',
        transport: 'none',
        deviceName: 'Waiting for USB...',
        vidPid: '',
        errorMessage: 'Web Serial and WebUSB require HTTPS or localhost.',
      });
      return;
    }

    const backend = overrideBackend ?? detectPreferredBackend();
    if (backend === 'none') {
      this.updateSnapshot({
        status: 'waiting',
        transport: 'none',
        deviceName: 'Waiting for USB...',
        vidPid: '',
        errorMessage: 'Web Serial / WebUSB is unavailable in this browser. Try Chrome or Edge, or use Demo.',
      });
      return;
    }

    try {
      if (backend === 'webserial' && navigator.serial) {
        const port = await navigator.serial.requestPort();
        await this.openWebSerialPort(port);
      } else if (navigator.usb) {
        const device = await navigator.usb.requestDevice({ filters: WEBUSB_FILTERS });
        await this.openWebUsbDevice(device);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('No port selected') ||
        msg.includes('No device selected') ||
        msg.includes('NotFoundError')
      ) {
        this.updateSnapshot({ errorMessage: null });
      } else {
        this.updateSnapshot({
          status: 'waiting',
          transport: 'none',
          deviceName: 'Waiting for USB...',
          vidPid: '',
          errorMessage: msg,
        });
      }
    }
  }

  async disconnect(preservePortReference = false): Promise<WebSerialPort | null> {
    this.sessionEpoch += 1;
    const prevPort = this.webSerialPort;
    await this.closeAllHandles(preservePortReference);
    await this.releaseWakeLock();

    this.updateSnapshot({
      status: 'waiting',
      transport: 'none',
      deviceName: 'Waiting for USB...',
      vidPid: '',
      errorMessage: null,
    });
    return prevPort;
  }

  async writeBytes(bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength === 0 || this.snapshot.status !== 'connected') return;

    if (this.snapshot.transport === 'demo') {
      this.handleDemoTx(bytes);
      return;
    }

    if (this.snapshot.transport === 'webusb' && this.webUsbDevice && this.webUsbDesc) {
      await this.webUsbDevice.transferOut(
        this.webUsbDesc.outEndpointNumber,
        bytes as unknown as BufferSource
      );
      return;
    }

    if (this.snapshot.transport === 'webserial' && this.webSerialWriter) {
      await this.webSerialWriter.write(bytes);
    }
  }

  async startDemo(): Promise<void> {
    await this.closeAllHandles(false);
    const epoch = ++this.sessionEpoch;
    this.demoForceEnable = 0x00;
    this.demoForcedLevel = 0x00;
    this.demoPullUpMask = 0x00;
    this.demoPullDownMask = 0x00;
    this.demoContentionMask = 0x00;
    this.demoShortSimPin = null;
    this.demoTick = 0;
    this.demoAsciiLine = '';
    this.demoCaptureState = null;

    this.updateSnapshot({
      status: 'connected',
      transport: 'demo',
      deviceName: 'XIAO-ESP32-S3 (Demo)',
      vidPid: '303A:1001',
      errorMessage: null,
    });

    this.emitDemoCaps();
    this.emitDemoTelemetry();
    this.emitBytes(
      new TextEncoder().encode(
        '\r\n\x1b[32m[Demo] Simulated XIAO-ESP32-S3 Pocket Lab connected.\x1b[0m\r\n' +
          'Type \x1b[33mhelp\x1b[0m or \x1b[33mshort 7\x1b[0m to test terminal & bus contention.\r\n'
      )
    );

    this.demoTimer = window.setInterval(() => {
      if (epoch !== this.sessionEpoch) return;
      this.demoTick += 1;
      this.emitDemoTelemetry();
    }, 40);
  }

  private async openWebSerialPort(port: WebSerialPort): Promise<void> {
    await this.closeAllHandles(false);
    const epoch = ++this.sessionEpoch;

    const info = port.getInfo();
    const vidPid = formatVidPid(info.usbVendorId, info.usbProductId);

    this.updateSnapshot({
      status: 'connecting',
      transport: 'webserial',
      deviceName: 'Connecting...',
      vidPid,
      errorMessage: null,
    });

    try {
      await port.open({
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
        bufferSize: 65536,
      });

      if (epoch !== this.sessionEpoch) {
        try {
          await port.close();
        } catch {
          // Ignore close error on superseded session
        }
        return;
      }

      // Assert DTR & RTS so native ESP32-S3 USB CDC transmits reliably
      try {
        await port.setSignals({ dataTerminalReady: true, requestToSend: true });
      } catch {
        // Ignore on virtual ports without control signals
      }

      this.webSerialPort = port;
      if (port.writable) {
        this.webSerialWriter = port.writable.getWriter();
      }

      this.updateSnapshot({
        status: 'connected',
        transport: 'webserial',
        deviceName: 'XIAO-ESP32-S3',
        vidPid,
        errorMessage: null,
      });

      void this.acquireWakeLock();
      void this.runWebSerialReadLoop(port, epoch);

      // Query capabilities and immediate pin telemetry
      await this.writeBytes(buildGetCapsCmd());
      await this.writeBytes(buildPingStatusCmd());
    } catch (err) {
      await this.closeAllHandles(false);
      const msg = err instanceof Error ? err.message : String(err);
      this.updateSnapshot({
        status: 'waiting',
        transport: 'none',
        deviceName: 'Waiting for USB...',
        vidPid: '',
        errorMessage: `Failed to open serial port: ${msg}`,
      });
    }
  }

  private async runWebSerialReadLoop(port: WebSerialPort, epoch: number): Promise<void> {
    if (!port.readable) return;
    const reader = port.readable.getReader();
    this.webSerialReader = reader;

    try {
      while (epoch === this.sessionEpoch) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          this.emitBytes(value);
        }
      }
    } catch (err) {
      if (epoch === this.sessionEpoch) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.handleDisconnect(msg);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Ignore already released lock
      }
      if (this.webSerialReader === reader) {
        this.webSerialReader = null;
      }
    }
  }

  private async openWebUsbDevice(device: WebUSBDevice): Promise<void> {
    await this.closeAllHandles(false);
    const epoch = ++this.sessionEpoch;
    const vidPid = formatVidPid(device.vendorId, device.productId);

    this.updateSnapshot({
      status: 'connecting',
      transport: 'webusb',
      deviceName: device.productName?.trim() || 'Connecting USB...',
      vidPid,
      errorMessage: null,
    });

    try {
      if (!device.opened) {
        await device.open();
      }
      if (!device.configuration) {
        await device.selectConfiguration(1);
      }
      if (epoch !== this.sessionEpoch) return;

      const desc = findCdcEndpoints(device);
      if (!desc) {
        await device.close();
        this.updateSnapshot({
          status: 'waiting',
          transport: 'none',
          deviceName: 'Waiting for USB...',
          vidPid: '',
          errorMessage: 'No USB CDC-ACM bulk endpoints found on selected device.',
        });
        return;
      }

      if (desc.controlInterfaceNumber !== desc.dataInterfaceNumber) {
        try {
          await device.claimInterface(desc.controlInterfaceNumber);
        } catch {
          // Control interface optional on some composite devices
        }
      }
      await device.claimInterface(desc.dataInterfaceNumber);

      if (epoch !== this.sessionEpoch) return;

      // Set CDC Line Coding (115200 8N1)
      try {
        await device.controlTransferOut(
          {
            requestType: 'class',
            recipient: 'interface',
            request: 0x20,
            value: 0,
            index: desc.controlInterfaceNumber,
          },
          encodeCdcLineCoding(115200) as unknown as BufferSource
        );
      } catch {
        // Ignore if device omits SET_LINE_CODING
      }

      // Mandatory USB Control Transfer: SET_CONTROL_LINE_STATE (0x22, value 0x0003 = DTR + RTS)
      await device.controlTransferOut({
        requestType: 'class',
        recipient: 'interface',
        request: 0x22,
        value: 0x0003,
        index: desc.controlInterfaceNumber,
      });

      this.webUsbDevice = device;
      this.webUsbDesc = desc;

      this.updateSnapshot({
        status: 'connected',
        transport: 'webusb',
        deviceName: device.productName?.trim() || 'XIAO-ESP32-S3',
        vidPid,
        errorMessage: null,
      });

      void this.acquireWakeLock();
      this.webUsbReadActive = true;
      void this.runWebUsbReadLoop(device, desc, epoch);

      await this.writeBytes(buildGetCapsCmd());
      await this.writeBytes(buildPingStatusCmd());
    } catch (err) {
      await this.closeAllHandles(false);
      const msg = err instanceof Error ? err.message : String(err);
      const hint = msg.toLowerCase().includes('claim')
        ? `${msg} (Close Arduino IDE / Serial Monitor or use Web Serial on Desktop.)`
        : msg;
      this.updateSnapshot({
        status: 'waiting',
        transport: 'none',
        deviceName: 'Waiting for USB...',
        vidPid: '',
        errorMessage: hint,
      });
    }
  }

  private async runWebUsbReadLoop(
    device: WebUSBDevice,
    desc: CdcEndpointDescriptor,
    epoch: number
  ): Promise<void> {
    const readSize = Math.max(64, desc.inPacketSize);
    while (this.webUsbReadActive && epoch === this.sessionEpoch && device.opened) {
      try {
        const result = await device.transferIn(desc.inEndpointNumber, readSize);
        if (!this.webUsbReadActive || epoch !== this.sessionEpoch) break;
        if (result.status === 'ok' && result.data && result.data.byteLength > 0) {
          const chunk = new Uint8Array(
            result.data.buffer,
            result.data.byteOffset,
            result.data.byteLength
          );
          this.emitBytes(chunk);
        }
      } catch (err) {
        if (this.webUsbReadActive && epoch === this.sessionEpoch) {
          const msg = err instanceof Error ? err.message : String(err);
          await this.handleDisconnect(msg);
        }
        break;
      }
    }
  }

  private async handleDisconnect(errorMessage: string): Promise<void> {
    this.sessionEpoch += 1;
    await this.closeAllHandles(false);
    await this.releaseWakeLock();

    this.updateSnapshot({
      status: 'waiting',
      transport: 'none',
      deviceName: 'Waiting for USB...',
      vidPid: '',
      errorMessage,
    });
  }

  private async closeAllHandles(preserveSerialPortRef: boolean): Promise<void> {
    if (this.demoTimer !== null) {
      window.clearInterval(this.demoTimer);
      this.demoTimer = null;
    }
    if (this.demoCaptureTimer !== null) {
      window.clearTimeout(this.demoCaptureTimer);
      this.demoCaptureTimer = null;
    }
    this.webUsbReadActive = false;

    if (this.webSerialReader) {
      try {
        await this.webSerialReader.cancel();
      } catch {
        // Ignore cancel failure
      }
      try {
        this.webSerialReader.releaseLock();
      } catch {
        // Ignore lock release failure
      }
      this.webSerialReader = null;
    }

    if (this.webSerialWriter) {
      try {
        this.webSerialWriter.releaseLock();
      } catch {
        // Ignore lock release failure
      }
      this.webSerialWriter = null;
    }

    if (this.webSerialPort) {
      const port = this.webSerialPort;
      if (!preserveSerialPortRef) {
        this.webSerialPort = null;
      }
      try {
        // Clear both RTS and DTR atomically to avoid tripping ESP32-S3 USB-JTAG reset-to-bootloader
        await port.setSignals({ dataTerminalReady: false, requestToSend: false });
      } catch {
        // Ignore
      }
      try {
        await port.close();
      } catch {
        // Ignore close failure
      }
    }

    if (this.webUsbDevice) {
      const dev = this.webUsbDevice;
      const desc = this.webUsbDesc;
      this.webUsbDevice = null;
      this.webUsbDesc = null;

      if (desc) {
        try {
          await dev.controlTransferOut({
            requestType: 'class',
            recipient: 'interface',
            request: 0x22,
            value: 0x0000,
            index: desc.controlInterfaceNumber,
          });
        } catch {
          // Ignore
        }
        try {
          await dev.releaseInterface(desc.dataInterfaceNumber);
        } catch {
          // Ignore
        }
        if (desc.controlInterfaceNumber !== desc.dataInterfaceNumber) {
          try {
            await dev.releaseInterface(desc.controlInterfaceNumber);
          } catch {
            // Ignore
          }
        }
      }
      try {
        if (dev.opened) {
          await dev.close();
        }
      } catch {
        // Ignore
      }
    }
  }

  private handleDemoTx(bytes: Uint8Array): void {
    // Parse 8-byte binary command frames if prefixed by 0xAA 0x55
    if (bytes.byteLength >= 8 && bytes[0] === PROTOCOL_SYNC_0 && bytes[1] === PROTOCOL_SYNC_1) {
      const cmdId = bytes[2];
      const p1 = bytes[3];
      const p2 = bytes[4];
      const p3 = bytes[5];
      const p4 = bytes[6];

      switch (cmdId) {
        case CMD_PING_STATUS:
          this.emitDemoTelemetry();
          return;

        case CMD_GET_CAPS:
          this.emitDemoCaps();
          return;

        case CMD_PIN_FORCE:
          if (p1 === 0xff) {
            this.demoForceEnable = 0;
            this.demoForcedLevel = 0;
            this.demoPullUpMask = 0;
            this.demoPullDownMask = 0;
            this.demoContentionMask = 0;
          } else if (p1 < 8) {
            const bit = 1 << p1;
            this.demoContentionMask &= ~bit;
            if (p2 === 1 || p2 === 2) {
              this.demoForceEnable |= bit;
              if (p2 === 2) this.demoForcedLevel |= bit;
              else this.demoForcedLevel &= ~bit;
              this.demoPullUpMask &= ~bit;
              this.demoPullDownMask &= ~bit;

              // Simulated bus conflict test when short simulation is active on this pin
              if (p4 !== 0 && this.demoShortSimPin === p1) {
                window.setTimeout(() => {
                  if (this.snapshot.transport !== 'demo') return;
                  this.demoForceEnable &= ~bit;
                  this.demoForcedLevel &= ~bit;
                  this.demoContentionMask |= bit;
                  this.emitDemoTelemetry();
                  this.emitBytes(
                    new TextEncoder().encode(
                      `\r\n\x1b[31m[SHORT!] Contention >20ms on D${p1}: reverted to Z\x1b[0m\r\n`
                    )
                  );
                }, 25);
              }
            } else {
              this.demoForceEnable &= ~bit;
              this.demoForcedLevel &= ~bit;
              if (p3 === 1) {
                this.demoPullUpMask |= bit;
                this.demoPullDownMask &= ~bit;
              } else if (p3 === 2) {
                this.demoPullDownMask |= bit;
                this.demoPullUpMask &= ~bit;
              } else {
                this.demoPullUpMask &= ~bit;
                this.demoPullDownMask &= ~bit;
              }
            }
          }
          this.emitDemoTelemetry();
          return;

        case CMD_BATCH_FORCE:
          this.demoForceEnable = p1;
          this.demoForcedLevel = p2 & p1;
          this.demoPullUpMask = p3 & ~p1;
          this.demoPullDownMask &= ~p1;
          this.demoContentionMask = 0;
          this.emitDemoTelemetry();
          return;

        case CMD_LA_CAPTURE: {
          if (this.demoCaptureTimer !== null) {
            window.clearTimeout(this.demoCaptureTimer);
          }
          const rateId = Math.min(RATE_PRESETS.length - 1, Math.max(0, p1));
          const trigCh = p2;
          const edge = p3 & 0x03;
          const preRatio = (p3 >> 4) & 0x03;
          const blocksKb = Math.min(32, Math.max(1, p4));
          const totalSamples = blocksKb * 1024;
          const rateHz = RATE_PRESETS[rateId].hz;
          const durationMs = Math.min(1800, Math.max(40, Math.round((totalSamples / rateHz) * 1000)));

          this.demoCaptureState = {
            rateId,
            trigCh,
            edge,
            preTrigRatio: preRatio,
            totalSamples,
            startMs: performance.now(),
          };
          this.demoCaptureTimer = window.setTimeout(() => {
            this.finishDemoCapture(false);
          }, durationMs);
          return;
        }

        case CMD_LA_ABORT:
          if (this.demoCaptureState) {
            if (this.demoCaptureTimer !== null) {
              window.clearTimeout(this.demoCaptureTimer);
              this.demoCaptureTimer = null;
            }
            this.finishDemoCapture(true);
          }
          return;

        case CMD_BOOTLOADER:
          this.demoForceEnable = 0;
          this.demoForcedLevel = 0;
          this.emitDemoTelemetry();
          this.emitBytes(
            new TextEncoder().encode(
              '\r\n\x1b[33m[Demo] Simulated 0xF0 CMD_BOOTLOADER received (all pins released to Z).\x1b[0m\r\n'
            )
          );
          return;
      }
    }

    // Plain UTF-8 terminal input
    const text = new TextDecoder().decode(bytes);
    for (const ch of text) {
      if (ch === '\r' || ch === '\n') {
        const cmd = this.demoAsciiLine.trim();
        this.demoAsciiLine = '';
        if (cmd === 'help') {
          this.emitBytes(
            new TextEncoder().encode(
              '\r\nDemo Commands: help, status, pins, release, short <0..7|off>, version\r\n'
            )
          );
        } else if (cmd === 'pins') {
          this.emitBytes(
            new TextEncoder().encode(
              '\r\nCH0=D0(GPIO1) CH1=D1(GPIO2) CH2=D2(GPIO3) CH3=D3(GPIO4)\r\n' +
                'CH4=D4(GPIO5) CH5=D5(GPIO6) CH6=D6(GPIO43) CH7=D7(GPIO44)\r\n'
            )
          );
        } else if (cmd === 'release') {
          this.demoForceEnable = 0;
          this.demoForcedLevel = 0;
          this.demoContentionMask = 0;
          this.emitDemoTelemetry();
          this.emitBytes(new TextEncoder().encode('\r\nAll channels released to Z.\r\n'));
        } else if (cmd === 'status') {
          this.emitBytes(
            new TextEncoder().encode(
              `\r\n[STATUS] forceEn=0x${this.demoForceEnable.toString(16)} forced=0x${this.demoForcedLevel.toString(16)} contention=0x${this.demoContentionMask.toString(16)}\r\n`
            )
          );
        } else if (cmd.startsWith('short')) {
          const arg = cmd.split(/\s+/)[1];
          if (arg === 'off') {
            this.demoShortSimPin = null;
            this.emitBytes(new TextEncoder().encode('\r\nShort-circuit simulation disabled.\r\n'));
          } else {
            const p = Number(arg ?? '7');
            if (Number.isInteger(p) && p >= 0 && p <= 7) {
              this.demoShortSimPin = p;
              this.emitBytes(
                new TextEncoder().encode(
                  `\r\nSimulated short circuit armed on D${p}. Force D${p} to 0 or 1 to test 20ms cutoff!\r\n`
                )
              );
            }
          }
        } else if (cmd === 'version') {
          this.emitBytes(
            new TextEncoder().encode('\r\nHotWire-XIAO-ESP32S3 Demo v1.0.0\r\n')
          );
        } else if (cmd.length > 0) {
          this.emitBytes(new TextEncoder().encode(`\r\nUnknown demo command: ${cmd}\r\n`));
        }
      } else {
        this.demoAsciiLine += ch;
      }
    }
  }

  private computeDemoPhysicalLevels(): number {
    // Unforced floating channels show gentle demo activity (SPI-like clock on D0, UART/PWM on D1..D3)
    const phase = this.demoTick;
    let ambient =
      ((phase & 1) << 0) |
      (((phase >> 1) & 1) << 1) |
      (((phase >> 2) & 1) << 2) |
      ((phase % 5 === 0 ? 1 : 0) << 3);

    // Apply pull-up / pull-down defaults on floating bits 4..7
    ambient = (ambient & ~this.demoPullDownMask) | this.demoPullUpMask;
    // Override with forced outputs
    return (ambient & ~this.demoForceEnable) | (this.demoForcedLevel & this.demoForceEnable);
  }

  private emitDemoTelemetry(): void {
    const payload = new Uint8Array([
      this.computeDemoPhysicalLevels(),
      this.demoForceEnable,
      this.demoForcedLevel,
      this.demoContentionMask,
    ]);
    this.emitBytes(encodeResponseFrame(TYPE_STATUS_TELEMETRY, payload));
  }

  private emitDemoCaps(): void {
    const json = JSON.stringify({
      board: 'XIAO-ESP32-S3',
      firmware: '1.0.0-demo',
      channels: 8,
      maxRateHz: 20_000_000,
      maxDepth: 32768,
      pins: CHANNELS.map((c) => ({ ch: c.ch, label: c.label, gpio: c.gpio })),
    });
    this.emitBytes(encodeResponseFrame(TYPE_BOARD_CAPABILITIES, new TextEncoder().encode(json)));
  }

  private finishDemoCapture(aborted: boolean): void {
    const st = this.demoCaptureState;
    if (!st) return;
    this.demoCaptureState = null;

    const rateHz = RATE_PRESETS[st.rateId].hz;
    const sampleCount = aborted
      ? Math.max(64, Math.min(st.totalSamples, Math.round(st.totalSamples * 0.25)))
      : st.totalSamples;

    let trigIndex = 0;
    if (st.trigCh < 8) {
      if (st.preTrigRatio === 1) trigIndex = Math.floor(sampleCount / 4);
      else if (st.preTrigRatio === 2) trigIndex = Math.floor(sampleCount / 2);
    }

    const flags = (aborted ? LA_FLAG_ABORTED_EARLY : 0) | (st.trigCh < 8 ? LA_FLAG_TRIGGERED : 0);
    const payload = new Uint8Array(8 + sampleCount);
    const view = new DataView(payload.buffer);
    view.setUint32(0, rateHz, true);
    view.setUint16(4, trigIndex, true);
    view.setUint16(6, flags, true);

    // Synthesize realistic 8-channel digital waveforms aligned with trigIndex
    const period = 32;
    const shift = st.trigCh < 8 ? (st.edge === 0 ? 16 : 0) - (trigIndex % period) : 0;

    for (let i = 0; i < sampleCount; i++) {
      const t = i + shift + 1024;
      const d0 = (Math.floor(t / 4) & 1) ? 1 : 0; // Fast clock
      const d1 = (Math.floor(t / 16) & 1) ? 1 : 0; // Half-rate MOSI-like burst
      const d2 = ((Math.floor(t / 8) ^ Math.floor(t / 24)) & 1) ? 1 : 0; // Data
      const d3 = ((t % 64) < 40) ? 0 : 1; // Chip select active low
      const d4 = ((t % 48) < 12) ? 1 : 0; // PWM 25%
      const d5 = ((t % 48) < 36) ? 1 : 0; // PWM 75%
      const d6 = (Math.floor(t / 32) & 1) ? 1 : 0; // UART-ish bit clock
      const d7 = (((t >> 4) * 5) & 1) ? 1 : 0;

      let sample =
        (d0 << 0) |
        (d1 << 1) |
        (d2 << 2) |
        (d3 << 3) |
        (d4 << 4) |
        (d5 << 5) |
        (d6 << 6) |
        (d7 << 7);

      // Keep forced pins steady at their forced level
      sample = (sample & ~this.demoForceEnable) | (this.demoForcedLevel & this.demoForceEnable);
      payload[8 + i] = sample;
    }

    this.emitBytes(encodeResponseFrame(TYPE_LA_CAPTURE_DATA, payload));
  }

  private emitBytes(bytes: Uint8Array): void {
    for (const listener of this.bytesListeners) {
      listener(bytes);
    }
  }

  private updateSnapshot(partial: Partial<TransportSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    const copy = { ...this.snapshot };
    for (const listener of this.stateListeners) {
      listener(copy);
    }
  }

  private async acquireWakeLock(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.wakeLock) return;
    if (this.wakeLockSentinel && !this.wakeLockSentinel.released) return;
    try {
      this.wakeLockSentinel = await navigator.wakeLock.request('screen');
    } catch {
      // Ignore wake lock errors when unsupported or battery saver active
    }
  }

  private async releaseWakeLock(): Promise<void> {
    if (!this.wakeLockSentinel) return;
    try {
      if (!this.wakeLockSentinel.released) {
        await this.wakeLockSentinel.release();
      }
    } catch {
      // Ignore
    }
    this.wakeLockSentinel = null;
  }
}
