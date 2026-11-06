import { describe, expect, it } from 'vitest'
import { AnnexBToAvcc, avcCodecString, avcDecoderConfig, splitNalUnits } from './annexb'
import { framePlan } from './frame'
import { encodeFrame, FrameReader, FramingError, MAX_FRAME_BYTES } from './framing'
import {
  clipboardMessage,
  keycodeMessage,
  ScrcpyVideoReader,
  scrollMessage,
  textChunks,
  textMessage,
  touchMessage,
} from './scrcpy'

const SPS = Uint8Array.of(0x67, 0x64, 0x00, 0x33, 0xac, 0x1b)
const PPS = Uint8Array.of(0x68, 0xee, 0x3c, 0x80)
const IDR = Uint8Array.of(0x65, 0x88, 0x84, 0x00)
const SLICE = Uint8Array.of(0x41, 0x9a, 0x02)
const AUD = Uint8Array.of(0x09, 0xf0)

function annexB(...units: Uint8Array[]): Uint8Array {
  const parts = units.flatMap((unit, index) => [
    index % 2 ? Uint8Array.of(0, 0, 1) : Uint8Array.of(0, 0, 0, 1),
    unit,
  ])
  return concat(parts)
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

describe('tagged framing', () => {
  it('reads frames split anywhere across pushes', () => {
    const bytes = concat([
      encodeFrame(1, Uint8Array.of(9, 8)),
      encodeFrame(2, new Uint8Array(0)),
      encodeFrame(3, Uint8Array.of(7)),
    ])
    const reader = new FrameReader()
    const frames = [...bytes].flatMap((byte) => reader.push(Uint8Array.of(byte)))
    expect(frames).toEqual([
      { tag: 1, payload: Uint8Array.of(9, 8) },
      { tag: 2, payload: new Uint8Array(0) },
      { tag: 3, payload: Uint8Array.of(7) },
    ])
  })

  it('refuses a length no stream carries', () => {
    const header = new Uint8Array(4)
    new DataView(header.buffer).setUint32(0, MAX_FRAME_BYTES + 1, false)
    expect(() => new FrameReader().push(header)).toThrow(FramingError)
  })
})

describe('Annex B to avcC', () => {
  it('splits on three and four byte start codes', () => {
    expect(splitNalUnits(annexB(SPS, PPS, IDR))).toEqual([SPS, PPS, IDR])
  })

  it('builds the decoder configuration and codec string from the parameter sets', () => {
    const config = avcDecoderConfig(SPS, PPS)
    expect([...config.subarray(0, 8)]).toEqual([1, 0x64, 0x00, 0x33, 0xff, 0xe1, 0, SPS.length])
    expect(config.subarray(8, 8 + SPS.length)).toEqual(SPS)
    expect(config[8 + SPS.length]).toBe(1)
    expect(config.subarray(11 + SPS.length)).toEqual(PPS)
    expect(avcCodecString(SPS)).toBe('avc1.640033')
  })

  it('announces the description once and length-prefixes the rest', () => {
    const converter = new AnnexBToAvcc()
    const config = converter.push(annexB(SPS, PPS))
    expect(config.description?.codec).toBe('avc1.640033')
    expect(config.data.length).toBe(0)

    const key = converter.push(annexB(AUD, SPS, PPS, IDR))
    expect(key.description).toBeNull()
    expect(key.key).toBe(true)
    expect([...key.data]).toEqual([0, 0, 0, IDR.length, ...IDR])

    const delta = converter.push(annexB(SLICE))
    expect(delta.key).toBe(false)
    expect([...delta.data]).toEqual([0, 0, 0, SLICE.length, ...SLICE])
  })
})

describe('scrcpy video socket', () => {
  function header(flags: number, size: number): Uint8Array {
    const out = new Uint8Array(12)
    out[0] = flags
    new DataView(out.buffer).setUint32(8, size, false)
    return out
  }

  it('reads the dummy byte, device name, codec, session and packets', () => {
    const name = new Uint8Array(64)
    name.set(new TextEncoder().encode('Pixel 9'))
    const session = new Uint8Array(12)
    session[0] = 0x80
    new DataView(session.buffer).setUint32(4, 1080, false)
    new DataView(session.buffer).setUint32(8, 2400, false)
    const codec = Uint8Array.of(0x68, 0x32, 0x36, 0x34)
    const bytes = concat([
      Uint8Array.of(0),
      name,
      codec,
      session,
      header(0x40, 3),
      Uint8Array.of(1, 2, 3),
      header(0x20, 2),
      Uint8Array.of(4, 5),
    ])
    const reader = new ScrcpyVideoReader()
    const events = [
      ...reader.push(bytes.subarray(0, 40)),
      ...reader.push(bytes.subarray(40, 90)),
      ...reader.push(bytes.subarray(90)),
    ]
    expect(events).toEqual([
      { type: 'meta', deviceName: 'Pixel 9' },
      { type: 'codec', codec: 0x68323634 },
      { type: 'session', width: 1080, height: 2400 },
      { type: 'packet', config: true, key: false, data: Uint8Array.of(1, 2, 3) },
      { type: 'packet', config: false, key: true, data: Uint8Array.of(4, 5) },
    ])
  })

  it('reports a stream the device disabled', () => {
    const name = new Uint8Array(64)
    const events = new ScrcpyVideoReader().push(
      concat([Uint8Array.of(0), name, Uint8Array.of(0, 0, 0, 1)]),
    )
    expect(events.at(-1)).toEqual({ type: 'disabled', error: true })
  })
})

describe('scrcpy control messages', () => {
  const point = { x: 540.4, y: 1200, width: 1080, height: 2400 }

  it('serializes a touch', () => {
    const message = touchMessage('down', 0, point)
    const view = new DataView(message.buffer)
    expect(message.length).toBe(32)
    expect([message[0], message[1]]).toEqual([2, 0])
    expect(view.getBigUint64(2, false)).toBe(0n)
    expect([view.getInt32(10, false), view.getInt32(14, false)]).toEqual([540, 1200])
    expect([view.getUint16(18, false), view.getUint16(20, false)]).toEqual([1080, 2400])
    expect(view.getUint16(22, false)).toBe(0xffff)
    expect(new DataView(touchMessage('up', 0, point).buffer).getUint16(22, false)).toBe(0)
  })

  it('serializes keys, text, scrolls and the clipboard', () => {
    expect([...keycodeMessage('up', 3)]).toEqual([0, 1, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0])
    expect([...textMessage('hé')]).toEqual([1, 0, 0, 0, 3, 0x68, 0xc3, 0xa9])
    const scroll = new DataView(scrollMessage(point, 0, -16).buffer)
    expect(scroll.getInt16(15, false)).toBe(-0x8000)
    const clipboard = clipboardMessage(7, '你好', true)
    expect(clipboard[0]).toBe(9)
    expect(new DataView(clipboard.buffer).getBigUint64(1, false)).toBe(7n)
    expect(clipboard[9]).toBe(1)
    expect(new DataView(clipboard.buffer).getUint32(10, false)).toBe(6)
  })

  it('splits text without breaking a character', () => {
    expect(textChunks('你好世界', 7)).toEqual(['你好', '世界'])
    expect(textChunks('', 7)).toEqual([])
  })
})

describe('serve-sim device chrome', () => {
  const button = (name: string, onTop: boolean) => ({
    name,
    image: `${name} BTN`,
    onTop,
    frame: { x: 4, y: 160, width: 16, height: 34 },
  })
  const chrome = {
    identifier: 'phone11',
    frame: { width: 454, height: 908 },
    body: { x: 9, y: 0, width: 436, height: 908 },
    screen: { x: 26, y: 17, width: 402, height: 874 },
    screenRadius: 62,
    screenCornerRadii: { topLeft: 62, topRight: 62, bottomRight: 60, bottomLeft: 60 },
    compositeImage: 'PhoneComposite',
    buttons: [button('crown', true), button('volume', false)],
  }

  it('puts buttons behind the body and those on top after it', () => {
    const plan = framePlan(chrome)
    expect(plan?.radii).toEqual([62, 62, 60, 60])
    expect(plan?.images.map((image) => image.image)).toEqual([
      'volume BTN',
      'PhoneComposite',
      'crown BTN',
    ])
    expect(plan?.images[1]).toMatchObject({ x: 9, y: 0, width: 436, height: 908 })
  })

  it('lays out a nine-slice body around its corners', () => {
    const slice = {
      topLeft: 'TL',
      top: 'Top',
      topRight: 'TR',
      right: 'Right',
      bottomRight: 'BR',
      bottom: 'Base',
      bottomLeft: 'BL',
      left: 'Left',
    }
    const plan = framePlan({
      ...chrome,
      compositeImage: undefined,
      slice,
      corner: { width: 110, height: 110 },
      buttons: [],
    })
    expect(plan?.images).toHaveLength(8)
    expect(plan?.images.find((image) => image.image === 'BR')).toEqual({
      image: 'BR',
      x: 335,
      y: 798,
      width: 110,
      height: 110,
    })
    expect(plan?.images.find((image) => image.image === 'Top')?.width).toBe(216)
  })

  it('refuses a description it cannot draw', () => {
    expect(framePlan(null)).toBeNull()
    expect(framePlan({ ...chrome, frame: { width: Infinity, height: 908 } })).toBeNull()
    expect(framePlan({ ...chrome, compositeImage: '../../etc/passwd' })).toBeNull()
    expect(framePlan({ ...chrome, compositeImage: undefined })).toBeNull()
  })
})
