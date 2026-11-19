use serde::Deserialize;

use crate::protocol::types::*;

pub fn compute_xor_checksum(bytes: &[u8]) -> u8 {
    let mut xor = 0u8;
    for &b in bytes {
        xor ^= b;
    }
    xor
}

pub fn build_command_frame(cmd_id: u8, p1: u8, p2: u8, p3: u8, p4: u8) -> [u8; 8] {
    let mut frame = [
        PROTOCOL_SYNC_0,
        PROTOCOL_SYNC_1,
        cmd_id,
        p1,
        p2,
        p3,
        p4,
        0,
    ];
    frame[7] = compute_xor_checksum(&frame[..7]);
    frame
}

pub fn build_ping_status_cmd() -> [u8; 8] {
    build_command_frame(CMD_PING_STATUS, 0, 0, 0, 0)
}

pub fn build_get_caps_cmd() -> [u8; 8] {
    build_command_frame(CMD_GET_CAPS, 0, 0, 0, 0)
}

pub fn build_pin_force_cmd(
    channel: u8,
    mode: PinForceMode,
    pull: PinPullMode,
    protect: bool,
) -> [u8; 8] {
    build_command_frame(CMD_PIN_FORCE, channel, mode, pull, u8::from(protect))
}

pub fn build_release_all_cmd() -> [u8; 8] {
    build_pin_force_cmd(0xff, 0, 0, true)
}

#[allow(dead_code)]
pub fn build_batch_force_cmd(
    force_enable_mask: u8,
    forced_level_mask: u8,
    pullup_mask: u8,
) -> [u8; 8] {
    build_command_frame(
        CMD_BATCH_FORCE,
        force_enable_mask,
        forced_level_mask,
        pullup_mask,
        0,
    )
}

#[allow(dead_code)]
pub fn build_sig_gen_cmd(mode: SignalGenMode) -> [u8; 8] {
    build_command_frame(CMD_SIG_GEN, mode, 0, 0, 0)
}

pub fn encode_trigger_config(edge: TriggerEdge, pre_trigger: PreTriggerRatio) -> u8 {
    (edge & 0x03) | ((pre_trigger & 0x03) << 4)
}

pub fn build_la_capture_cmd(
    rate_id: u8,
    trigger_channel: Option<u8>,
    edge: TriggerEdge,
    pre_trigger: PreTriggerRatio,
    blocks_kb: u8,
) -> [u8; 8] {
    let rate = rate_id.min(10);
    let trig_ch = match trigger_channel {
        None => 0xff,
        Some(ch) => ch.min(7),
    };
    let trig_cfg = encode_trigger_config(edge, pre_trigger);
    let blocks = blocks_kb.clamp(1, 32);
    build_command_frame(CMD_LA_CAPTURE, rate, trig_ch, trig_cfg, blocks)
}

pub fn build_la_abort_cmd() -> [u8; 8] {
    build_command_frame(CMD_LA_ABORT, 0, 0, 0, 0)
}

#[allow(dead_code)]
pub fn build_bootloader_cmd() -> [u8; 8] {
    build_command_frame(CMD_BOOTLOADER, 0, 0, 0, 0)
}

pub fn encode_response_frame(type_id: u8, payload: &[u8]) -> Vec<u8> {
    let len = payload.len();
    let mut frame = Vec::with_capacity(6 + len);
    frame.push(PROTOCOL_SYNC_0);
    frame.push(PROTOCOL_SYNC_1);
    frame.push(type_id);
    frame.push((len & 0xff) as u8);
    frame.push(((len >> 8) & 0xff) as u8);
    frame.extend_from_slice(payload);
    let chk = compute_xor_checksum(&frame);
    frame.push(chk);
    frame
}

pub fn decode_status_telemetry(payload: &[u8]) -> Option<StatusTelemetry> {
    if payload.len() != 4 {
        return None;
    }
    Some(StatusTelemetry {
        physical_levels: payload[0],
        force_enable_mask: payload[1],
        forced_levels: payload[2],
        contention_mask: payload[3],
    })
}

pub fn decode_capture_data(payload: &[u8]) -> Option<CaptureDataFrame> {
    if payload.len() < 8 {
        return None;
    }
    let sample_rate_hz = u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]);
    let trigger_index = u16::from_le_bytes([payload[4], payload[5]]) as usize;
    let flags = u16::from_le_bytes([payload[6], payload[7]]);
    let samples = payload[8..].to_vec();
    Some(CaptureDataFrame {
        sample_rate_hz,
        trigger_index,
        flags,
        triggered: (flags & LA_FLAG_TRIGGERED) != 0,
        auto_triggered: (flags & LA_FLAG_AUTO_TIMEOUT) != 0,
        aborted_early: (flags & LA_FLAG_ABORTED_EARLY) != 0,
        samples,
    })
}

#[derive(Deserialize)]
struct RawBoardCaps {
    board: String,
    firmware: Option<String>,
    channels: usize,
    #[serde(rename = "maxRateHz")]
    max_rate_hz: Option<u32>,
    #[serde(rename = "maxDepth")]
    max_depth: Option<usize>,
    pins: Option<Vec<BoardPinMapping>>,
}

pub fn decode_board_capabilities(payload: &[u8]) -> Option<BoardCapabilities> {
    let text = std::str::from_utf8(payload).ok()?;
    let parsed: RawBoardCaps = serde_json::from_str(text).ok()?;
    Some(BoardCapabilities {
        board: parsed.board,
        firmware: parsed.firmware,
        channels: parsed.channels,
        max_rate_hz: parsed.max_rate_hz.unwrap_or(20_000_000),
        max_depth: parsed.max_depth.unwrap_or(32768),
        pins: parsed.pins.unwrap_or_default(),
    })
}

