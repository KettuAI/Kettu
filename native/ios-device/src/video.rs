//! Turns the device's RTP into framed access units and keeps its encoder fed with RTCP.

use std::time::{Duration, Instant};

use idevice::core_device::{
    ReportBlock, RtpPacket, build_keyframe_request, build_receiver_report, build_sdes, is_rtcp,
};
use idevice::tcp::handle::UdpSocketHandle;
use serde_json::json;
use tokio::sync::{mpsc::UnboundedReceiver, watch};

use crate::depacketize::{AccessUnit, Assembled, Depacketizer};
use crate::error::HelperError;
use crate::framing::{Output, TAG_DELTA, TAG_DESCRIPTION, TAG_KEYFRAME, TAG_SCREEN};
use crate::params::{Codec, Description, avc_description, hevc_description};
use crate::session::StreamConfig;

/// The RTP payload types the screen offer declares for each codec.
const PAYLOAD_H264: u8 = 123;
const PAYLOAD_HEVC: u8 = 100;

/// The device stops a stream that hears no receiver report for about 20 seconds.
const REPORT_INTERVAL: Duration = Duration::from_secs(1);
/// Keyframe requests are spaced out: a burst of them stalls this encoder.
const MIN_KEYFRAME_INTERVAL: Duration = Duration::from_millis(700);
const KEYFRAME_RETRY: Duration = Duration::from_millis(1500);
const FIRST_VIDEO_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Orientation {
    Portrait,
    PortraitUpsideDown,
    LandscapeLeft,
    LandscapeRight,
}

impl Orientation {
    fn as_str(self) -> &'static str {
        match self {
            Orientation::Portrait => "portrait",
            Orientation::PortraitUpsideDown => "portrait_upside_down",
            Orientation::LandscapeLeft => "landscape_left",
            Orientation::LandscapeRight => "landscape_right",
        }
    }
}

/// The interface orientation SpringBoard reports, made to agree with the frame's shape, which
/// wins when the two disagree or SpringBoard cannot be asked.
fn screen_orientation(width: u32, height: u32, reported: Option<Orientation>) -> Orientation {
    let landscape = width > height;
    match reported {
        Some(o @ (Orientation::LandscapeLeft | Orientation::LandscapeRight)) if landscape => o,
        Some(Orientation::PortraitUpsideDown) if !landscape => Orientation::PortraitUpsideDown,
        _ if landscape => Orientation::LandscapeLeft,
        _ => Orientation::Portrait,
    }
}

enum NalKind {
    ParameterSet(usize),
    Delimiter,
    Picture { key: bool },
    Other,
}

fn classify(codec: Codec, nal: &[u8]) -> NalKind {
    match codec {
        Codec::H264 => match nal[0] & 0x1F {
            7 => NalKind::ParameterSet(1),
            8 => NalKind::ParameterSet(2),
            9 => NalKind::Delimiter,
            kind @ 1..=5 => NalKind::Picture { key: kind == 5 },
            _ => NalKind::Other,
        },
        Codec::Hevc => match (nal[0] >> 1) & 0x3F {
            32 => NalKind::ParameterSet(0),
            33 => NalKind::ParameterSet(1),
            34 => NalKind::ParameterSet(2),
            35 => NalKind::Delimiter,
            kind @ 0..=31 => NalKind::Picture {
                key: (16..=23).contains(&kind),
            },
            _ => NalKind::Other,
        },
    }
}

struct Screen {
    width: u32,
    height: u32,
    codec: String,
    orientation: Orientation,
}

struct VideoState {
    out: Output,
    depacketizer: Option<Depacketizer>,
    /// VPS, SPS and PPS; H.264 uses the last two.
    parameter_sets: [Option<Vec<u8>>; 3],
    parameters_changed: bool,
    description: Option<Vec<u8>>,
    screen: Option<Screen>,
    reported_orientation: Option<Orientation>,
    need_keyframe: bool,
    last_keyframe_request: Option<Instant>,
    our_ssrc: u32,
    device_ssrc: Option<u32>,
    rtcp_port: Option<u16>,
    highest_seq: Option<u32>,
    fir_seq: u8,
    rtcp: Vec<Vec<u8>>,
    frames: u64,
    lost: u64,
}

