// Where comments and a request about a selection go: one session of those that wrote the
// artifact, the one writing it first, or a new one; and sending to it as one user message.

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { SessionSummary } from '@shared/agent-host'
import type { VersionSummary } from '@shared/artifacts'
import type { UserContent } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import {
  flushDraft,
  NEW_SESSION_DRAFT,
  readDraft,
  writeDraft,
} from '@renderer/features/session/composer/drafts'
import { host } from '@renderer/lib/host'
import { useSessionsStore } from '@renderer/stores/sessions'
import { openNewSession } from '@renderer/stores/view'
import type { Presence } from './use-artifact'

/** A new session, in place of one that wrote the artifact. */
export const NEW_SESSION = 'new'

export interface SendTargets {
  /** The sessions offered, the default first. */
  sessions: SessionSummary[]
  /** The sessions whose running turn writes the artifact now. */
  writing: ReadonlySet<string>
  /** The session beside the artifact, which the menu calls this session. */
  beside: string | null
}

/**
 * The sessions to send to: the one beside the artifact, then those writing it now, then those that
 * wrote it, the latest first. A session archived or gone is left out.
 */
export function useSendTargets(input: {
  versions: readonly VersionSummary[] | null
  presence: Presence | null | undefined
  lastWriter: string | null
  beside: string | null
}): SendTargets {
  const { versions, presence, lastWriter, beside } = input
  const writing = useMemo(
    () => new Set(presence?.sessions.filter((s) => s.editing).map((s) => s.sessionId) ?? []),
    [presence],
  )
  const order = useMemo(() => {
    const ids: string[] = []
    const add = (id: string | null | undefined) => {
      if (id && !ids.includes(id)) ids.push(id)
    }
    add(beside)
    for (const id of writing) add(id)
    for (const v of versions ?? []) add(v.author)
    add(lastWriter)
    return ids
  }, [beside, writing, versions, lastWriter])
  const sessions = useSessionsStore(
    useShallow((s) =>
      order
        .map((id) => s.byId[id])
        .filter((session): session is SessionSummary => !!session && session.archivedAt === null),
    ),
  )
  return useMemo(() => ({ sessions, writing, beside }), [sessions, writing, beside])
}

/** Sends a message to a session, or drafts it in New session when the target is a new one. */
export async function sendToSession(
  project: string,
  target: string,
  text: string,
  images: UserContent[] = [],
): Promise<'sent' | 'drafted'> {
  if (target === NEW_SESSION) {
    const draft = readDraft(NEW_SESSION_DRAFT)
    writeDraft(NEW_SESSION_DRAFT, draft.trim() ? `${draft}\n\n${text}` : text)
    flushDraft(NEW_SESSION_DRAFT)
    openNewSession(project, null)
    emitAppEvent({ kind: 'draft-written', draft: NEW_SESSION_DRAFT })
    return 'drafted'
  }
  await host('sessions.queue', { sessionId: target, content: [{ type: 'text', text }, ...images] })
  return 'sent'
}

/** The name a target goes by in the menu and on what was sent. */
export function useTargetName(): (targets: SendTargets, target: string) => string {
  const { t } = useTranslation(['artifacts', 'common'])
  return (targets, target) => {
    if (target === NEW_SESSION) return t('comments.newSession')
    if (target === targets.beside) return t('send.thisSession')
    const session = targets.sessions.find((s) => s.id === target)
    return session?.title ?? t('common:untitledSession')
  }
}
