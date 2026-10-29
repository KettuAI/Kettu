import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ContentRef } from '@shared/thread'

vi.mock('@renderer/features/files/file-type-icon', () => ({ FileTypeIcon: () => null }))
vi.stubGlobal('window', { kettu: { platform: 'darwin' } })

const { CarriedMedia } = await import('./carried-media')
const { saveCarried } = await import('./carried')

function render(carried: Extract<ContentRef, { kind: 'audio' | 'video' }>): string {
  return renderToStaticMarkup(
    createElement(CarriedMedia, { sessionId: 's1', entryId: 'e1', index: 0, carried }),
  )
}

describe('CarriedMedia', () => {
  it('plays a carried clip from its bytes, named by its resource, saving where a file shows', () => {
    const html = render({
      kind: 'video',
      mimeType: 'video/mp4',
      data: 'AAAA',
      size: 3,
      name: 'my clip.webm',
    })
    expect(html).toMatch(/<video[^>]*\bsrc="data:video\/mp4;base64,AAAA"/)
    expect(html).toMatch(/<video[^>]*\bcontrols=""/)
    expect(html).toContain('>my clip.webm<')
    expect(html).toContain('aria-label="Open larger"')
    expect(html).toContain('aria-label="Save as…"')
    expect(html).not.toContain('Show in')
  })

  it('names a carried sound or clip that has none by its kind', () => {
    const sound = render({
      kind: 'audio',
      mimeType: 'audio/wav',
      data: 'AAAA',
      size: 3,
      name: null,
    })
    expect(sound).toMatch(/<audio[^>]*\bsrc="data:audio\/wav;base64,AAAA"/)
    expect(sound).toMatch(/<audio[^>]*\bcontrols=""/)
    expect(sound).toContain('>Sound<')
    expect(sound).toContain('3 byte')
    const clip = render({ kind: 'video', mimeType: 'video/mp4', data: 'AAAA', size: 3, name: null })
    expect(clip).toContain('>Video<')
  })
})

describe('saveCarried', () => {
  it('saves the bytes themselves, under the name the caption shows', async () => {
    const saveAs = vi.fn(async () => true)
    vi.stubGlobal('window', { kettu: { platform: 'darwin', media: { saveAs } } })
    expect(await saveCarried('audio/wav', 'AAEC/w==', 'Sound')).toBe(true)
    expect(saveAs).toHaveBeenCalledWith({
      bytes: new Uint8Array([0, 1, 2, 255]),
      mimeType: 'audio/wav',
      name: 'Sound',
    })
  })
})
