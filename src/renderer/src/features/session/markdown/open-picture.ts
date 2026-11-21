import { openViewer } from '@renderer/stores/viewer'

function base64Of(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/**
 * Opens a block's SVG in the media viewer, which draws it as a vector at any zoom and saves it as
 * the SVG. It belongs to no thread, so the viewer holds only this picture.
 */
export function openPicture({
  key,
  xml,
  name,
  alt,
  from,
}: {
  /** The picture's `data-viewer-key`, the place it grows from and returns to. */
  key: string
  xml: string
  name: string | null
  alt: string
  from: HTMLElement
}): void {
  openViewer({
    sessionId: null,
    projectPath: null,
    draft: null,
    item: {
      key,
      source: { kind: 'bytes', media: 'image', mimeType: 'image/svg+xml', data: base64Of(xml) },
      name,
      alt,
    },
    from,
  })
}
