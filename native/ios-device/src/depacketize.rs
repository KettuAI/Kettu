//! Reassembles access units from RTP: H.264 per RFC 6184 (single NAL, STAP-A, FU-A) and HEVC
//! per RFC 7798 (single NAL, AP, FU), in non-interleaved mode.
//!
//! An access unit ends at the RTP marker bit, or at a new timestamp if a marker went missing.
//! The tunnel delivers datagrams in order, so a sequence gap is a loss: the access unit it
//! touches is dropped whole rather than handed to a decoder that would render the hole.

use crate::params::Codec;

/// The fixed footer the display service appends to each coded-slice NAL unit, which Apple's own
/// receiver strips before decoding (as observed by pymobiledevice3).
const DISPLAY_SERVICE_TRAILER: [u8; 14] = [
    0x04, 0xF0, 0x0A, 0xC0, 0x00, 0x00, 0x03, 0x00, 0x00, 0x04, 0xEC, 0x0A, 0xB0, 0x03,
];

#[derive(Debug, PartialEq, Eq)]
pub struct AccessUnit {
    pub nals: Vec<Vec<u8>>,
    pub timestamp: u32,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Assembled {
    Unit(AccessUnit),
    /// An access unit was lost or arrived incomplete.
    Lost,
}

pub struct Depacketizer {
    codec: Codec,
    next_seq: Option<u16>,
    timestamp: Option<u32>,
    nals: Vec<Vec<u8>>,
    fragment: Option<Vec<u8>>,
    corrupt: bool,
}

/// True if `a` comes before `b` in RTP sequence order (RFC 1982 serial arithmetic).
fn seq_before(a: u16, b: u16) -> bool {
    let diff = b.wrapping_sub(a);
    diff != 0 && diff < 0x8000
}

impl Depacketizer {
    pub fn new(codec: Codec) -> Self {
        Self {
            codec,
            next_seq: None,
            timestamp: None,
            nals: Vec::new(),
            fragment: None,
            corrupt: false,
        }
    }

    pub fn codec(&self) -> Codec {
        self.codec
    }

    /// Feeds one RTP packet; returns at most two results, as a timestamp change can close one
    /// access unit before the packet's own marker closes the next.
    pub fn push(
        &mut self,
        seq: u16,
        timestamp: u32,
        marker: bool,
        payload: &[u8],
    ) -> Vec<Assembled> {
        let mut out = Vec::new();
        let mut gap = false;
        if let Some(next) = self.next_seq {
            if seq_before(seq, next) {
                return out;
            }
            gap = seq != next;
        }
        self.next_seq = Some(seq.wrapping_add(1));
        if gap {
            self.fragment = None;
            self.corrupt = true;
        }

        if self.timestamp.is_some_and(|current| current != timestamp) {
            out.extend(self.finish());
            // The lost packets may have opened this access unit as well as closed the last.
            self.corrupt = gap;
        }
        if self.timestamp.is_none() {
            self.timestamp = Some(timestamp);
        }

        match self.codec {
            Codec::H264 => self.push_h264(payload),
            Codec::Hevc => self.push_hevc(payload),
        }

        if marker {
            out.extend(self.finish());
        }
        out
    }

    fn finish(&mut self) -> Option<Assembled> {
        let timestamp = self.timestamp.take()?;
        if self.fragment.take().is_some() {
            self.corrupt = true;
        }
        let nals = std::mem::take(&mut self.nals);
        let corrupt = std::mem::replace(&mut self.corrupt, false);
        if corrupt {
            Some(Assembled::Lost)
        } else if nals.is_empty() {
            None
        } else {
            Some(Assembled::Unit(AccessUnit { nals, timestamp }))
        }
    }

    fn emit(&mut self, nal: &[u8]) {
        if nal.is_empty() {
            return;
        }
        let nal = match self.codec {
            Codec::Hevc if (nal[0] >> 1) & 0x3F <= 31 => {
                nal.strip_suffix(&DISPLAY_SERVICE_TRAILER).unwrap_or(nal)
            }
            _ => nal,
        };
        self.nals.push(nal.to_vec());
    }

    /// A whole NAL unit or aggregation packet arrived while a fragment was open: its end was lost.
    fn close_fragment(&mut self) {
        if self.fragment.take().is_some() {
            self.corrupt = true;
        }
    }

    fn aggregation(&mut self, payload: &[u8], header_len: usize) {
        let mut offset = header_len;
        while offset + 2 <= payload.len() {
            let size = u16::from_be_bytes([payload[offset], payload[offset + 1]]) as usize;
            offset += 2;
            let Some(nal) = payload.get(offset..offset + size) else {
                self.corrupt = true;
                return;
            };
            self.emit(nal);
            offset += size;
        }
    }

