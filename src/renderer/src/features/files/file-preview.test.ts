import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { FileContent } from '@shared/files'
import type { MediaGrant } from '@shared/media'
import type { OpenFile } from '@renderer/stores/files'

vi.mock('./file-type-icon', () => ({ FileTypeIcon: () => null }))
vi.stubGlobal('window', { overbench: { platform: 'darwin' } })

const { FilePreview } = await import('./file-preview')

const TOKEN = 'abcdefghijklmnopqrstuvwxyz'

function preview(path: string, grant: Omit<MediaGrant, 'url'>): { html: string; url: string } {
  const url = `overbench-media://${TOKEN}/${path.split('/').pop()}?v=1`
  const content: FileContent = { kind: 'media', path, grant: { url, ...grant } }
  const file: OpenFile = {
    path,
    line: null,
    content,
    error: null,
    dirty: false,
    changedOnDisk: false,
    diskVersion: null,
    kept: null,
    saving: false,
    saveError: null,
    resets: 0,
  }
  return {
    html: renderToStaticMarkup(createElement(FilePreview, { projectPath: '/p', file })),
    url,
  }
}

/** The elements that load `url`, without the preload hint React's server rendering adds. */
function loaders(html: string, url: string): string[] {
  return [...html.matchAll(/<([a-z]+)\b[^>]*>/g)]
    .filter((tag) => tag[0].includes(`"${url}"`) && !tag[0].startsWith('<link rel="preload"'))
    .map((tag) => tag[1]!)
}

describe('FilePreview', () => {
  it('shows an SVG as an image from the media scheme, never as a document', () => {
    const { html, url } = preview('art/logo.svg', {
      kind: 'image',
      mimeType: 'image/svg+xml',
      size: 41,
    })
    expect(loaders(html, url)).toEqual(['img'])
    expect(html).toContain('41 byte')
  })

  it('shows a picture with its pixel size, and plays a clip and a sound with controls', () => {
    const picture = preview('shots/wide.png', {
      kind: 'image',
      mimeType: 'image/png',
      size: 2048,
      width: 1920,
      height: 1080,
    })
    expect(loaders(picture.html, picture.url)).toEqual(['img'])
    expect(picture.html).toContain('1920 × 1080 · 2 kB')
    const clip = preview('out/clip.mp4', { kind: 'video', mimeType: 'video/mp4', size: 10 })
    expect(loaders(clip.html, clip.url)).toEqual(['video'])
    expect(clip.html).toMatch(/<video[^>]*\bcontrols=""/)
    const sound = preview('out/beep.mp3', { kind: 'audio', mimeType: 'audio/mpeg', size: 10 })
    expect(loaders(sound.html, sound.url)).toEqual(['audio'])
    expect(sound.html).toMatch(/<audio[^>]*\bcontrols=""/)
  })
})
