//! Sequence parameter set parsing and the decoder configuration records (ISO/IEC 14496-15)
//! WebCodecs takes as its `description`.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Codec {
    H264,
    Hevc,
}

/// What the host needs to configure its decoder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Description {
    pub record: Vec<u8>,
    pub codec: String,
    pub width: u32,
    pub height: u32,
}

type Result<T> = std::result::Result<T, String>;

/// The RBSP of a NAL unit: its payload after `header_len` bytes, emulation prevention removed.
fn rbsp(nal: &[u8], header_len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(nal.len());
    let mut zeros = 0;
    for &byte in nal.iter().skip(header_len) {
        if zeros >= 2 && byte == 3 {
            zeros = 0;
            continue;
        }
        zeros = if byte == 0 { zeros + 1 } else { 0 };
        out.push(byte);
    }
    out
}

struct Bits<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Bits<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn bit(&mut self) -> Result<u32> {
        let byte = self
            .data
            .get(self.pos / 8)
            .ok_or("parameter set ends early")?;
        let bit = (byte >> (7 - self.pos % 8)) & 1;
        self.pos += 1;
        Ok(bit as u32)
    }

    fn bits(&mut self, count: u32) -> Result<u32> {
        let mut value = 0;
        for _ in 0..count {
            value = (value << 1) | self.bit()?;
        }
        Ok(value)
    }

    fn skip(&mut self, count: usize) -> Result<()> {
        self.pos += count;
        if self.pos > self.data.len() * 8 {
            return Err("parameter set ends early".into());
        }
        Ok(())
    }

    fn ue(&mut self) -> Result<u32> {
        let mut zeros = 0;
        while self.bit()? == 0 {
            zeros += 1;
            if zeros > 31 {
                return Err("invalid Exp-Golomb code".into());
            }
        }
        Ok(((1u64 << zeros) - 1 + self.bits(zeros)? as u64) as u32)
    }

    fn se(&mut self) -> Result<i32> {
        let value = self.ue()? as i64;
        Ok(if value % 2 == 1 {
            ((value + 1) / 2) as i32
        } else {
            (-(value / 2)) as i32
        })
    }
}

fn push_u16_prefixed(out: &mut Vec<u8>, nal: &[u8]) -> Result<()> {
    let length = u16::try_from(nal.len()).map_err(|_| "parameter set too long")?;
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(nal);
    Ok(())
}

/// Chroma subsampling divisors for a chroma format, as the cropping offsets count in them.
fn chroma_divisors(chroma_format_idc: u32, separate_colour_plane: bool) -> (u32, u32) {
    if separate_colour_plane {
        return (1, 1);
    }
    match chroma_format_idc {
        1 => (2, 2),
        2 => (2, 1),
        _ => (1, 1),
    }
}

struct AvcSps {
    profile_idc: u8,
    constraint_flags: u8,
    level_idc: u8,
    chroma_format_idc: u32,
    bit_depth_luma_minus8: u32,
    bit_depth_chroma_minus8: u32,
    width: u32,
    height: u32,
}

const AVC_HIGH_PROFILES: [u8; 12] = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134];

fn skip_scaling_list(bits: &mut Bits, size: usize) -> Result<()> {
    let mut last = 8i32;
    let mut next = 8i32;
    for _ in 0..size {
        if next != 0 {
            next = (last + bits.se()? + 256) % 256;
        }
        if next != 0 {
            last = next;
        }
    }
    Ok(())
}