impl VideoState {
    fn new(out: Output, config: StreamConfig) -> Self {
        Self {
            out,
            depacketizer: None,
            parameter_sets: [None, None, None],
            parameters_changed: false,
            description: None,
            screen: None,
            reported_orientation: None,
            need_keyframe: true,
            last_keyframe_request: None,
            our_ssrc: config.our_ssrc.unwrap_or(0),
            device_ssrc: config.device_ssrc,
            rtcp_port: config.source_port,
            highest_seq: None,
            fir_seq: 0,
            rtcp: Vec::new(),
            frames: 0,
            lost: 0,
        }
    }

    fn track_seq(&mut self, seq: u16) {
        self.highest_seq = Some(match self.highest_seq {
            None => seq as u32,
            Some(highest) => {
                let last = highest as u16;
                let ahead = seq.wrapping_sub(last);
                if ahead == 0 || ahead >= 0x8000 {
                    highest
                } else {
                    let cycles = if seq < last {
                        (highest & 0xFFFF_0000).wrapping_add(0x1_0000)
                    } else {
                        highest & 0xFFFF_0000
                    };
                    cycles | seq as u32
                }
            }
        });
    }

    fn report_blocks(&self) -> Vec<ReportBlock> {
        match (self.device_ssrc, self.highest_seq) {
            (Some(source_ssrc), Some(highest_seq)) => vec![ReportBlock {
                source_ssrc,
                highest_seq,
                ..Default::default()
            }],
            _ => Vec::new(),
        }
    }

    fn handle_datagram(&mut self, data: &[u8], source_port: u16) -> Result<(), HelperError> {
        if is_rtcp(data) {
            return Ok(());
        }
        let Some(packet) = RtpPacket::parse(data) else {
            return Ok(());
        };
        if self.highest_seq.is_none() {
            eprintln!(
                "first video packet: payload type {}, ssrc {:#x}, from port {source_port}",
                packet.payload_type, packet.ssrc
            );
        }
        self.device_ssrc = Some(packet.ssrc);
        self.rtcp_port.get_or_insert(source_port);
        self.track_seq(packet.sequence_number);
        let depacketizer = self.depacketizer.get_or_insert_with(|| {
            let codec = match packet.payload_type {
                PAYLOAD_H264 => Codec::H264,
                PAYLOAD_HEVC => Codec::Hevc,
                other => {
                    eprintln!("unknown video payload type {other}; reading it as HEVC");
                    Codec::Hevc
                }
            };
            Depacketizer::new(codec)
        });
        let codec = depacketizer.codec();
        let assembled = depacketizer.push(
            packet.sequence_number,
            packet.timestamp,
            packet.marker,
            packet.payload,
        );
        for result in assembled {
            match result {
                Assembled::Unit(unit) => self.handle_unit(codec, unit)?,
                Assembled::Lost => {
                    self.lost += 1;
                    eprintln!("dropped an incomplete access unit ({} so far)", self.lost);
                    self.need_keyframe = true;
                    self.request_keyframe(Instant::now());
                }
            }
        }
        Ok(())
    }

    fn handle_unit(&mut self, codec: Codec, unit: AccessUnit) -> Result<(), HelperError> {
        let mut key = false;
        let mut picture = false;
        let mut payload = Vec::new();
        for nal in unit.nals {
            match classify(codec, &nal) {
                NalKind::ParameterSet(slot) => {
                    if self.parameter_sets[slot].as_ref() != Some(&nal) {
                        self.parameter_sets[slot] = Some(nal);
                        self.parameters_changed = true;
                    }
                }
                NalKind::Delimiter => {}
                kind => {
                    if let NalKind::Picture { key: is_key } = kind {
                        picture = true;
                        key |= is_key;
                    }
                    payload.extend_from_slice(&(nal.len() as u32).to_be_bytes());
                    payload.extend_from_slice(&nal);
                }
            }
        }
        if self.parameters_changed {
            self.update_description(codec)?;
        }
        if !picture {
            return Ok(());
        }
        let now = Instant::now();
        if self.need_keyframe && (!key || self.description.is_none()) {
            self.request_keyframe(now);
            return Ok(());
        }
        let tag = if key { TAG_KEYFRAME } else { TAG_DELTA };
        if self.out.media(tag, &payload) {
            self.frames += 1;
            if key {
                self.need_keyframe = false;
            }
        } else {
            // The deltas that follow reference this one, so nothing decodes until a keyframe.
            self.need_keyframe = true;
            self.request_keyframe(now);
        }
        Ok(())
    }

