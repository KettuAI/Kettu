import { describe, expect, it } from 'vitest'
import { isMediaType, mediaKindOfName, mediaUrlToken, parseRange } from './media'

describe('isMediaType', () => {
  it('takes the image, audio and video types the scheme serves', () => {
    for (const type of ['image/png', 'audio/mpeg', 'audio/mp4', 'video/mp4', 'video/quicktime']) {
      expect(isMediaType(type), type).toBe(true)
    }
    for (const type of ['text/html', 'image/heic', 'application/octet-stream', 42]) {
      expect(isMediaType(type), String(type)).toBe(false)
    }
  })
})

describe('mediaKindOfName', () => {
  it('nominates a file by its extension', () => {
    expect(mediaKindOfName('shot.PNG')).toBe('image')
    expect(mediaKindOfName('demo.mp4')).toBe('video')
    expect(mediaKindOfName('beep.opus')).toBe('audio')
    expect(mediaKindOfName('notes.txt')).toBeNull()
  })
})

describe('mediaUrlToken', () => {
  it('reads the token of a media URL only', () => {
    const token = 'a'.repeat(26)
    expect(mediaUrlToken(`kettu-media://${token}/demo.mp4?v=1`)).toBe(token)
    expect(mediaUrlToken(`https://${token}/demo.mp4`)).toBeNull()
    expect(mediaUrlToken('kettu-media://short/demo.mp4')).toBeNull()
    expect(mediaUrlToken('/tmp/demo.mp4')).toBeNull()
  })
})

describe('parseRange', () => {
  it('reads a range, an open end and a suffix', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 })
    expect(parseRange('bytes=990-2000', 1000)).toEqual({ start: 990, end: 999 })
  })

  it('cannot satisfy a range past the end or an empty suffix', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=1000-1001', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=-1', 0)).toBe('unsatisfiable')
  })

  it('serves the whole file for no range, a malformed one or several', () => {
    expect(parseRange(null, 1000)).toBeNull()
    for (const header of ['bytes=-', 'bytes=5-1', 'items=0-1', 'bytes=a-b', 'bytes=0-1,5-9']) {
      expect(parseRange(header, 1000), header).toBeNull()
    }
  })
})
