use hotwire_core::protocol::{FrameDemuxer, FrameRule};

use crate::protocol::codec::decode_response_payload;
use crate::protocol::types::{
    DecodedPacket, MAX_FRAME_PAYLOAD_LEN, TYPE_LA_CAPTURE_DATA, TYPE_STATUS_TELEMETRY,
};

pub struct ProtocolDemuxer {
    inner: FrameDemuxer,
}

impl Default for ProtocolDemuxer {
    fn default() -> Self {
        Self::new()
    }
}

impl ProtocolDemuxer {
    pub fn new() -> Self {
        Self {
            inner: FrameDemuxer::new(vec![
                FrameRule::board_capabilities(),
                FrameRule::new(TYPE_STATUS_TELEMETRY, 4, 4),
                FrameRule::new(TYPE_LA_CAPTURE_DATA, 8, MAX_FRAME_PAYLOAD_LEN),
            ]),
        }
    }

    pub fn reset(&mut self) {
        self.inner.reset();
    }

    pub fn push<FP, FT>(&mut self, chunk: &[u8], mut on_packet: FP, on_text: FT)
    where
        FP: FnMut(DecodedPacket),
        FT: FnMut(&[u8]),
    {
        self.inner.feed_with_text(
            chunk,
            |raw| {
                if let Some(pkt) = decode_response_payload(raw.type_id, raw.payload) {
                    on_packet(pkt);
                }
            },
            on_text,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::codec::encode_response_frame;
    use crate::protocol::types::{StatusTelemetry, TYPE_BOARD_CAPABILITIES};

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
            DecodedPacket::BoardCapabilities(_, c) => assert_eq!(c.board, "XIAO-ESP32-S3"),
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
