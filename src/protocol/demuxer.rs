use crate::protocol::codec::{compute_xor_checksum, decode_response_payload};
use crate::protocol::types::{
    DecodedPacket, MAX_FRAME_PAYLOAD_LEN, PROTOCOL_SYNC_0, PROTOCOL_SYNC_1,
    TYPE_BOARD_CAPABILITIES, TYPE_LA_CAPTURE_DATA, TYPE_STATUS_TELEMETRY,
};

fn is_valid_frame_type(type_id: u8) -> bool {
    matches!(
        type_id,
        TYPE_STATUS_TELEMETRY | TYPE_LA_CAPTURE_DATA | TYPE_BOARD_CAPABILITIES
    )
}

fn is_valid_length_for_type(type_id: u8, len: usize) -> bool {
    if len > MAX_FRAME_PAYLOAD_LEN {
        return false;
    }
    match type_id {
        TYPE_STATUS_TELEMETRY => len == 4,
        TYPE_LA_CAPTURE_DATA => len >= 8,
        TYPE_BOARD_CAPABILITIES => (2..=4096).contains(&len),
        _ => false,
    }
}

pub struct ProtocolDemuxer {
    buffer: Vec<u8>,
}

impl Default for ProtocolDemuxer {
    fn default() -> Self {
        Self::new()
    }
}

impl ProtocolDemuxer {
    pub fn new() -> Self {
        Self { buffer: Vec::new() }
    }

    pub fn reset(&mut self) {
        self.buffer.clear();
    }