pub fn decode_response_payload(type_id: u8, payload: &[u8]) -> Option<DecodedPacket> {
    match type_id {
        TYPE_STATUS_TELEMETRY => {
            decode_status_telemetry(payload).map(DecodedPacket::StatusTelemetry)
        }
        TYPE_LA_CAPTURE_DATA => decode_capture_data(payload).map(DecodedPacket::LaCaptureData),
        TYPE_BOARD_CAPABILITIES => {
            decode_board_capabilities(payload).map(DecodedPacket::BoardCapabilities)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_valid_cmd(frame: &[u8; 8]) {
        assert_eq!(frame[0], PROTOCOL_SYNC_0);
        assert_eq!(frame[1], PROTOCOL_SYNC_1);
        assert_eq!(frame[7], compute_xor_checksum(&frame[..7]));
    }

    #[test]
    fn builds_valid_8_byte_commands() {
        let ping = build_ping_status_cmd();
        assert_valid_cmd(&ping);
        assert_eq!(ping[2], CMD_PING_STATUS);

        let caps = build_get_caps_cmd();
        assert_valid_cmd(&caps);
        assert_eq!(caps[2], CMD_GET_CAPS);

        let force = build_pin_force_cmd(6, 2, 1, true);
        assert_valid_cmd(&force);
        assert_eq!(&force[2..7], &[CMD_PIN_FORCE, 6, 2, 1, 1]);

        let release = build_release_all_cmd();
        assert_valid_cmd(&release);
        assert_eq!(&release[2..7], &[CMD_PIN_FORCE, 0xff, 0, 0, 1]);

        let batch = build_batch_force_cmd(0x0f, 0x05, 0xf0);
        assert_valid_cmd(&batch);
        assert_eq!(&batch[2..7], &[CMD_BATCH_FORCE, 0x0f, 0x05, 0xf0, 0x00]);

        let la_cap = build_la_capture_cmd(10, Some(3), 1, 2, 32);
        assert_valid_cmd(&la_cap);
        assert_eq!(&la_cap[2..7], &[CMD_LA_CAPTURE, 10, 3, 0x21, 32]);

        let la_free = build_la_capture_cmd(0, None, 0, 0, 16);
        assert_valid_cmd(&la_free);
        assert_eq!(&la_free[2..7], &[CMD_LA_CAPTURE, 0, 0xff, 0x00, 16]);

        let la_75 = build_la_capture_cmd(8, Some(6), 0, 3, 8);
        assert_valid_cmd(&la_75);
        assert_eq!(&la_75[2..7], &[CMD_LA_CAPTURE, 8, 6, 0x30, 8]);

        let sig = build_sig_gen_cmd(2);
        assert_valid_cmd(&sig);
        assert_eq!(&sig[2..7], &[CMD_SIG_GEN, 2, 0, 0, 0]);

        let abort = build_la_abort_cmd();
        assert_valid_cmd(&abort);
        assert_eq!(abort[2], CMD_LA_ABORT);

        let boot = build_bootloader_cmd();
        assert_valid_cmd(&boot);
        assert_eq!(boot[2], CMD_BOOTLOADER);
    }

    #[test]
    fn encodes_and_decodes_telemetry_capture_and_caps() {
        let tel_payload = [0b1010_0101u8, 0b0000_1111, 0b0000_0101, 0b1000_0000];
        let tel_frame = encode_response_frame(TYPE_STATUS_TELEMETRY, &tel_payload);
        assert_eq!(tel_frame.len(), 10);
        assert_eq!(tel_frame[9], compute_xor_checksum(&tel_frame[..9]));
        assert_eq!(
            decode_status_telemetry(&tel_payload),
            Some(StatusTelemetry {
                physical_levels: 0xa5,
                force_enable_mask: 0x0f,
                forced_levels: 0x05,
                contention_mask: 0x80,
            })
        );

        let mut cap_payload = vec![0u8; 8 + 4];
        cap_payload[0..4].copy_from_slice(&20_000_000u32.to_le_bytes());
        cap_payload[4..6].copy_from_slice(&2u16.to_le_bytes());
        cap_payload[6..8]
            .copy_from_slice(&(LA_FLAG_TRIGGERED | LA_FLAG_ABORTED_EARLY).to_le_bytes());
        cap_payload[8..12].copy_from_slice(&[1, 2, 3, 4]);
        let decoded = decode_capture_data(&cap_payload).expect("valid capture");
        assert_eq!(decoded.sample_rate_hz, 20_000_000);
        assert_eq!(decoded.trigger_index, 2);
        assert!(decoded.triggered);
        assert!(!decoded.auto_triggered);
        assert!(decoded.aborted_early);
        assert_eq!(decoded.samples, vec![1, 2, 3, 4]);

        let mut timeout_payload = vec![0u8; 8];
        timeout_payload[6..8].copy_from_slice(&LA_FLAG_AUTO_TIMEOUT.to_le_bytes());
        assert!(decode_capture_data(&timeout_payload).unwrap().auto_triggered);

        let json = br#"{"board":"XIAO-ESP32-S3","channels":8,"maxRateHz":20000000,"maxDepth":32768,"pins":[{"ch":0,"label":"D0","gpio":1}]}"#;
        let caps = decode_board_capabilities(json).expect("valid caps");
        assert_eq!(caps.board, "XIAO-ESP32-S3");
        assert_eq!(caps.max_depth, 32768);
    }
}