    fn update_description(&mut self, codec: Codec) -> Result<(), HelperError> {
        let [vps, sps, pps] = &self.parameter_sets;
        let description: Result<Description, String> = match (codec, vps, sps, pps) {
            (Codec::H264, _, Some(sps), Some(pps)) => avc_description(sps, pps),
            (Codec::Hevc, Some(vps), Some(sps), Some(pps)) => hevc_description(vps, sps, pps),
            _ => return Ok(()),
        };
        self.parameters_changed = false;
        let description = description
            .map_err(|error| HelperError::stream(format!("unreadable parameter sets: {error}")))?;
        if self.description.as_ref() == Some(&description.record) {
            return Ok(());
        }
        let resized = self.screen.as_ref().is_none_or(|screen| {
            (screen.width, screen.height, screen.codec.as_str())
                != (
                    description.width,
                    description.height,
                    description.codec.as_str(),
                )
        });
        if resized {
            eprintln!(
                "video: {} {}x{}",
                description.codec, description.width, description.height
            );
            self.screen = Some(Screen {
                width: description.width,
                height: description.height,
                codec: description.codec,
                orientation: screen_orientation(
                    description.width,
                    description.height,
                    self.reported_orientation,
                ),
            });
            self.send_screen();
        }
        self.out.control(TAG_DESCRIPTION, &description.record);
        self.description = Some(description.record);
        self.need_keyframe = true;
        Ok(())
    }

    fn send_screen(&self) {
        if let Some(screen) = &self.screen {
            self.out.json(
                TAG_SCREEN,
                &json!({
                    "type": "screen",
                    "width": screen.width,
                    "height": screen.height,
                    "codec": screen.codec,
                    "orientation": screen.orientation.as_str(),
                }),
            );
        }
    }

    fn set_orientation(&mut self, reported: Option<Orientation>) {
        self.reported_orientation = reported;
        let Some(screen) = self.screen.as_mut() else {
            return;
        };
        let orientation = screen_orientation(screen.width, screen.height, reported);
        if orientation != screen.orientation {
            screen.orientation = orientation;
            self.send_screen();
        }
    }

    /// Queues RR, SDES, PLI and FIR: the encoder is known to honor FIR, and PLI costs nothing.
    fn request_keyframe(&mut self, now: Instant) {
        let (Some(device_ssrc), Some(_)) = (self.device_ssrc, self.rtcp_port) else {
            return;
        };
        if self
            .last_keyframe_request
            .is_some_and(|last| now.duration_since(last) < MIN_KEYFRAME_INTERVAL)
        {
            return;
        }
        self.last_keyframe_request = Some(now);
        let blocks = self.report_blocks();
        self.rtcp.push(build_keyframe_request(
            self.our_ssrc,
            "",
            device_ssrc,
            &blocks,
            self.fir_seq,
        ));
        self.fir_seq = self.fir_seq.wrapping_add(1);
    }

    fn tick(&mut self, now: Instant) {
        if self.highest_seq.is_none() {
            return;
        }
        let mut report = build_receiver_report(self.our_ssrc, &self.report_blocks());
        report.extend_from_slice(&build_sdes(self.our_ssrc, ""));
        self.rtcp.push(report);
        if self.need_keyframe
            && self
                .last_keyframe_request
                .is_none_or(|last| now.duration_since(last) >= KEYFRAME_RETRY)
        {
            self.request_keyframe(now);
        }
    }

    async fn flush_rtcp(&mut self, udp: &UdpSocketHandle) -> Result<(), HelperError> {
        let Some(port) = self.rtcp_port else {
            self.rtcp.clear();
            return Ok(());
        };
        for packet in self.rtcp.drain(..) {
            udp.send_to(port, packet)
                .await
                .map_err(|error| HelperError::tunnel(format!("the tunnel closed: {error}")))?;
        }
        Ok(())
    }
}

