// The entry page a canvas document gets where its files leave Kettu: exported, opened in a browser
// or published. A version with its own entry page keeps it.

import { readFile } from 'node:fs/promises'
import { ARTIFACT_ENTRY } from '@shared/artifact-files'
import { CANVAS_FILE, parseCanvasDoc } from '@shared/canvas-doc'
import { canvasOverview } from '@shared/canvas-overview'
import type { ArtifactContentFile } from '@shared/host-control'
import { locale, t } from '../i18n'

/** The overview's HTML for a canvas document without an entry page; null for any other version. */
export async function overviewOf(
  files: readonly ArtifactContentFile[],
  title: string,
): Promise<string | null> {
  if (files.some((file) => file.path === ARTIFACT_ENTRY)) return null
  const doc = files.find((file) => file.path === CANVAS_FILE)
  if (!doc) return null
  return canvasOverview(parseCanvasDoc(await readFile(doc.file, 'utf8')), title, {
    zoomIn: t('canvasOverview.zoomIn'),
    zoomOut: t('canvasOverview.zoomOut'),
    fit: t('canvasOverview.fit'),
    empty: t('canvasOverview.empty'),
    lang: locale(),
  })
}
