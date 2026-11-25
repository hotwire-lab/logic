use std::fmt::Write as _;

use crate::protocol::types::{CaptureDataFrame, CHANNELS};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecoderKind {
    None,
    Uart,
    Spi,
    I2c,
}

impl DecoderKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            DecoderKind::None => "none",
            DecoderKind::Uart => "uart",
            DecoderKind::Spi => "spi",
            DecoderKind::I2c => "i2c",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "uart" => DecoderKind::Uart,
            "spi" => DecoderKind::Spi,
            "i2c" => DecoderKind::I2c,
            _ => DecoderKind::None,
        }
    }

    pub fn display_upper(&self) -> &'static str {
        match self {
            DecoderKind::None => "NONE",
            DecoderKind::Uart => "UART",
            DecoderKind::Spi => "SPI",
            DecoderKind::I2c => "I2C",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UartConfig {
    pub rx_ch: usize,
    pub baud: u32,
    pub invert: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BitOrder {
    Msb,
    #[allow(dead_code)]
    Lsb,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpiConfig {
    pub clk_ch: usize,
    pub mosi_ch: usize,
    pub miso_ch: Option<usize>,
    pub cs_ch: Option<usize>,
    pub cpol: u8,
    pub cpha: u8,
    pub bit_order: BitOrder,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct I2cConfig {
    pub scl_ch: usize,
    pub sda_ch: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecoderConfig {
    pub kind: DecoderKind,
    pub uart: UartConfig,
    pub spi: SpiConfig,
    pub i2c: I2cConfig,
}

impl Default for DecoderConfig {
    fn default() -> Self {
        Self {
            kind: DecoderKind::None,
            uart: UartConfig {
                rx_ch: 6,
                baud: 115200,
                invert: false,
            },
            spi: SpiConfig {
                clk_ch: 0,
                mosi_ch: 1,
                miso_ch: Some(2),
                cs_ch: Some(3),
                cpol: 0,
                cpha: 0,
                bit_order: BitOrder::Msb,
            },
            i2c: I2cConfig {
                scl_ch: 4,
                sda_ch: 5,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameBadgeKind {
    Data,
    Addr,
    Start,
    Stop,
    Error,
}

impl FrameBadgeKind {
    pub fn as_class(&self) -> &'static str {
        match self {
            FrameBadgeKind::Data => "data",
            FrameBadgeKind::Addr => "addr",
            FrameBadgeKind::Start => "start",
            FrameBadgeKind::Stop => "stop",
            FrameBadgeKind::Error => "error",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedFrameAnnotation {
    pub id: u32,
    pub channel: usize,
    pub secondary_channel: Option<usize>,
    pub start_sample: usize,
    pub end_sample: usize,
    pub label: String,
    pub secondary_label: Option<String>,
    pub detail: String,
    pub kind: FrameBadgeKind,
    pub raw_byte: Option<u8>,
    pub framing_error: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PulseMeasurement {
    pub channel: usize,
    pub level: u8,
    pub start_sample: usize,
    pub end_sample: usize,
    pub width_samples: usize,
    pub width_sec: f64,
    pub period_samples: Option<usize>,
    pub period_sec: Option<f64>,
    pub frequency_hz: Option<f64>,
    pub duty_percent: Option<f64>,
}

#[inline]
fn bit_at(samples: &[u8], ch: usize, idx: usize) -> u8 {
    (samples[idx] >> ch) & 1
}

pub fn find_nearest_edge(
    samples: &[u8],
    ch: usize,
    target_idx: f64,
    max_radius: usize,
) -> Option<usize> {
    if samples.len() < 2 {
        return None;
    }
    let center = (target_idx.round() as isize).clamp(1, (samples.len() - 1) as isize) as usize;
    let lo = center.saturating_sub(max_radius).max(1);
    let hi = (center + max_radius).min(samples.len() - 1);

    let mut best_idx = None;
    let mut best_dist = f64::INFINITY;
    for i in lo..=hi {
        if bit_at(samples, ch, i) != bit_at(samples, ch, i - 1) {
            let dist = ((i as f64) - target_idx).abs();
            if dist < best_dist {
                best_dist = dist;
                best_idx = Some(i);
            }
        }
    }
    best_idx
}

#[allow(dead_code)]
pub fn find_next_channel_edge(
    samples: &[u8],
    ch: usize,
    from_idx: f64,
    dir: i8,
) -> Option<usize> {
    if samples.len() < 2 {
        return None;
    }
    if dir > 0 {
        let start = ((from_idx.floor() as isize) + 1).max(1) as usize;
        for i in start..samples.len() {
            if bit_at(samples, ch, i) != bit_at(samples, ch, i - 1) {
                return Some(i);
            }
        }
        None
    } else {
        let start = ((from_idx.ceil() as isize) - 1).min((samples.len() - 1) as isize);
        if start < 1 {
            return None;
        }
        for i in (1..=(start as usize)).rev() {
            if bit_at(samples, ch, i) != bit_at(samples, ch, i - 1) {
                return Some(i);
            }
        }
        None
    }
}

pub fn count_channel_edges(
    samples: &[u8],
    ch: usize,
    start_idx: usize,
    end_idx: usize,
) -> (usize, usize) {
    if samples.len() < 2 {
        return (0, 0);
    }
    let a = start_idx.min(end_idx);
    let b = start_idx.max(end_idx);
    let lo = (a + 1).max(1);
    let hi = b.min(samples.len() - 1);
    let mut rising = 0usize;
    let mut falling = 0usize;
    for i in lo..=hi {
        let prev = bit_at(samples, ch, i - 1);
        let cur = bit_at(samples, ch, i);
        if prev == 0 && cur == 1 {
            rising += 1;
        } else if prev == 1 && cur == 0 {
            falling += 1;
        }
    }
    (rising, falling)
}

pub fn measure_pulse_at_sample(
    samples: &[u8],
    ch: usize,
    sample_idx: usize,
    sample_rate_hz: u32,
) -> Option<PulseMeasurement> {
    if samples.len() < 3 || sample_rate_hz == 0 {
        return None;
    }
    let idx = sample_idx.min(samples.len() - 1);
    let level = bit_at(samples, ch, idx);

    let mut left_edge = None;
    for i in (1..=idx).rev() {
        if bit_at(samples, ch, i) != bit_at(samples, ch, i - 1) {
            left_edge = Some(i);
            break;
        }
    }
    let left_edge = left_edge?;

    let mut right_edge = None;
    for i in (idx + 1)..samples.len() {
        if bit_at(samples, ch, i) != bit_at(samples, ch, i - 1) {
            right_edge = Some(i);
            break;
        }
    }
    let right_edge = right_edge?;

    let width_samples = right_edge - left_edge;
    let rate = sample_rate_hz as f64;
    let width_sec = width_samples as f64 / rate;

    let mut period_samples = None;
    for i in (right_edge + 1)..samples.len() {
        if bit_at(samples, ch, i) != bit_at(samples, ch, i - 1) {
            period_samples = Some(i - left_edge);
            break;
        }
    }
    if period_samples.is_none() && left_edge > 1 {
        for i in (1..left_edge).rev() {
            if bit_at(samples, ch, i) != bit_at(samples, ch, i - 1) {
                period_samples = Some(right_edge - i);
                break;
            }
        }
    }

    let (period_sec, frequency_hz, duty_percent) = match period_samples {
        Some(ps) if ps > 0 => {
            let p_sec = ps as f64 / rate;
            let f_hz = rate / ps as f64;
            let high_samples = if level == 1 {
                width_samples
            } else {
                ps.saturating_sub(width_samples)
            };
            let duty = ((high_samples as f64 / ps as f64) * 100.0).clamp(0.0, 100.0);
            (Some(p_sec), Some(f_hz), Some(duty))
        }
        _ => (None, None, None),
    };

    Some(PulseMeasurement {
        channel: ch,
        level,
        start_sample: left_edge,
        end_sample: right_edge,
        width_samples,
        width_sec,
        period_samples,
        period_sec,
        frequency_hz,
        duty_percent,
    })
}

fn format_byte_label(byte: u8) -> (String, Option<String>) {
    let hex = format!("0x{byte:02X}");
    let ascii = match byte {
        0x20..=0x7e => Some(format!("'{}'", byte as char)),
        0x0d => Some("\\r".to_string()),
        0x0a => Some("\\n".to_string()),
        0x09 => Some("\\t".to_string()),
        0x00 => Some("\\0".to_string()),
        _ => None,
    };
    (hex, ascii)
}

pub fn decode_uart(
    samples: &[u8],
    sample_rate_hz: u32,
    opts: UartConfig,
) -> Vec<DecodedFrameAnnotation> {
    let mut results = Vec::new();
    if samples.len() < 4 || sample_rate_hz == 0 || opts.baud == 0 {
        return results;
    }
    let bit_samples = (sample_rate_hz as f64) / (opts.baud as f64);
    if !bit_samples.is_finite() || bit_samples < 2.0 {
        return results;
    }

    let idle_level = u8::from(!opts.invert);
    let active_level = u8::from(opts.invert);
    let mut id_counter = 1u32;
    let mut i = 1usize;

    while i < samples.len() {
        let prev = bit_at(samples, opts.rx_ch, i - 1);
        let cur = bit_at(samples, opts.rx_ch, i);
        if prev != idle_level || cur != active_level {
            i += 1;
            continue;
        }

        let start_mid = ((i as f64) + 0.5 * bit_samples).round() as usize;
        if start_mid >= samples.len() {
            break;
        }
        if bit_at(samples, opts.rx_ch, start_mid) != active_level {
            i += 1;
            continue;
        }

        let stop_mid = ((i as f64) + 9.5 * bit_samples).round() as usize;
        if stop_mid >= samples.len() {
            break;
        }

        let mut byte_val = 0u8;
        for b in 0..8 {
            let bit_pos = ((i as f64) + (1.5 + b as f64) * bit_samples).round() as usize;
            let raw = bit_at(samples, opts.rx_ch, bit_pos);
            let logical = if opts.invert { raw ^ 1 } else { raw };
            byte_val |= logical << b;
        }

        let stop_raw = bit_at(samples, opts.rx_ch, stop_mid);
        let framing_error = stop_raw != idle_level;
        let end_sample = (((i as f64) + 10.0 * bit_samples).round() as usize).min(samples.len() - 1);
        let (hex, ascii) = format_byte_label(byte_val);
        let base_label = match &ascii {
            Some(a) => format!("{hex} {a}"),
            None => hex.clone(),
        };
        let label = if framing_error {
            format!("{base_label} !ERR")
        } else {
            base_label
        };
        let detail = format!(
            "UART {hex}{}{}",
            ascii.as_deref().map(|a| format!(" ({a})")).unwrap_or_default(),
            if framing_error { " [Framing Error]" } else { "" }
        );

        results.push(DecodedFrameAnnotation {
            id: id_counter,
            channel: opts.rx_ch,
            secondary_channel: None,
            start_sample: i,
            end_sample,
            label,
            secondary_label: None,
            detail,
            kind: if framing_error {
                FrameBadgeKind::Error
            } else {
                FrameBadgeKind::Data
            },
            raw_byte: Some(byte_val),
            framing_error,
        });
        id_counter += 1;
        i = (i + 1).max(stop_mid);
    }

    results
}

pub fn decode_spi(samples: &[u8], opts: SpiConfig) -> Vec<DecodedFrameAnnotation> {
    let mut results = Vec::new();
    if samples.len() < 4 {
        return results;
    }

    let sample_on_rising = opts.cpol == opts.cpha;
    let mut id_counter = 1u32;
    let mut bit_count = 0u8;
    let mut mosi_byte = 0u8;
    let mut miso_byte = 0u8;
    let mut byte_start_sample = 0usize;

    for i in 1..samples.len() {
        if let Some(cs_ch) = opts.cs_ch {
            if bit_at(samples, cs_ch, i) == 1 {
                bit_count = 0;
                mosi_byte = 0;
                miso_byte = 0;
                continue;
            }
        }

        let prev_clk = bit_at(samples, opts.clk_ch, i - 1);
        let cur_clk = bit_at(samples, opts.clk_ch, i);
        let is_sample_edge = if sample_on_rising {
            prev_clk == 0 && cur_clk == 1
        } else {
            prev_clk == 1 && cur_clk == 0
        };
        if !is_sample_edge {
            continue;
        }

        if bit_count == 0 {
            byte_start_sample = i;
        }

        let mosi_bit = bit_at(samples, opts.mosi_ch, i);
        let miso_bit = opts.miso_ch.map(|c| bit_at(samples, c, i)).unwrap_or(0);
        let shift_pos = match opts.bit_order {
            BitOrder::Msb => 7 - bit_count,
            BitOrder::Lsb => bit_count,
        };

        if mosi_bit != 0 {
            mosi_byte |= 1 << shift_pos;
        }
        if miso_bit != 0 {
            miso_byte |= 1 << shift_pos;
        }
        bit_count += 1;

        if bit_count == 8 {
            let (mosi_hex, mosi_ascii) = format_byte_label(mosi_byte);
            let miso_hex = opts.miso_ch.map(|_| format!("0x{miso_byte:02X}"));
            let label = match &mosi_ascii {
                Some(a) => format!("{mosi_hex} {a}"),
                None => mosi_hex.clone(),
            };
            let detail = match &miso_hex {
                Some(mh) => format!(
                    "SPI MOSI {mosi_hex}{} | MISO {mh}",
                    mosi_ascii
                        .as_deref()
                        .map(|a| format!(" ({a})"))
                        .unwrap_or_default()
                ),
                None => format!(
                    "SPI MOSI {mosi_hex}{}",
                    mosi_ascii
                        .as_deref()
                        .map(|a| format!(" ({a})"))
                        .unwrap_or_default()
                ),
            };

            results.push(DecodedFrameAnnotation {
                id: id_counter,
                channel: opts.mosi_ch,
                secondary_channel: opts.miso_ch,
                start_sample: byte_start_sample,
                end_sample: (i + 1).min(samples.len() - 1),
                label,
                secondary_label: miso_hex,
                detail,
                kind: FrameBadgeKind::Data,
                raw_byte: Some(mosi_byte),
                framing_error: false,
            });
            id_counter += 1;
            bit_count = 0;
            mosi_byte = 0;
            miso_byte = 0;
        }
    }

    results
}

pub fn decode_i2c(samples: &[u8], opts: I2cConfig) -> Vec<DecodedFrameAnnotation> {
    let mut results = Vec::new();
    if samples.len() < 4 {
        return results;
    }

    let mut id_counter = 1u32;
    let mut in_transaction = false;
    let mut is_address_phase = true;
    let mut bit_count = 0u8;
    let mut cur_byte = 0u8;
    let mut byte_start_sample = 0usize;

    for i in 1..samples.len() {
        let prev_scl = bit_at(samples, opts.scl_ch, i - 1);
        let cur_scl = bit_at(samples, opts.scl_ch, i);
        let prev_sda = bit_at(samples, opts.sda_ch, i - 1);
        let cur_sda = bit_at(samples, opts.sda_ch, i);

        // START / Repeated START
        if prev_scl == 1 && cur_scl == 1 && prev_sda == 1 && cur_sda == 0 {
            let label = if in_transaction { "Sr" } else { "S" };
            in_transaction = true;
            is_address_phase = true;
            bit_count = 0;
            cur_byte = 0;
            results.push(DecodedFrameAnnotation {
                id: id_counter,
                channel: opts.sda_ch,
                secondary_channel: None,
                start_sample: i.saturating_sub(1),
                end_sample: (i + 1).min(samples.len() - 1),
                label: label.to_string(),
                secondary_label: None,
                detail: if label == "Sr" {
                    "I2C Repeated START".to_string()
                } else {
                    "I2C START".to_string()
                },
                kind: FrameBadgeKind::Start,
                raw_byte: None,
                framing_error: false,
            });
            id_counter += 1;
            continue;
        }

        // STOP
        if prev_scl == 1 && cur_scl == 1 && prev_sda == 0 && cur_sda == 1 {
            if in_transaction {
                results.push(DecodedFrameAnnotation {
                    id: id_counter,
                    channel: opts.sda_ch,
                    secondary_channel: None,
                    start_sample: i.saturating_sub(1),
                    end_sample: (i + 1).min(samples.len() - 1),
                    label: "P".to_string(),
                    secondary_label: None,
                    detail: "I2C STOP".to_string(),
                    kind: FrameBadgeKind::Stop,
                    raw_byte: None,
                    framing_error: false,
                });
                id_counter += 1;
            }
            in_transaction = false;
            is_address_phase = true;
            bit_count = 0;
            cur_byte = 0;
            continue;
        }

        if in_transaction && prev_scl == 0 && cur_scl == 1 {
            if bit_count < 8 {
                if bit_count == 0 {
                    byte_start_sample = i;
                }
                cur_byte = (cur_byte << 1) | cur_sda;
                bit_count += 1;
            } else {
                let ack = cur_sda == 0;
                let ack_str = if ack { "ACK" } else { "NACK" };
                if is_address_phase {
                    let addr = (cur_byte >> 1) & 0x7f;
                    let rw = if (cur_byte & 1) == 1 { "R" } else { "W" };
                    let addr_hex = format!("0x{addr:02X}");
                    results.push(DecodedFrameAnnotation {
                        id: id_counter,
                        channel: opts.sda_ch,
                        secondary_channel: None,
                        start_sample: byte_start_sample,
                        end_sample: (i + 1).min(samples.len() - 1),
                        label: format!("{addr_hex} {rw} {ack_str}"),
                        secondary_label: None,
                        detail: format!(
                            "I2C Addr {addr_hex} ({}) {ack_str}",
                            if rw == "W" { "Write" } else { "Read" }
                        ),
                        kind: if ack {
                            FrameBadgeKind::Addr
                        } else {
                            FrameBadgeKind::Error
                        },
                        raw_byte: Some(cur_byte),
                        framing_error: false,
                    });
                    is_address_phase = false;
                } else {
                    let (hex, ascii) = format_byte_label(cur_byte);
                    results.push(DecodedFrameAnnotation {
                        id: id_counter,
                        channel: opts.sda_ch,
                        secondary_channel: None,
                        start_sample: byte_start_sample,
                        end_sample: (i + 1).min(samples.len() - 1),
                        label: format!("{hex} {ack_str}"),
                        secondary_label: None,
                        detail: format!(
                            "I2C Data {hex}{} {ack_str}",
                            ascii.as_deref().map(|a| format!(" ({a})")).unwrap_or_default()
                        ),
                        kind: if ack {
                            FrameBadgeKind::Data
                        } else {
                            FrameBadgeKind::Error
                        },
                        raw_byte: Some(cur_byte),
                        framing_error: false,
                    });
                }
                id_counter += 1;
                bit_count = 0;
                cur_byte = 0;
            }
        }
    }

    results
}

pub fn decode_protocol(
    samples: &[u8],
    sample_rate_hz: u32,
    config: DecoderConfig,
) -> Vec<DecodedFrameAnnotation> {
    match config.kind {
        DecoderKind::Uart => decode_uart(samples, sample_rate_hz, config.uart),
        DecoderKind::Spi => decode_spi(samples, config.spi),
        DecoderKind::I2c => decode_i2c(samples, config.i2c),
        DecoderKind::None => Vec::new(),
    }
}

pub fn export_capture_to_csv(capture: &CaptureDataFrame, channel_names: &[String]) -> String {
    let headers: Vec<String> = CHANNELS
        .iter()
        .enumerate()
        .map(|(ch, meta)| {
            let alias = channel_names.get(ch).map(|s| s.trim()).unwrap_or("");
            let label = if !alias.is_empty() && alias != meta.label {
                format!("{}_{}", meta.label, alias)
            } else {
                meta.label.to_string()
            };
            label
                .chars()
                .map(|c| {
                    if c.is_whitespace() || matches!(c, ',' | ';' | '"' | '\'') {
                        '_'
                    } else {
                        c
                    }
                })
                .collect()
        })
        .collect();

    let mut out = String::with_capacity(capture.samples.len() * 32 + 128);
    let _ = writeln!(out, "sample_index,time_s,{}", headers.join(","));

    let rate = capture.sample_rate_hz.max(1) as f64;
    for (i, &s) in capture.samples.iter().enumerate() {
        let t = (i as f64) / rate;
        let _ = writeln!(
            out,
            "{i},{t:.9},{},{},{},{},{},{},{},{}",
            s & 1,
            (s >> 1) & 1,
            (s >> 2) & 1,
            (s >> 3) & 1,
            (s >> 4) & 1,
            (s >> 5) & 1,
            (s >> 6) & 1,
            (s >> 7) & 1
        );
    }
    out
}

const VCD_SYMBOLS: [char; 8] = ['!', '"', '#', '$', '%', '&', '\'', '('];

pub fn export_capture_to_vcd(capture: &CaptureDataFrame, channel_names: &[String]) -> String {
    let rate = if capture.sample_rate_hz > 0 {
        capture.sample_rate_hz as f64
    } else {
        1_000_000.0
    };
    let ps_per_sample = (1e12 / rate).round().max(1.0) as u64;

    let mut out = String::with_capacity(capture.samples.len() * 8 + 512);
    out.push_str("$version HotWire Logic Analyzer $end\n");
    out.push_str("$timescale 1ps $end\n");
    out.push_str("$scope module hotwire $end\n");

    for (ch, meta) in CHANNELS.iter().enumerate() {
        let alias = channel_names.get(ch).map(|s| s.trim()).unwrap_or("");
        let raw_name = if !alias.is_empty() && alias != meta.label {
            format!("{}_{}", meta.label, alias)
        } else {
            meta.label.to_string()
        };
        let safe_name: String = raw_name
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        let name = if safe_name.is_empty() {
            meta.label.to_string()
        } else {
            safe_name
        };
        let _ = writeln!(out, "$var wire 1 {} {} $end", VCD_SYMBOLS[ch], name);
    }

    out.push_str("$upscope $end\n$enddefinitions $end\n$dumpvars\n");

    if let Some(&first) = capture.samples.first() {
        for (ch, &sym) in VCD_SYMBOLS.iter().enumerate() {
            let _ = writeln!(out, "{}{}", (first >> ch) & 1, sym);
        }
        out.push_str("$end\n");

        let mut prev = first;
        for (i, &cur) in capture.samples.iter().enumerate().skip(1) {
            let diff = cur ^ prev;
            if diff == 0 {
                continue;
            }
            let _ = writeln!(out, "#{}", (i as u64) * ps_per_sample);
            for (ch, &sym) in VCD_SYMBOLS.iter().enumerate() {
                if ((diff >> ch) & 1) != 0 {
                    let _ = writeln!(out, "{}{}", (cur >> ch) & 1, sym);
                }
            }
            prev = cur;
        }
        let end_ts = (capture.samples.len() as u64) * ps_per_sample;
        let _ = writeln!(out, "#{end_ts}");
    } else {
        for &sym in &VCD_SYMBOLS {
            let _ = writeln!(out, "0{sym}");
        }
        out.push_str("$end\n");
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_uart_samples(
        text: &str,
        sample_rate_hz: u32,
        baud: u32,
        ch: usize,
        invert: bool,
        bad_stop_idx: Option<usize>,
    ) -> Vec<u8> {
        let bit_samples = sample_rate_hz as f64 / baud as f64;
        let idle = !invert;
        let lead = (bit_samples * 3.0).round() as usize;
        let total = (lead as f64 + (text.len() as f64) * 11.0 * bit_samples + bit_samples * 4.0)
            .ceil() as usize;
        let mut buf = vec![if idle { 1u8 << ch } else { 0u8 }; total];

        let mut cursor = lead as f64;
        for (idx, byte) in text.bytes().enumerate() {
            let mut bits = [0u8; 10];
            bits[0] = 0;
            for b in 0..8 {
                bits[1 + b] = (byte >> b) & 1;
            }
            bits[9] = if bad_stop_idx == Some(idx) { 0 } else { 1 };

            for (k, &bit) in bits.iter().enumerate() {
                let start = (cursor + (k as f64) * bit_samples).round() as usize;
                let end = ((cursor + ((k + 1) as f64) * bit_samples).round() as usize).min(buf.len());
                let physical = if invert { bit ^ 1 } else { bit };
                let level = if physical != 0 { 1u8 << ch } else { 0 };
                for slot in &mut buf[start..end] {
                    *slot = level;
                }
            }
            cursor = (cursor + 10.5 * bit_samples).round();
        }
        buf
    }

    #[test]
    fn measures_pulse_and_edges() {
        let mut samples = vec![0u8; 150];
        for s in &mut samples[10..35] {
            *s = 1;
        }
        for s in &mut samples[110..135] {
            *s = 1;
        }

        let hp = measure_pulse_at_sample(&samples, 0, 20, 1_000_000).unwrap();
        assert_eq!(hp.level, 1);
        assert_eq!(hp.start_sample, 10);
        assert_eq!(hp.end_sample, 35);
        assert_eq!(hp.width_samples, 25);
        assert_eq!(hp.period_samples, Some(100));
        assert!((hp.frequency_hz.unwrap() - 10_000.0).abs() < 1.0);
        assert!((hp.duty_percent.unwrap() - 25.0).abs() < 0.1);

        let lp = measure_pulse_at_sample(&samples, 0, 50, 1_000_000).unwrap();
        assert_eq!(lp.level, 0);
        assert_eq!(lp.width_samples, 75);
        assert!((lp.duty_percent.unwrap() - 25.0).abs() < 0.1);

        assert!(measure_pulse_at_sample(&samples, 0, 2, 1_000_000).is_none());

        let mut s2 = vec![0u8; 64];
        for s in &mut s2[10..20] {
            *s = 0b0000_0100;
        }
        for s in &mut s2[30..45] {
            *s = 0b0000_0100;
        }
        assert_eq!(find_nearest_edge(&s2, 2, 11.2, 4), Some(10));
        assert_eq!(find_nearest_edge(&s2, 2, 15.0, 2), None);
        assert_eq!(find_next_channel_edge(&s2, 2, 12.0, 1), Some(20));
        assert_eq!(find_next_channel_edge(&s2, 2, 12.0, -1), Some(10));
        assert_eq!(count_channel_edges(&s2, 2, 5, 50), (2, 2));
    }

    #[test]
    fn decodes_uart_spi_and_i2c() {
        // UART
        let rate = 2_000_000;
        let samples = make_uart_samples("HW\r\n", rate, 115200, 6, false, None);
        let frames = decode_uart(&samples, rate, UartConfig { rx_ch: 6, baud: 115200, invert: false });
        let raw: Vec<u8> = frames.iter().filter_map(|f| f.raw_byte).collect();
        assert_eq!(raw, vec![0x48, 0x57, 0x0d, 0x0a]);
        assert_eq!(frames[0].label, "0x48 'H'");
        assert_eq!(frames[2].label, "0x0D \\r");
        assert!(frames.iter().all(|f| !f.framing_error));

        let bad = make_uart_samples("OK", rate, 115200, 6, false, Some(1));
        let bad_frames = decode_uart(&bad, rate, UartConfig { rx_ch: 6, baud: 115200, invert: false });
        assert!(!bad_frames[0].framing_error);
        assert!(bad_frames[1].framing_error);
        assert_eq!(bad_frames[1].kind, FrameBadgeKind::Error);

        // SPI Mode 0
        let mut spi = Vec::new();
        let mut push_spi = |clk: u8, mosi: u8, miso: u8, cs: u8, count: usize| {
            let val = (clk & 1) | ((mosi & 1) << 1) | ((miso & 1) << 2) | ((cs & 1) << 3);
            for _ in 0..count {
                spi.push(val);
            }
        };
        push_spi(0, 0, 0, 1, 8);
        push_spi(0, 0, 0, 0, 4);
        for (&mo, &mi) in [0xa5u8, 0x5a].iter().zip([0x12u8, 0x34].iter()) {
            for b in (0..8).rev() {
                push_spi(0, (mo >> b) & 1, (mi >> b) & 1, 0, 4);
                push_spi(1, (mo >> b) & 1, (mi >> b) & 1, 0, 4);
            }
        }
        push_spi(0, 0, 0, 1, 8);
        let spi_frames = decode_spi(
            &spi,
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
        assert_eq!(spi_frames.iter().filter_map(|f| f.raw_byte).collect::<Vec<_>>(), vec![0xa5, 0x5a]);
        assert_eq!(spi_frames[0].secondary_label.as_deref(), Some("0x12"));
        assert_eq!(spi_frames[1].secondary_label.as_deref(), Some("0x34"));

        // I2C
        fn push_i2c(buf: &mut Vec<u8>, scl: u8, sda: u8, count: usize) {
            let v = (scl & 1) | ((sda & 1) << 1);
            for _ in 0..count {
                buf.push(v);
            }
        }
        fn write_i2c_byte(buf: &mut Vec<u8>, byte: u8, ack: u8) {
            for b in (0..8).rev() {
                let bit = (byte >> b) & 1;
                push_i2c(buf, 0, bit, 3);
                push_i2c(buf, 1, bit, 3);
                push_i2c(buf, 0, bit, 2);
            }
            push_i2c(buf, 0, ack, 3);
            push_i2c(buf, 1, ack, 3);
            push_i2c(buf, 0, ack, 2);
        }
        let mut i2c = Vec::new();
        push_i2c(&mut i2c, 1, 1, 6);
        push_i2c(&mut i2c, 1, 0, 4);
        push_i2c(&mut i2c, 0, 0, 2);
        write_i2c_byte(&mut i2c, 0x3c << 1, 0);
        write_i2c_byte(&mut i2c, 0xae, 1);
        push_i2c(&mut i2c, 0, 0, 3);
        push_i2c(&mut i2c, 1, 0, 4);
        push_i2c(&mut i2c, 1, 1, 6);

        let i2c_frames = decode_i2c(&i2c, I2cConfig { scl_ch: 0, sda_ch: 1 });
        let labels: Vec<&str> = i2c_frames.iter().map(|f| f.label.as_str()).collect();
        assert_eq!(labels, vec!["S", "0x3C W ACK", "0xAE NACK", "P"]);
        assert_eq!(i2c_frames[1].kind, FrameBadgeKind::Addr);
        assert_eq!(i2c_frames[2].kind, FrameBadgeKind::Error);
    }

    #[test]
    fn exports_csv_and_vcd() {
        let capture = CaptureDataFrame {
            sample_rate_hz: 1_000_000,
            trigger_index: 1,
            flags: 1,
            triggered: true,
            auto_triggered: false,
            aborted_early: false,
            samples: vec![0b0000_0000, 0b0000_0011, 0b0000_0011, 0b0000_0001],
        };
        let names = vec!["SCL".to_string(), "SDA".to_string()];
        let csv = export_capture_to_csv(&capture, &names);
        let lines: Vec<&str> = csv.trim().lines().collect();
        assert_eq!(lines[0], "sample_index,time_s,D0_SCL,D1_SDA,D2,D3,D4,D5,D6,D7");
        assert_eq!(lines[1], "0,0.000000000,0,0,0,0,0,0,0,0");
        assert_eq!(lines[2], "1,0.000001000,1,1,0,0,0,0,0,0");

        let vcd = export_capture_to_vcd(&capture, &names);
        assert!(vcd.contains("$timescale 1ps $end"));
        assert!(vcd.contains("$var wire 1 ! D0_SCL $end"));
        assert!(vcd.contains("$var wire 1 \" D1_SDA $end"));
        assert!(vcd.contains("#1000000\n1!\n1\""));
        assert!(vcd.contains("#3000000\n0\""));
    }
}