    pub fn push<FP, FT>(&mut self, chunk: &[u8], mut on_packet: FP, mut on_text: FT)
    where
        FP: FnMut(DecodedPacket),
        FT: FnMut(&[u8]),
    {
        if chunk.is_empty() {
            return;
        }
        let mut combined = Vec::with_capacity(self.buffer.len() + chunk.len());
        combined.extend_from_slice(&self.buffer);
        combined.extend_from_slice(chunk);

        let mut cursor = 0usize;
        let mut text_start = 0usize;
        let mut pending_text: Vec<u8> = Vec::new();

        while cursor < combined.len() {
            if combined[cursor] != PROTOCOL_SYNC_0 {
                cursor += 1;
                continue;
            }
            if cursor + 1 >= combined.len() {
                break;
            }
            if combined[cursor + 1] != PROTOCOL_SYNC_1 {
                cursor += 1;
                continue;
            }
            if cursor + 5 > combined.len() {
                break;
            }

            let type_id = combined[cursor + 2];
            let payload_len =
                (combined[cursor + 3] as usize) | ((combined[cursor + 4] as usize) << 8);

            if !is_valid_frame_type(type_id) || !is_valid_length_for_type(type_id, payload_len) {
                cursor += 1;
                continue;
            }

            let total_frame_len = 6 + payload_len;
            if cursor + total_frame_len > combined.len() {
                break;
            }

            let frame_slice = &combined[cursor..cursor + total_frame_len];
            let expected_xor = compute_xor_checksum(&frame_slice[..total_frame_len - 1]);
            let actual_xor = frame_slice[total_frame_len - 1];

            if expected_xor != actual_xor {
                cursor += 1;
                continue;
            }

            let payload = &frame_slice[5..5 + payload_len];
            let Some(decoded) = decode_response_payload(type_id, payload) else {
                cursor += 1;
                continue;
            };

            if cursor > text_start {
                pending_text.extend_from_slice(&combined[text_start..cursor]);
            }
            if !pending_text.is_empty() {
                on_text(&pending_text);
                pending_text.clear();
            }

            on_packet(decoded);
            cursor += total_frame_len;
            text_start = cursor;
        }

        if cursor > text_start {
            pending_text.extend_from_slice(&combined[text_start..cursor]);
        }
        if !pending_text.is_empty() {
            on_text(&pending_text);
        }

        self.buffer = if cursor < combined.len() {
            combined[cursor..].to_vec()
        } else {
            Vec::new()
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::codec::encode_response_frame;
    use crate::protocol::types::StatusTelemetry;

    #[test]
    fn separates_mixed_utf8_and_binary_packets_across_fragments() {
        let mut packets = Vec::new();
        let mut text_bytes = Vec::new();
        let mut demux = ProtocolDemuxer::new();

        let log1 = b"[HotWire] Boot OK\r\n";
        let tel = encode_response_frame(TYPE_STATUS_TELEMETRY, &[0x12, 0x03, 0x01, 0x00]);
        let caps = encode_response_frame(
            TYPE_BOARD_CAPABILITIES,
            br#"{"board":"XIAO-ESP32-S3","channels":8}"#,
        );
        let log2 = b"Ready> ";

        let mut stream = Vec::new();
        stream.extend_from_slice(log1);
        stream.extend_from_slice(&tel);
        stream.extend_from_slice(&caps);
        stream.extend_from_slice(log2);

        for chunk in stream.chunks(3) {
            demux.push(chunk, |p| packets.push(p), |b| text_bytes.extend_from_slice(b));
        }

        assert_eq!(packets.len(), 2);
        assert_eq!(
            packets[0],
            DecodedPacket::StatusTelemetry(StatusTelemetry {
                physical_levels: 0x12,
                force_enable_mask: 0x03,
                forced_levels: 0x01,
                contention_mask: 0x00,
            })
        );
        match &packets[1] {
            DecodedPacket::BoardCapabilities(c) => assert_eq!(c.board, "XIAO-ESP32-S3"),
            _ => panic!("expected capabilities"),
        }
        assert_eq!(
            String::from_utf8(text_bytes).unwrap(),
            "[HotWire] Boot OK\r\nReady> "
        );
    }

    #[test]
    fn handles_max_depth_32768_sample_capture() {
        let mut packets = Vec::new();
        let mut demux = ProtocolDemuxer::new();

        let mut payload = vec![0u8; 8 + 32768];
        payload[0..4].copy_from_slice(&20_000_000u32.to_le_bytes());
        payload[4..6].copy_from_slice(&16384u16.to_le_bytes());
        payload[6..8].copy_from_slice(&0x0001u16.to_le_bytes());
        for i in 0..32768 {
            payload[8 + i] = (i & 0xff) as u8;
        }

        let frame = encode_response_frame(TYPE_LA_CAPTURE_DATA, &payload);
        demux.push(&frame[..512], |p| packets.push(p), |_| {});
        demux.push(&frame[512..16000], |p| packets.push(p), |_| {});
        demux.push(&frame[16000..], |p| packets.push(p), |_| {});

        assert_eq!(packets.len(), 1);
        match &packets[0] {
            DecodedPacket::LaCaptureData(c) => {
                assert_eq!(c.sample_rate_hz, 20_000_000);
                assert_eq!(c.trigger_index, 16384);
                assert_eq!(c.samples.len(), 32768);
                assert_eq!(c.samples[255], 255);
            }
            _ => panic!("expected capture"),
        }
    }

    #[test]
    fn flushes_bad_checksum_to_text_and_recovers_next_frame() {
        let mut packets = Vec::new();
        let mut text_bytes = Vec::new();
        let mut demux = ProtocolDemuxer::new();

        let mut bad_tel = encode_response_frame(TYPE_STATUS_TELEMETRY, &[1, 2, 3, 4]);
        let last = bad_tel.len() - 1;
        bad_tel[last] ^= 0xff;

        let good_tel = encode_response_frame(TYPE_STATUS_TELEMETRY, &[0xff, 0, 0, 0]);

        let mut combined = Vec::new();
        combined.extend_from_slice(&bad_tel);
        combined.push(0xaa);
        combined.extend_from_slice(&good_tel);

        demux.push(&combined, |p| packets.push(p), |b| text_bytes.extend_from_slice(b));

        assert_eq!(packets.len(), 1);
        assert_eq!(
            packets[0],
            DecodedPacket::StatusTelemetry(StatusTelemetry {
                physical_levels: 0xff,
                force_enable_mask: 0,
                forced_levels: 0,
                contention_mask: 0,
            })
        );
        let mut expected_text = bad_tel;
        expected_text.push(0xaa);
        assert_eq!(text_bytes, expected_text);
    }
}