fn parse_avc_sps(nal: &[u8]) -> Result<AvcSps> {
    let data = rbsp(nal, 1);
    let mut bits = Bits::new(&data);
    let profile_idc = bits.bits(8)? as u8;
    let constraint_flags = bits.bits(8)? as u8;
    let level_idc = bits.bits(8)? as u8;
    bits.ue()?;
    let mut chroma_format_idc = 1;
    let mut separate_colour_plane = false;
    let mut bit_depth_luma_minus8 = 0;
    let mut bit_depth_chroma_minus8 = 0;
    if AVC_HIGH_PROFILES.contains(&profile_idc) || profile_idc == 135 {
        chroma_format_idc = bits.ue()?;
        if chroma_format_idc == 3 {
            separate_colour_plane = bits.bit()? == 1;
        }
        bit_depth_luma_minus8 = bits.ue()?;
        bit_depth_chroma_minus8 = bits.ue()?;
        bits.skip(1)?;
        if bits.bit()? == 1 {
            let lists = if chroma_format_idc == 3 { 12 } else { 8 };
            for index in 0..lists {
                if bits.bit()? == 1 {
                    skip_scaling_list(&mut bits, if index < 6 { 16 } else { 64 })?;
                }
            }
        }
    }
    bits.ue()?;
    match bits.ue()? {
        0 => {
            bits.ue()?;
        }
        1 => {
            bits.skip(1)?;
            bits.se()?;
            bits.se()?;
            for _ in 0..bits.ue()? {
                bits.se()?;
            }
        }
        _ => {}
    }
    bits.ue()?;
    bits.skip(1)?;
    let width_in_mbs = bits.ue()? + 1;
    let height_in_map_units = bits.ue()? + 1;
    let frame_mbs_only = bits.bit()?;
    if frame_mbs_only == 0 {
        bits.skip(1)?;
    }
    bits.skip(1)?;
    let (mut crop_left, mut crop_right, mut crop_top, mut crop_bottom) = (0, 0, 0, 0);
    if bits.bit()? == 1 {
        crop_left = bits.ue()?;
        crop_right = bits.ue()?;
        crop_top = bits.ue()?;
        crop_bottom = bits.ue()?;
    }
    let chroma_array_type = if separate_colour_plane {
        0
    } else {
        chroma_format_idc
    };
    let (sub_width, sub_height) = chroma_divisors(chroma_format_idc, separate_colour_plane);
    let (crop_unit_x, crop_unit_y) = if chroma_array_type == 0 {
        (1, 2 - frame_mbs_only)
    } else {
        (sub_width, sub_height * (2 - frame_mbs_only))
    };
    let width = (width_in_mbs * 16)
        .checked_sub(crop_unit_x * (crop_left + crop_right))
        .ok_or("cropping exceeds the picture")?;
    let height = ((2 - frame_mbs_only) * height_in_map_units * 16)
        .checked_sub(crop_unit_y * (crop_top + crop_bottom))
        .ok_or("cropping exceeds the picture")?;
    Ok(AvcSps {
        profile_idc,
        constraint_flags,
        level_idc,
        chroma_format_idc,
        bit_depth_luma_minus8,
        bit_depth_chroma_minus8,
        width,
        height,
    })
}

/// An `avcC` record and `avc1.PPCCLL` codec string from one SPS and one PPS.
pub fn avc_description(sps: &[u8], pps: &[u8]) -> Result<Description> {
    let parsed = parse_avc_sps(sps)?;
    let mut record = vec![
        1,
        parsed.profile_idc,
        parsed.constraint_flags,
        parsed.level_idc,
        0xFC | 3,
        0xE0 | 1,
    ];
    push_u16_prefixed(&mut record, sps)?;
    record.push(1);
    push_u16_prefixed(&mut record, pps)?;
    if matches!(parsed.profile_idc, 100 | 110 | 122 | 144) {
        record.push(0xFC | (parsed.chroma_format_idc as u8 & 3));
        record.push(0xF8 | (parsed.bit_depth_luma_minus8 as u8 & 7));
        record.push(0xF8 | (parsed.bit_depth_chroma_minus8 as u8 & 7));
        record.push(0);
    }
    Ok(Description {
        record,
        codec: format!(
            "avc1.{:02X}{:02X}{:02X}",
            parsed.profile_idc, parsed.constraint_flags, parsed.level_idc
        ),
        width: parsed.width,
        height: parsed.height,
    })
}

