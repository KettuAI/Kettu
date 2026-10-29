import { describe, expect, it } from 'vitest'
import { isMediaType, mediaKindOfName, mediaUrlToken } from './media'

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