pub async fn run(
    udp: &UdpSocketHandle,
    config: StreamConfig,
    out: &Output,
    keyframes: &mut UnboundedReceiver<()>,
    orientation: &mut watch::Receiver<Option<Orientation>>,
) -> Result<(), HelperError> {
    let mut state = VideoState::new(out.clone(), config);
    let started = Instant::now();
    let mut ticks = tokio::time::interval(REPORT_INTERVAL);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut keyframes_open = true;
    let mut orientation_open = true;
    loop {
        tokio::select! {
            datagram = udp.recv() => {
                let datagram = datagram.map_err(|error| {
                    HelperError::tunnel(format!("the connection to the device was lost: {error}"))
                })?;
                state.handle_datagram(&datagram.data, datagram.source_port)?;
            }
            _ = ticks.tick() => {
                let now = Instant::now();
                if state.highest_seq.is_none() && now.duration_since(started) > FIRST_VIDEO_TIMEOUT {
                    return Err(HelperError::stream(
                        "the device sent no video; unlock it and try again",
                    ));
                }
                state.tick(now);
            }
            request = keyframes.recv(), if keyframes_open => match request {
                Some(()) => {
                    state.need_keyframe = true;
                    state.request_keyframe(Instant::now());
                }
                None => keyframes_open = false,
            },
            changed = orientation.changed(), if orientation_open => match changed {
                Ok(()) => {
                    let reported = *orientation.borrow_and_update();
                    state.set_orientation(reported);
                }
                Err(_) => orientation_open = false,
            },
        }
        state.flush_rtcp(udp).await?;
    }
}

/// Reads and discards the audio the session needs, answering it with receiver reports so the
/// device keeps the screen-sharing session alive.
pub async fn keep_audio(udp: &UdpSocketHandle, config: StreamConfig) -> Result<(), HelperError> {
    let our_ssrc = config
        .our_ssrc
        .unwrap_or_else(|| uuid::Uuid::new_v4().as_u128() as u32);
    let mut device_ssrc = config.device_ssrc;
    let mut port = config.source_port;
    let mut highest: Option<u16> = None;
    let mut ticks = tokio::time::interval(REPORT_INTERVAL);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            datagram = udp.recv() => {
                let datagram = datagram.map_err(|error| {
                    HelperError::tunnel(format!("the connection to the device was lost: {error}"))
                })?;
                if is_rtcp(&datagram.data) {
                    continue;
                }
                if let Some(packet) = RtpPacket::parse(&datagram.data) {
                    device_ssrc = Some(packet.ssrc);
                    port.get_or_insert(datagram.source_port);
                    let ahead = highest.map(|h| packet.sequence_number.wrapping_sub(h));
                    if ahead.is_none_or(|ahead| ahead != 0 && ahead < 0x8000) {
                        highest = Some(packet.sequence_number);
                    }
                }
            }
            _ = ticks.tick() => {
                let (Some(port), Some(source_ssrc), Some(highest)) = (port, device_ssrc, highest) else {
                    continue;
                };
                let block = ReportBlock { source_ssrc, highest_seq: highest as u32, ..Default::default() };
                let mut report = build_receiver_report(our_ssrc, &[block]);
                report.extend_from_slice(&build_sdes(our_ssrc, ""));
                udp.send_to(port, report)
                    .await
                    .map_err(|error| HelperError::tunnel(format!("the tunnel closed: {error}")))?;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orientation_follows_the_frame() {
        assert_eq!(screen_orientation(1179, 2556, None), Orientation::Portrait);
        assert_eq!(
            screen_orientation(2556, 1179, None),
            Orientation::LandscapeLeft
        );
        assert_eq!(
            screen_orientation(2556, 1179, Some(Orientation::LandscapeRight)),
            Orientation::LandscapeRight
        );
        assert_eq!(
            screen_orientation(1179, 2556, Some(Orientation::LandscapeRight)),
            Orientation::Portrait
        );
        assert_eq!(
            screen_orientation(1179, 2556, Some(Orientation::PortraitUpsideDown)),
            Orientation::PortraitUpsideDown
        );
    }
}