struct HevcSps {
    /// `general_profile_space` through `general_level_idc`, byte-aligned as hvcC stores them.
    general: [u8; 12],
    max_sub_layers: u32,
    temporal_id_nesting: u32,
    chroma_format_idc: u32,
    bit_depth_luma_minus8: u32,
    bit_depth_chroma_minus8: u32,
    width: u32,
    height: u32,
}

fn parse_hevc_sps(nal: &[u8]) -> Result<HevcSps> {
    let data = rbsp(nal, 2);
    let mut bits = Bits::new(&data);
    bits.skip(4)?;
    let max_sub_layers_minus1 = bits.bits(3)?;
    let temporal_id_nesting = bits.bit()?;
    let general: [u8; 12] = data
        .get(1..13)
        .ok_or("parameter set ends early")?
        .try_into()
        .map_err(|_| "parameter set ends early")?;
    bits.skip(96)?;
    let mut profile_present = [false; 8];
    let mut level_present = [false; 8];
    for index in 0..max_sub_layers_minus1 as usize {
        profile_present[index] = bits.bit()? == 1;
        level_present[index] = bits.bit()? == 1;
    }
    if max_sub_layers_minus1 > 0 {
        bits.skip(2 * (8 - max_sub_layers_minus1 as usize))?;
    }
    for index in 0..max_sub_layers_minus1 as usize {
        if profile_present[index] {
            bits.skip(88)?;
        }
        if level_present[index] {
            bits.skip(8)?;
        }
    }
    bits.ue()?;
    let chroma_format_idc = bits.ue()?;
    let mut separate_colour_plane = false;
    if chroma_format_idc == 3 {
        separate_colour_plane = bits.bit()? == 1;
    }
    let mut width = bits.ue()?;
    let mut height = bits.ue()?;
    if bits.bit()? == 1 {
        let (sub_width, sub_height) = chroma_divisors(chroma_format_idc, separate_colour_plane);
        let left = bits.ue()?;
        let right = bits.ue()?;
        let top = bits.ue()?;
        let bottom = bits.ue()?;
        width = width
            .checked_sub(sub_width * (left + right))
            .ok_or("cropping exceeds the picture")?;
        height = height
            .checked_sub(sub_height * (top + bottom))
            .ok_or("cropping exceeds the picture")?;
    }
    let bit_depth_luma_minus8 = bits.ue()?;
    let bit_depth_chroma_minus8 = bits.ue()?;
    Ok(HevcSps {
        general,
        max_sub_layers: max_sub_layers_minus1 + 1,
        temporal_id_nesting,
        chroma_format_idc,
        bit_depth_luma_minus8,
        bit_depth_chroma_minus8,
        width,
        height,
    })
}

/// The `hvc1` codec string (ISO/IEC 14496-15 annex E) from the general profile, tier and level.
fn hevc_codec_string(general: &[u8; 12]) -> String {
    let space = match general[0] >> 6 {
        1 => "A",
        2 => "B",
        3 => "C",
        _ => "",
    };
    let tier = if general[0] & 0x20 != 0 { "H" } else { "L" };
    let profile = general[0] & 0x1F;
    let compatibility = u32::from_be_bytes([general[1], general[2], general[3], general[4]]);
    let constraints = &general[5..11];
    let kept = constraints
        .iter()
        .rposition(|&byte| byte != 0)
        .map_or(1, |last| last + 1);
    let constraints: Vec<String> = constraints[..kept]
        .iter()
        .map(|byte| format!("{byte:X}"))
        .collect();
    format!(
        "hvc1.{space}{profile}.{:X}.{tier}{}.{}",
        compatibility.reverse_bits(),
        general[11],
        constraints.join(".")
    )
}

