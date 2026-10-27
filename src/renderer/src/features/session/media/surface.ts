import { isSvgFile } from '@renderer/stores/files'

/** The surface an image is drawn on: the white page an SVG is drawn for, or the checkerboard. */
export type ImageSurface = 'canvas' | 'checker'

/**
 * An SVG is usually drawn for a white page, so its dark strokes vanish on the dark theme's
 * checkerboard; every other image keeps the squares that show its transparency.
 */
export function imageSurface({
  path,
  mimeType,
}: {
  path?: string
  mimeType?: string
}): ImageSurface {
  return (path !== undefined && isSvgFile(path)) || mimeType === 'image/svg+xml'
    ? 'canvas'
    : 'checker'
}
