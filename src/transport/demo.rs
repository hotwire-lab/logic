use crate::protocol::codec::encode_response_frame;
use crate::protocol::types::*;

#[derive(Debug, Clone, Copy)]
pub struct DemoCaptureState {
    pub rate_id: usize,
    pub trig_ch: u8,
    pub edge: u8,
    pub pre_trig_ratio: u8,
    pub total_samples: usize,
}

#[derive(Debug, Clone)]
pub enum DemoAction {
    ScheduleCapture { duration_ms: u32 },
    AbortCapture,
    ScheduleShortSim { pin: u8 },
}

#[derive(Debug, Clone)]
pub struct DemoSimulator {
    pub tick: u32,
    pub force_enable: u8,
    pub forced_level: u8,
    pub pull_up_mask: u8,
    pub pull_down_mask: u8,
    pub contention_mask: u8,
    pub short_sim_pin: Option<u8>,
    pub capture_state: Option<DemoCaptureState>,
    ascii_line: String,
}

impl Default for DemoSimulator {
    fn default() -> Self {
        Self::new()
    }
}

impl DemoSimulator {
    pub fn new() -> Self {
        Self {
            tick: 0,
            force_enable: 0,
            forced_level: 0,
            pull_up_mask: 0,
            pull_down_mask: 0,
            contention_mask: 0,
            short_sim_pin: None,
            capture_state: None,
            ascii_line: String::new(),
        }
    }

    pub fn reset(&mut self) {
        *self = Self::new();
    }

    pub fn compute_physical_levels(&self) -> u8 {
        let phase = self.tick;
        let mut ambient = ((phase & 1) as u8)
            | ((((phase >> 1) & 1) as u8) << 1)
            | ((((phase >> 2) & 1) as u8) << 2)
            | ((u8::from(phase.is_multiple_of(5))) << 3);

        ambient = (ambient & !self.pull_down_mask) | self.pull_up_mask;
        (ambient & !self.force_enable) | (self.forced_level & self.force_enable)
    }

    pub fn build_telemetry_frame(&self) -> Vec<u8> {
        let payload = [
            self.compute_physical_levels(),
            self.force_enable,
            self.forced_level,
            self.contention_mask,
        ];
        encode_response_frame(TYPE_STATUS_TELEMETRY, &payload)
    }