/// An `hvcC` record and `hvc1` codec string from one VPS, SPS and PPS.
pub fn hevc_description(vps: &[u8], sps: &[u8], pps: &[u8]) -> Result<Description> {
    let parsed = parse_hevc_sps(sps)?;
    let mut record = Vec::with_capacity(64 + vps.len() + sps.len() + pps.len());
    record.push(1);
    record.extend_from_slice(&parsed.general);
    record.extend_from_slice(&[0xF0, 0x00]);
    record.push(0xFC);
    record.push(0xFC | (parsed.chroma_format_idc as u8 & 3));
    record.push(0xF8 | (parsed.bit_depth_luma_minus8 as u8 & 7));
    record.push(0xF8 | (parsed.bit_depth_chroma_minus8 as u8 & 7));
    record.extend_from_slice(&[0, 0]);
    record.push(
        ((parsed.max_sub_layers as u8 & 7) << 3) | ((parsed.temporal_id_nesting as u8) << 2) | 3,
    );
    record.push(3);
    for (nal_type, nal) in [(32u8, vps), (33, sps), (34, pps)] {
        // array_completeness: the parameter sets are never repeated in band.
        record.push(0x80 | nal_type);
        record.extend_from_slice(&1u16.to_be_bytes());
        push_u16_prefixed(&mut record, nal)?;
    }
    Ok(Description {
        record,
        codec: hevc_codec_string(&parsed.general),
        width: parsed.width,
        height: parsed.height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // From ffmpeg's h264_videotoolbox at 1178x2556, High profile level 5.
    const AVC_SPS: [u8; 12] = [
        0x27, 0x64, 0x00, 0x32, 0xAC, 0x56, 0x80, 0x4A, 0x01, 0x41, 0xE4, 0xB4,
    ];
    const AVC_PPS: [u8; 4] = [0x28, 0xEE, 0x3C, 0xB0];

    #[test]
    fn reads_an_avc_sps() {
        let description = avc_description(&AVC_SPS, &AVC_PPS).unwrap();
        assert_eq!(description.codec, "avc1.640032");
        assert_eq!((description.width, description.height), (1178, 2556));
        assert_eq!(
            &description.record[..8],
            &[1, 0x64, 0x00, 0x32, 0xFF, 0xE1, 0x00, 12]
        );
        assert_eq!(
            &description.record[description.record.len() - 4..],
            &[0xFD, 0xF8, 0xF8, 0]
        );
    }

    // From ffmpeg's hevc_videotoolbox at 1178x2556, Main profile level 5; coded as 1184x2560.
    const HEVC_VPS: [u8; 24] = [
        0x40, 0x01, 0x0C, 0x01, 0xFF, 0xFF, 0x01, 0x60, 0x00, 0x00, 0x03, 0x00, 0xB0, 0x00, 0x00,
        0x03, 0x00, 0x00, 0x03, 0x00, 0x96, 0x17, 0x02, 0x40,
    ];
    const HEVC_SPS: [u8; 43] = [
        0x42, 0x01, 0x01, 0x01, 0x60, 0x00, 0x00, 0x03, 0x00, 0xB0, 0x00, 0x00, 0x03, 0x00, 0x00,
        0x03, 0x00, 0x96, 0xA0, 0x02, 0x50, 0x80, 0x0A, 0x01, 0xC9, 0x78, 0x81, 0x7B, 0x91, 0x64,
        0x52, 0xFF, 0xCB, 0x9F, 0xC4, 0xFE, 0xB0, 0x16, 0xA0, 0x40, 0x40, 0x40, 0x10,
    ];
    const HEVC_PPS: [u8; 7] = [0x44, 0x01, 0xC0, 0x72, 0xF0, 0x53, 0x24];

    #[test]
    fn reads_an_hevc_sps() {
        let description = hevc_description(&HEVC_VPS, &HEVC_SPS, &HEVC_PPS).unwrap();
        assert_eq!(description.codec, "hvc1.1.6.L150.B0");
        assert_eq!((description.width, description.height), (1178, 2556));
        assert_eq!(&description.record[..2], &[1, 0x01]);
        assert_eq!(description.record[12], 150);
        assert_eq!(description.record[22], 3);
        assert_eq!(&description.record[23..26], &[0xA0, 0, 1]);
    }

    #[test]
    fn removes_emulation_prevention() {
        assert_eq!(
            rbsp(&[0x67, 0x00, 0x00, 0x03, 0x01], 1),
            vec![0x00, 0x00, 0x01]
        );
    }
}