    fn fragment_piece(&mut self, start: bool, end: bool, header: &[u8], piece: &[u8]) {
        if start {
            self.close_fragment();
            let mut nal = header.to_vec();
            nal.extend_from_slice(piece);
            self.fragment = Some(nal);
        } else if let Some(nal) = self.fragment.as_mut() {
            nal.extend_from_slice(piece);
        } else {
            self.corrupt = true;
            return;
        }
        if end && let Some(nal) = self.fragment.take() {
            self.emit(&nal);
        }
    }

    fn push_h264(&mut self, payload: &[u8]) {
        let Some(&indicator) = payload.first() else {
            return;
        };
        match indicator & 0x1F {
            1..=23 => {
                self.close_fragment();
                self.emit(payload);
            }
            24 => {
                self.close_fragment();
                self.aggregation(payload, 1);
            }
            28 => {
                let Some(&header) = payload.get(1) else {
                    self.corrupt = true;
                    return;
                };
                let nal_header = [(indicator & 0xE0) | (header & 0x1F)];
                self.fragment_piece(
                    header & 0x80 != 0,
                    header & 0x40 != 0,
                    &nal_header,
                    &payload[2..],
                );
            }
            _ => self.corrupt = true,
        }
    }

    fn push_hevc(&mut self, payload: &[u8]) {
        if payload.len() < 2 {
            return;
        }
        match (payload[0] >> 1) & 0x3F {
            48 => {
                self.close_fragment();
                self.aggregation(payload, 2);
            }
            49 => {
                let Some(&header) = payload.get(2) else {
                    self.corrupt = true;
                    return;
                };
                let nal_header = [(payload[0] & 0x81) | ((header & 0x3F) << 1), payload[1]];
                self.fragment_piece(
                    header & 0x80 != 0,
                    header & 0x40 != 0,
                    &nal_header,
                    &payload[3..],
                );
            }
            50..=63 => self.corrupt = true,
            _ => {
                self.close_fragment();
                self.emit(payload);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(nals: &[&[u8]], timestamp: u32) -> Assembled {
        Assembled::Unit(AccessUnit {
            nals: nals.iter().map(|nal| nal.to_vec()).collect(),
            timestamp,
        })
    }

    #[test]
    fn joins_h264_fragments_and_aggregates() {
        let mut d = Depacketizer::new(Codec::H264);
        assert!(
            d.push(1, 10, false, &[0x18, 0, 2, 0x67, 1, 0, 1, 0x68])
                .is_empty()
        );
        assert!(d.push(2, 10, false, &[0x7C, 0x85, 0xAA]).is_empty());
        assert!(d.push(3, 10, false, &[0x7C, 0x05, 0xBB]).is_empty());
        assert_eq!(
            d.push(4, 10, true, &[0x7C, 0x45, 0xCC]),
            vec![unit(&[&[0x67, 1], &[0x68], &[0x65, 0xAA, 0xBB, 0xCC]], 10)]
        );
    }

    #[test]
    fn joins_hevc_fragments_and_strips_the_trailer() {
        let mut d = Depacketizer::new(Codec::Hevc);
        assert!(d.push(7, 5, false, &[0x62, 0x01, 0x93, 0xAA]).is_empty());
        let mut last = vec![0x62, 0x01, 0x53, 0xBB];
        last.extend_from_slice(&DISPLAY_SERVICE_TRAILER);
        assert_eq!(
            d.push(8, 5, true, &last),
            vec![unit(&[&[0x26, 0x01, 0xAA, 0xBB]], 5)]
        );
    }

    #[test]
    fn drops_an_access_unit_with_a_gap() {
        let mut d = Depacketizer::new(Codec::H264);
        assert!(d.push(1, 10, false, &[0x7C, 0x85, 0xAA]).is_empty());
        assert_eq!(
            d.push(3, 10, true, &[0x7C, 0x45, 0xCC]),
            vec![Assembled::Lost]
        );
        assert_eq!(
            d.push(4, 20, true, &[0x41, 0x9A]),
            vec![unit(&[&[0x41, 0x9A]], 20)]
        );
    }

    #[test]
    fn closes_an_access_unit_on_a_new_timestamp() {
        let mut d = Depacketizer::new(Codec::H264);
        assert!(d.push(65535, 10, false, &[0x41, 1]).is_empty());
        assert_eq!(
            d.push(0, 20, true, &[0x41, 2]),
            vec![unit(&[&[0x41, 1]], 10), unit(&[&[0x41, 2]], 20)]
        );
        assert!(d.push(65535, 30, true, &[0x41, 3]).is_empty());
    }
}
