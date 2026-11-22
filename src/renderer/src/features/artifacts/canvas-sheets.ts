import type { CanvasDoc } from '@shared/canvas-doc'
import type { PlacedPage } from './canvas'
import type { PresentSheet } from './present-stage'

/** A presented frame: a canvas document's, by its id, or a canvas of one file's, by its place. */
export interface FrameSheet extends PresentSheet {
  file: string | null
  /** Its place in the canvas of one file. */
  page: { group: number; index: number } | null
}

/**
 * What a canvas presents: a document's frames page by page, in each page's order, or the pages
 * of a canvas of one file, as one group.
 */
export function canvasSheets(
  doc: CanvasDoc | null,
  legacy: readonly PlacedPage[] | null,
  legacyName: (index: number) => string,
  title: string,
): FrameSheet[] {
  if (doc) {
    return doc.canvases.flatMap((canvas, i) =>
      doc.pages
        .filter((p) => p.canvas === canvas.id)
        .map((p) => ({
          key: p.id,
          width: p.width,
          height: p.height,
          name: p.name,
          group: canvas.id,
          groupName: `${i + 1} ${canvas.name}`,
          file: p.file,
          page: null,
        })),
    )
  }
  return (legacy ?? []).map((p, i) => ({
    key: String(i),
    width: p.width,
    height: p.height,
    name: legacyName(i),
    group: '',
    groupName: title,
    file: p.file ?? null,
    page: { group: p.group, index: p.index },
  }))
}
