// H.264 from Annex B (start codes, parameter sets in band), as scrcpy's server writes it, to the
// layout a WebCodecs decoder takes: an avcC description and access units of length-prefixed NAL
// units (ISO/IEC 14496-15).

const NAL_SPS = 7
const NAL_PPS = 8
const NAL_AUD = 9
const NAL_IDR = 5

/** The NAL units between the start codes, without them. */
export function splitNalUnits(data: Uint8Array): Uint8Array[] {
  const starts: { at: number; size: number }[] = []
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0) continue
    if (data[i + 2] === 1) {
      starts.push({ at: i, size: 3 })
      i += 2
    } else if (data[i + 2] === 0 && i + 3 < data.length && data[i + 3] === 1) {
      starts.push({ at: i, size: 4 })
      i += 3
    }
  }
  const units: Uint8Array[] = []
  for (let n = 0; n < starts.length; n++) {
    const begin = starts[n]!.at + starts[n]!.size
    const end = n + 1 < starts.length ? starts[n + 1]!.at : data.length
    if (end > begin) units.push(data.subarray(begin, end))
  }
  return units
}

export function nalType(unit: Uint8Array): number {
  return unit[0]! & 0x1f
}

/** The `avc1.PPCCLL` codec string from a sequence parameter set. */
export function avcCodecString(sps: Uint8Array): string {
  const hex = (byte: number): string => byte.toString(16).padStart(2, '0')
  if (sps.length < 4) return 'avc1.42e01e'
  return `avc1.${hex(sps[1]!)}${hex(sps[2]!)}${hex(sps[3]!)}`
}

/** An AVCDecoderConfigurationRecord holding one SPS and one PPS. */
export function avcDecoderConfig(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const out = new Uint8Array(11 + sps.length + pps.length)
  const view = new DataView(out.buffer)
  out[0] = 1
  out[1] = sps[1] ?? 0
  out[2] = sps[2] ?? 0
  out[3] = sps[3] ?? 0
  out[4] = 0xff // 4-byte NAL lengths
  out[5] = 0xe1 // one SPS
  view.setUint16(6, sps.length, false)
  out.set(sps, 8)
  out[8 + sps.length] = 1 // one PPS
  view.setUint16(9 + sps.length, pps.length, false)
  out.set(pps, 11 + sps.length)
  return out
}

export interface AvccUnit {
  /** Set when the parameter sets changed, before this unit. */
  description: { config: Uint8Array; codec: string } | null
  /** Length-prefixed NAL units, without parameter sets and delimiters; empty for a config-only input. */
  data: Uint8Array
  key: boolean
}

/** Turns successive Annex B packets of one stream into avcC descriptions and access units. */
export class AnnexBToAvcc {
  private sps: Uint8Array | null = null
  private pps: Uint8Array | null = null
  private announced: string | null = null

  push(packet: Uint8Array): AvccUnit {
    const kept: Uint8Array[] = []
    let key = false
    for (const unit of splitNalUnits(packet)) {
      const type = nalType(unit)
      if (type === NAL_SPS) this.sps = unit.slice()
      else if (type === NAL_PPS) this.pps = unit.slice()
      else if (type !== NAL_AUD) {
        if (type === NAL_IDR) key = true
        kept.push(unit)
      }
    }
    let description: AvccUnit['description'] = null
    if (this.sps && this.pps) {
      const config = avcDecoderConfig(this.sps, this.pps)
      const signature = Buffer.from(config).toString('base64')
      if (signature !== this.announced) {
        this.announced = signature
        description = { config, codec: avcCodecString(this.sps) }
      }
    }
    return { description, data: lengthPrefixed(kept), key }
  }

  reset(): void {
    this.sps = null
    this.pps = null
    this.announced = null
  }
}

function lengthPrefixed(units: Uint8Array[]): Uint8Array {
  const size = units.reduce((sum, unit) => sum + 4 + unit.length, 0)
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  let offset = 0
  for (const unit of units) {
    view.setUint32(offset, unit.length, false)
    out.set(unit, offset + 4)
    offset += 4 + unit.length
  }
  return out
}
