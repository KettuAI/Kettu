import { describe, expect, it } from 'vitest'
import { checkIcon, iconDataUrl, iconType } from './icon'
import { jpeg, png, webp } from './icon-fixture'

describe('checkIcon', () => {
  it('takes a square PNG, WebP or JPEG of 256 to 1024 px', () => {
    expect(checkIcon(png(256), 'image/png')).toEqual({
      ok: true,
      type: 'image/png',
      width: 256,
      height: 256,
    })
    expect(checkIcon(png(1024), 'image/png').ok).toBe(true)
    expect(checkIcon(jpeg(512), 'image/jpeg')).toMatchObject({ ok: true, width: 512 })
    for (const form of ['lossy', 'lossless', 'extended'] as const) {
      expect(checkIcon(webp(300, 300, form), 'image/webp'), form).toMatchObject({
        ok: true,
        width: 300,
        height: 300,
      })
    }
  })

  it('refuses one too small, too large a side, or not square, saying its size', () => {
    expect(checkIcon(png(128), 'image/png')).toEqual({
      ok: false,
      reason: 'is 128 x 128 px, not between 256 and 1024 px',
    })
    expect(checkIcon(png(2048), 'image/png').ok).toBe(false)
    expect(checkIcon(png(255), 'image/png').ok).toBe(false)
    expect(checkIcon(png(1025), 'image/png').ok).toBe(false)
    expect(checkIcon(webp(400, 300, 'lossless'), 'image/webp')).toEqual({
      ok: false,
      reason: 'is 400 x 300 px, not square',
    })
    expect(checkIcon(jpeg(512, 511), 'image/jpeg').ok).toBe(false)
  })

  it('refuses a file over 512 KB, however good its header', () => {
    const big = Buffer.concat([png(512), Buffer.alloc(512 * 1024)])
    expect(checkIcon(big, 'image/png')).toEqual({
      ok: false,
      reason: 'is 513 KB, over the 512 KB limit',
    })
    expect(checkIcon(Buffer.concat([png(512), Buffer.alloc(1000)]), 'image/png').ok).toBe(true)
  })

  it('tells the type from the bytes, not the name, and never reads SVG', () => {
    expect(checkIcon(jpeg(512), 'image/png')).toEqual({
      ok: false,
      reason: 'is a JPEG image, not PNG',
    })
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')
    expect(checkIcon(svg, 'image/png')).toMatchObject({ ok: false, reason: /SVG/ })
    const marked = Buffer.from('\uFEFF  <?xml version="1.0"?><svg/>')
    expect(checkIcon(marked, 'image/png')).toMatchObject({ ok: false, reason: /SVG/ })
    expect(iconType(svg)).toBeNull()
    expect(checkIcon(Buffer.from('GIF89a'.padEnd(64, '\0')), 'image/png')).toEqual({
      ok: false,
      reason: 'is not a PNG, WebP or JPEG image',
    })
    expect(checkIcon(Buffer.alloc(0), 'image/png')).toEqual({ ok: false, reason: 'is empty' })
  })

  it('refuses a header that gives no size', () => {
    const cut = png(512)
    cut.write('IDAT', 12, 'latin1')
    expect(checkIcon(cut, 'image/png').ok).toBe(false)
    expect(checkIcon(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg').ok).toBe(false)
    expect(checkIcon(png(0), 'image/png').ok).toBe(false)
  })

  it('gives a data URL of the type it checked', () => {
    const bytes = png(256)
    expect(iconDataUrl(bytes, 'image/png')).toBe(
      `data:image/png;base64,${bytes.toString('base64')}`,
    )
  })
})
