import { emitAppEvent } from '@renderer/app/events'
import {
  flushDraft,
  NEW_SESSION_DRAFT,
  readDraft,
  writeDraft,
} from '@renderer/features/session/composer/drafts'
import { i18n } from '@renderer/lib/i18n'
import { openNewSession } from '@renderer/stores/view'
import { withAskLine, type ArtifactKind } from './model'

/**
 * A kind tile: New session in the current project, with a line asking for the kind in its draft,
 * which the agent makes once the user sends.
 */
export function askForArtifact(kind: ArtifactKind): void {
  const line = i18n.t(`artifacts:page.askLine.${kind}`)
  writeDraft(NEW_SESSION_DRAFT, withAskLine(readDraft(NEW_SESSION_DRAFT), line))
  flushDraft(NEW_SESSION_DRAFT)
  openNewSession(null, null)
  emitAppEvent({ kind: 'draft-written', draft: NEW_SESSION_DRAFT })
}
