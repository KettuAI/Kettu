// How a document's or a deck's own save, as its viewer reports it, reads on the chip every tool
// shares.

import type { TFunction } from 'i18next'
import type { DocSaveState } from '@shared/artifact-runtime/document-sheet'
import type { SaveState } from './tool-parts'

/** The typed words stay on a failure; Retry is offered where trying again can help. */
export function sheetSave(
  save: { state: DocSaveState; version: number | null },
  t: TFunction<'artifacts'>,
): SaveState {
  switch (save.state) {
    case 'editing':
    case 'saving':
      return { state: 'pending' }
    case 'saved':
      return save.version === null
        ? { state: 'pending' }
        : { state: 'saved', version: save.version, edits: 1 }
    case 'failed':
    case 'conflict':
    case 'refused':
      return {
        state: 'failed',
        error: t('doc.save.kept'),
        text: t(`doc.save.${save.state}`),
        retry: save.state !== 'refused',
      }
  }
}
