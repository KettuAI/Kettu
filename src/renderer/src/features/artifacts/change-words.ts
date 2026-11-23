// What changed between two versions, in the words every place that says it uses: the card's chip
// and the viewer's change pill read "4 frames changed", "2 files changed", "3 passages changed".

import type { ArtifactChanges } from '@shared/artifact-changes'
import { i18n } from '@renderer/lib/i18n'

export type ChangeUnit = 'frames' | 'files' | 'passages' | 'slides'

/** How many of what changed: a document counts its passages, or its sections when none is left. */
export function changeCount(changes: ArtifactChanges): { unit: ChangeUnit; count: number } {
  switch (changes.kind) {
    case 'frames':
      return { unit: 'frames', count: changes.frames.length }
    case 'files':
      return { unit: 'files', count: changes.paths.length }
    case 'slides':
      return { unit: 'slides', count: changes.slides.length }
    case 'sections':
      return {
        unit: 'passages',
        count: changes.passages.length || changes.sections.length,
      }
  }
}

/** "4 frames changed". */
export function changesLabel(changes: ArtifactChanges): string {
  const { unit, count } = changeCount(changes)
  return i18n.t(`artifacts:changes.${unit}`, { count })
}

/** What changed, by name: the frames, the files, the slides or the sections. */
export function changeNames(changes: ArtifactChanges): string[] {
  switch (changes.kind) {
    case 'frames':
      return changes.frames.map((f) => f.name)
    case 'files':
      return changes.paths
    case 'slides':
      return changes.slides.map(
        (s) => s.title ?? i18n.t('session:artifactEntry.changes.slide', { number: s.number }),
      )
    case 'sections':
      return changes.headings.map((h) => h ?? i18n.t('session:artifactEntry.changes.start'))
  }
}

/** "4 frames changed · Home, Search": the count, then the first names. */
export function changeLine(changes: ArtifactChanges): string {
  const shown = changeNames(changes).slice(0, 3).join(', ')
  return shown ? `${changesLabel(changes)} · ${shown}` : changesLabel(changes)
}
