// Handing a web page's script errors to an agent: a message asking for a fix, and the error lines
// inside a data block, quoted as the page reported them, so a page's text cannot pass for the
// user's.

import { parseServed } from '@shared/artifact-page'
import type { PageErrors } from '@shared/artifact-runtime/page-errors'
import { snippet, type PageError } from '@shared/artifact-runtime/page-messages'
import { emitAppEvent } from '@renderer/app/events'
import {
  flushDraft,
  NEW_SESSION_DRAFT,
  readDraft,
  writeDraft,
} from '@renderer/features/session/composer/drafts'
import { host } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'
import { openNewSession } from '@renderer/stores/view'
import { block, boundary } from './anchors'

/** Where an error happened, "app.js:48:3", or null when the page named no script. */
export function errorPlace(error: PageError): string | null {
  if (!error.source) return null
  // The artifact's own path for a file it serves, without the version it is served under.
  const file = parseServed(error.source, new URLSearchParams())?.path ?? error.source
  const at = [file, error.line, error.column].filter((part) => part !== null)
  return at.join(':')
}

/** How many errors the pages reported, kept or not. */
export function errorCount(pages: readonly PageErrors[]): number {
  return pages.reduce((sum, page) => sum + page.errors.length + page.dropped, 0)
}

/** The error lines as text, the same for Copy and for the agent. */
export function errorLines(pages: readonly PageErrors[]): string[] {
  const lines: string[] = []
  for (const page of pages) {
    lines.push(`page ${page.path}`)
    for (const error of page.errors) {
      const place = errorPlace(error)
      const kind = error.kind === 'rejection' ? 'unhandled rejection' : 'error'
      lines.push(`${kind}: ${snippet(error.message, 2_000)}${place ? ` (at ${place})` : ''}`)
    }
    if (page.dropped > 0) lines.push(`${page.dropped} more not kept`)
  }
  return lines
}

/**
 * Sends the errors to a session as one user message, or opens New session with it drafted when
 * there is no session to send to; true when it was sent.
 */
export async function handOffPageErrors(input: {
  artifact: { id: string; title: string; version: number; project: string }
  pages: readonly PageErrors[]
  session: string | null
}): Promise<boolean> {
  const { artifact } = input
  const data = [`artifact: "${snippet(artifact.title)}"`, ...errorLines(input.pages)]
  const mark = boundary(data)
  const text = [
    i18n.t('artifacts:prompt.pageErrors', { id: artifact.id, version: artifact.version }),
    i18n.t('artifacts:prompt.errorData', { mark }),
    block(mark, data),
  ].join('\n\n')
  if (!input.session) {
    const draft = readDraft(NEW_SESSION_DRAFT)
    writeDraft(NEW_SESSION_DRAFT, draft.trim() ? `${draft}\n\n${text}` : text)
    flushDraft(NEW_SESSION_DRAFT)
    openNewSession(artifact.project, null)
    emitAppEvent({ kind: 'draft-written', draft: NEW_SESSION_DRAFT })
    return false
  }
  await host('sessions.queue', { sessionId: input.session, content: [{ type: 'text', text }] })
  return true
}

/**
 * Asks a session to repair what of the artifact cannot show, the whole of it or one frame, as one
 * user message; or opens New session with it drafted when there is no session; true when sent.
 */
export async function handOffRepair(input: {
  artifact: { id: string; title: string; version: number; project: string }
  /** The frame's file, when only it cannot show. */
  file: string | null
  reason: string
  session: string | null
}): Promise<boolean> {
  const { artifact } = input
  const text = input.file
    ? i18n.t('artifacts:prompt.repairFrame', {
        id: artifact.id,
        version: artifact.version,
        file: input.file,
        reason: input.reason,
      })
    : i18n.t('artifacts:prompt.repair', {
        id: artifact.id,
        version: artifact.version,
        reason: input.reason,
      })
  if (!input.session) {
    const draft = readDraft(NEW_SESSION_DRAFT)
    writeDraft(NEW_SESSION_DRAFT, draft.trim() ? `${draft}\n\n${text}` : text)
    flushDraft(NEW_SESSION_DRAFT)
    openNewSession(artifact.project, null)
    emitAppEvent({ kind: 'draft-written', draft: NEW_SESSION_DRAFT })
    return false
  }
  await host('sessions.queue', { sessionId: input.session, content: [{ type: 'text', text }] })
  return true
}