    pub fn build_caps_frame(&self) -> Vec<u8> {
        let pins: Vec<String> = CHANNELS
            .iter()
            .map(|c| format!(r#"{{"ch":{},"label":"{}","gpio":{}}}"#, c.ch, c.label, c.gpio))
            .collect();
        let json = format!(
            r#"{{"board":"XIAO-ESP32-S3","firmware":"1.0.0-demo","channels":8,"maxRateHz":20000000,"maxDepth":32768,"pins":[{}]}}"#,
            pins.join(",")
        );
        encode_response_frame(TYPE_BOARD_CAPABILITIES, json.as_bytes())
    }

    pub fn tick_telemetry(&mut self) -> Vec<u8> {
        self.tick = self.tick.wrapping_add(1);
        self.build_telemetry_frame()
    }

    pub fn trigger_short_sim(&mut self, pin: u8) -> Vec<Vec<u8>> {
        if pin >= 8 {
            return Vec::new();
        }
        let bit = 1u8 << pin;
        self.force_enable &= !bit;
        self.forced_level &= !bit;
        self.contention_mask |= bit;
        vec![
            self.build_telemetry_frame(),
            format!("\r\n[SHORT!] Contention >20ms on D{pin}: reverted to Z\r\n").into_bytes(),
        ]
    }

    pub fn handle_tx(&mut self, bytes: &[u8]) -> (Vec<Vec<u8>>, Option<DemoAction>) {
        let mut outputs = Vec::new();

        if bytes.len() >= 8 && bytes[0] == PROTOCOL_SYNC_0 && bytes[1] == PROTOCOL_SYNC_1 {
            let cmd_id = bytes[2];
            let p1 = bytes[3];
            let p2 = bytes[4];
            let p3 = bytes[5];
            let p4 = bytes[6];

            match cmd_id {
                CMD_PING_STATUS => {
                    outputs.push(self.build_telemetry_frame());
                    return (outputs, None);
                }
                CMD_GET_CAPS => {
                    outputs.push(self.build_caps_frame());
                    return (outputs, None);
                }
                CMD_PIN_FORCE => {
                    let mut action = None;
                    if p1 == 0xff {
                        self.force_enable = 0;
                        self.forced_level = 0;
                        self.pull_up_mask = 0;
                        self.pull_down_mask = 0;
                        self.contention_mask = 0;
                    } else if p1 < 8 {
                        let bit = 1u8 << p1;
                        self.contention_mask &= !bit;
                        if p2 == 1 || p2 == 2 {
                            self.force_enable |= bit;
                            if p2 == 2 {
                                self.forced_level |= bit;
                            } else {
                                self.forced_level &= !bit;
                            }
                            self.pull_up_mask &= !bit;
                            self.pull_down_mask &= !bit;
                            if p4 != 0 && self.short_sim_pin == Some(p1) {
                                action = Some(DemoAction::ScheduleShortSim { pin: p1 });
                            }
                        } else {
                            self.force_enable &= !bit;
                            self.forced_level &= !bit;
                            match p3 {
                                1 => {
                                    self.pull_up_mask |= bit;
                                    self.pull_down_mask &= !bit;
                                }
                                2 => {
                                    self.pull_down_mask |= bit;
                                    self.pull_up_mask &= !bit;
                                }
                                _ => {
                                    self.pull_up_mask &= !bit;
                                    self.pull_down_mask &= !bit;
                                }
                            }
                        }
                    }
                    outputs.push(self.build_telemetry_frame());
                    return (outputs, action);
                }
                CMD_BATCH_FORCE => {
                    self.force_enable = p1;
                    self.forced_level = p2 & p1;
                    self.pull_up_mask = p3 & !p1;
                    self.pull_down_mask &= !p1;
                    self.contention_mask = 0;
                    outputs.push(self.build_telemetry_frame());
                    return (outputs, None);
                }
                CMD_LA_CAPTURE => {
                    let rate_id = (p1 as usize).min(RATE_PRESETS.len() - 1);
                    let trig_ch = p2;
                    let edge = p3 & 0x03;
                    let pre_trig_ratio = (p3 >> 4) & 0x03;
                    let blocks_kb = p4.clamp(1, 32) as usize;
                    let total_samples = blocks_kb * 1024;
                    let rate_hz = RATE_PRESETS[rate_id].hz as f64;
                    let duration_ms = ((total_samples as f64 / rate_hz) * 1000.0)
                        .round()
                        .clamp(40.0, 1800.0) as u32;

                    self.capture_state = Some(DemoCaptureState {
                        rate_id,
                        trig_ch,
                        edge,
                        pre_trig_ratio,
                        total_samples,
                    });
                    return (outputs, Some(DemoAction::ScheduleCapture { duration_ms }));
                }
                CMD_LA_ABORT => {
                    if self.capture_state.is_some() {
                        return (outputs, Some(DemoAction::AbortCapture));
                    }
                    return (outputs, None);
                }
                CMD_BOOTLOADER => {
                    self.force_enable = 0;
                    self.forced_level = 0;
                    outputs.push(self.build_telemetry_frame());
                    outputs.push(
                        b"\r\n[Demo] Simulated 0xF0 CMD_BOOTLOADER received (all pins released to Z).\r\n"
                            .to_vec(),
                    );
                    return (outputs, None);
                }
                _ => {}
            }
        }

        if let Ok(text) = std::str::from_utf8(bytes) {
            for ch in text.chars() {
                if ch == '\r' || ch == '\n' {
                    let cmd = self.ascii_line.trim().to_string();
                    self.ascii_line.clear();
                    self.handle_ascii_command(&cmd, &mut outputs);
                } else {
                    self.ascii_line.push(ch);
                }
            }
        }

        (outputs, None)
    }

    fn handle_ascii_command(&mut self, cmd: &str, outputs: &mut Vec<Vec<u8>>) {
        if cmd == "help" {
            outputs.push(
                b"\r\nDemo Commands: help, status, pins, release, short <0..7|off>, version\r\n"
                    .to_vec(),
            );
        } else if cmd == "pins" {
            outputs.push(
                b"\r\nCH0=D0(GPIO1) CH1=D1(GPIO2) CH2=D2(GPIO3) CH3=D3(GPIO4)\r\nCH4=D4(GPIO5) CH5=D5(GPIO6) CH6=D6(GPIO43) CH7=D7(GPIO44)\r\n"
                    .to_vec(),
            );
        } else if cmd == "release" {
            self.force_enable = 0;
            self.forced_level = 0;
            self.contention_mask = 0;
            outputs.push(self.build_telemetry_frame());
            outputs.push(b"\r\nAll channels released to Z.\r\n".to_vec());
        } else if cmd == "status" {
            outputs.push(
                format!(
                    "\r\n[STATUS] forceEn=0x{:x} forced=0x{:x} contention=0x{:x}\r\n",
                    self.force_enable, self.forced_level, self.contention_mask
                )
                .into_bytes(),
            );
        } else if let Some(rest) = cmd.strip_prefix("short") {
            let arg = rest.trim();
            if arg == "off" {
                self.short_sim_pin = None;
                outputs.push(b"\r\nShort-circuit simulation disabled.\r\n".to_vec());
            } else {
                let p = if arg.is_empty() {
                    Ok(7u8)
                } else {
                    arg.parse::<u8>()
                };
                if let Ok(pin) = p {
                    if pin <= 7 {
                        self.short_sim_pin = Some(pin);
                        outputs.push(
                            format!(
                                "\r\nSimulated short circuit armed on D{pin}. Force D{pin} to 0 or 1 to test 20ms cutoff!\r\n"
                            )
                            .into_bytes(),
                        );
                    }
                }
            }
        } else if cmd == "version" {
            outputs.push(b"\r\nHotWire-XIAO-ESP32S3 Demo v2.0.0\r\n".to_vec());
        } else if !cmd.is_empty() {
            outputs.push(format!("\r\nUnknown demo command: {cmd}\r\n").into_bytes());
        }
    }

    pub fn finish_capture(&mut self, aborted: bool) -> Option<Vec<u8>> {
        let st = self.capture_state.take()?;
        let rate_hz = RATE_PRESETS[st.rate_id].hz;
        let sample_count = if aborted {
            ((st.total_samples as f64 * 0.25).round() as usize).clamp(64, st.total_samples)
        } else {
            st.total_samples
        };

        let mut trig_index = 0usize;
        if st.trig_ch < 8 {
            trig_index = match st.pre_trig_ratio {
                1 => sample_count / 4,
                2 => sample_count / 2,
                3 => (sample_count * 3) / 4,
                _ => 0,
            };
        }

        let flags = (if aborted { LA_FLAG_ABORTED_EARLY } else { 0 })
            | (if st.trig_ch < 8 { LA_FLAG_TRIGGERED } else { 0 });

        let mut payload = vec![0u8; 8 + sample_count];
        payload[0..4].copy_from_slice(&rate_hz.to_le_bytes());
        payload[4..6].copy_from_slice(&(trig_index as u16).to_le_bytes());
        payload[6..8].copy_from_slice(&flags.to_le_bytes());

        self.synthesize_samples(&mut payload[8..], sample_count, rate_hz, trig_index, st);
        Some(encode_response_frame(TYPE_LA_CAPTURE_DATA, &payload))
    }

    fn synthesize_samples(
        &self,
        out: &mut [u8],
        sample_count: usize,
        rate_hz: u32,
        trig_index: usize,
        st: DemoCaptureState,
    ) {
        let pwm_period = 40isize;
        let pwm_shift: isize = if st.trig_ch == 7 {
            (if st.edge == 0 { 10 } else { 0 }) - ((trig_index as isize) % pwm_period)
        } else {
            0
        };

        for (i, slot) in out.iter_mut().enumerate().take(sample_count) {
            let phase = (((i as isize + pwm_shift) % pwm_period) + pwm_period) % pwm_period;
            let pwm_bit = if phase < 10 { 1u8 << 7 } else { 0 };
            *slot = (1 << 3) | (1 << 4) | (1 << 5) | (1 << 6) | pwm_bit;
        }

        // 1. D0..D3 -> SPI Mode 0 bursts
        let half_clk = ((sample_count as f64 / 512.0).round() as usize).clamp(2, 12);
        let mosi_bytes: [u8; 4] = [0xa5, 0x5a, 0x48, 0x57];
        let miso_bytes: [u8; 4] = [0x11, 0x22, 0x33, 0x44];
        let cs_lead = half_clk * 2;
        let spi_frame_len = cs_lead * 2 + mosi_bytes.len() * 8 * half_clk * 2;
        let spi_burst_span = (spi_frame_len + half_clk * 24) as isize;
        let mut spi_start = if st.trig_ch <= 3 {
            trig_index as isize
        } else {
            (half_clk * 8).min(sample_count.saturating_sub(1)) as isize
        };
        while spi_start - spi_burst_span >= (half_clk * 4) as isize {
            spi_start -= spi_burst_span;
        }

        let mut origin = spi_start;
        while origin < sample_count as isize {
            let mut p = origin;
            let mut set_spi_span = |len: usize, val: u8| {
                let s0 = p.clamp(0, sample_count as isize) as usize;
                let s1 = (p + len as isize).clamp(0, sample_count as isize) as usize;
                let masked = val & 0x0f;
                if s0 < s1 {
                    for slot in &mut out[s0..s1] {
                        *slot = (*slot & !0x0f) | masked;
                    }
                }
                p += len as isize;
            };
            set_spi_span(cs_lead, 0);
            for (&mo, &mi) in mosi_bytes.iter().zip(miso_bytes.iter()) {
                for b in (0..8).rev() {
                    let mosi = (mo >> b) & 1;
                    let miso = (mi >> b) & 1;
                    let data_bits = (mosi << 1) | (miso << 2);
                    set_spi_span(half_clk, data_bits);
                    set_spi_span(half_clk, data_bits | 1);
                }
            }
            set_spi_span(cs_lead, 0);
            origin += spi_burst_span;
        }

        // 2. D4..D5 -> I2C 0x3C Write
        let q = ((sample_count as f64 / 640.0).round() as usize).clamp(2, 12);
        let i2c_bytes: [u8; 4] = [0x3c << 1, 0x00, 0xae, 0xaf];
        let i2c_burst_span = (q * (i2c_bytes.len() * 9 * 4 + 32)) as isize;
        let mut i2c_start = if st.trig_ch == 4 || st.trig_ch == 5 {
            trig_index as isize
        } else {
            (q * 8).min(sample_count.saturating_sub(1)) as isize
        };
        while i2c_start - i2c_burst_span >= (q * 4) as isize {
            i2c_start -= i2c_burst_span;
        }

        let mut origin = i2c_start;
        while origin < sample_count as isize {
            let mut p = origin;
            let mut push_i2c = |scl: u8, sda: u8, len: usize| {
                let val = ((scl & 1) << 4) | ((sda & 1) << 5);
                let s0 = p.clamp(0, sample_count as isize) as usize;
                let s1 = (p + len as isize).clamp(0, sample_count as isize) as usize;
                if s0 < s1 {
                    for slot in &mut out[s0..s1] {
                        *slot = (*slot & !0x30) | val;
                    }
                }
                p += len as isize;
            };
            push_i2c(1, 0, q * 2);
            push_i2c(0, 0, q);
            for &byte_val in &i2c_bytes {
                for b in (0..8).rev() {
                    let bit = (byte_val >> b) & 1;
                    push_i2c(0, bit, q);
                    push_i2c(1, bit, q * 2);
                    push_i2c(0, bit, q);
                }
                push_i2c(0, 0, q);
                push_i2c(1, 0, q * 2);
                push_i2c(0, 0, q);
            }
            push_i2c(0, 0, q);
            push_i2c(1, 0, q * 2);
            push_i2c(1, 1, q * 2);
            origin += i2c_burst_span;
        }

        // 3. D6 -> UART 115200 8N1 ("HotWire!\r\n")
        let bit_samples = (rate_hz as f64 / 115200.0).max(2.0);
        let message = b"HotWire!\r\n";
        let byte_span = 10.5 * bit_samples;
        let uart_burst_span = (message.len() as f64 * byte_span + 40.0 * bit_samples).round() as isize;
        let mut uart_start = if st.trig_ch == 6 {
            trig_index as isize
        } else {
            ((bit_samples * 8.0).round() as usize).min(sample_count.saturating_sub(1)) as isize
        };
        let min_lead = (bit_samples * 4.0).round() as isize;
        while uart_start - uart_burst_span >= min_lead {
            uart_start -= uart_burst_span;
        }

        let mut burst_origin = uart_start;
        while burst_origin < sample_count as isize {
            for (char_idx, &byte_val) in message.iter().enumerate() {
                let char_start = burst_origin as f64 + (char_idx as f64) * byte_span;
                for bit_idx in 0..10 {
                    let logical_bit = if bit_idx == 0 {
                        0
                    } else if bit_idx == 9 {
                        1
                    } else {
                        (byte_val >> (bit_idx - 1)) & 1
                    };
                    let s0 = ((char_start + (bit_idx as f64) * bit_samples).round().max(0.0) as usize)
                        .min(sample_count);
                    let s1 = ((char_start + ((bit_idx + 1) as f64) * bit_samples)
                        .round()
                        .max(0.0) as usize)
                        .min(sample_count);
                    if s0 < s1 {
                        for slot in &mut out[s0..s1] {
                            if logical_bit == 0 {
                                *slot &= !(1 << 6);
                            } else {
                                *slot |= 1 << 6;
                            }
                        }
                    }
                }
            }
            burst_origin += uart_burst_span;
        }

        if self.force_enable != 0 {
            for slot in out.iter_mut().take(sample_count) {
                *slot = (*slot & !self.force_enable) | (self.forced_level & self.force_enable);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::codec::build_la_capture_cmd;
    use crate::protocol::decoders::{decode_i2c, decode_spi, decode_uart, BitOrder, I2cConfig, SpiConfig, UartConfig};
    use crate::protocol::demuxer::ProtocolDemuxer;

    #[test]
    fn demo_capture_decodes_spi_i2c_and_uart() {
        let mut sim = DemoSimulator::new();
        let cmd = build_la_capture_cmd(6, None, 1, 1, 8); // 1 MHz, 8k samples
        let (_, act) = sim.handle_tx(&cmd);
        assert!(matches!(act, Some(DemoAction::ScheduleCapture { .. })));
        let raw_frame = sim.finish_capture(false).expect("capture frame");

        let mut demux = ProtocolDemuxer::new();
        let mut packets = Vec::new();
        demux.push(&raw_frame, |p| packets.push(p), |_| {});
        assert_eq!(packets.len(), 1);

        let DecodedPacket::LaCaptureData(cap) = &packets[0] else {
            panic!("expected capture");
        };
        assert_eq!(cap.samples.len(), 8192);

        let spi = decode_spi(
            &cap.samples,
            SpiConfig {
                clk_ch: 0,
                mosi_ch: 1,
                miso_ch: Some(2),
                cs_ch: Some(3),
                cpol: 0,
                cpha: 0,
                bit_order: BitOrder::Msb,
            },
        );
        assert!(spi.len() >= 4);
        assert_eq!(spi[0].raw_byte, Some(0xa5));

        let i2c = decode_i2c(&cap.samples, I2cConfig { scl_ch: 4, sda_ch: 5 });
        assert!(i2c.iter().any(|f| f.label == "0x3C W ACK"));

        let uart = decode_uart(
            &cap.samples,
            cap.sample_rate_hz,
            UartConfig {
                rx_ch: 6,
                baud: 115200,
                invert: false,
            },
        );
        assert!(uart.iter().any(|f| f.raw_byte == Some(b'H')));
    }
}
