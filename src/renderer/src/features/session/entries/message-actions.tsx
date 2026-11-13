import { memo, useState } from 'react'
import { ArrowTurnDownIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { UserContent } from '@shared/thread'
import { forkSession } from '@renderer/app/actions'
import { MessageActions } from '@renderer/components/affect/message-actions'
import { ForkIcon } from '@renderer/components/fork-icon'
import { Spinner } from '@renderer/components/ui/spinner'
import { longAgo, mediumAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { agentsOn, useAgentsStore } from '@renderer/stores/agents'
import { hostOfSession } from '@renderer/stores/sessions'
import { useThreadsStore } from '@renderer/stores/threads'
import { useReplyHover } from '../reply-hover'
import { useEntry, useEntryAnimation } from '../use-thread'
import { ChangesCard } from './changes-card'
import { forkBlocked, forkEntry, stopReasonText } from './helpers'

function Ago({ at }: { at: number }) {
  useTranslation()
  const now = useNow()
  return <span className="tabular">{longAgo(at, now)}</span>
}

/** When a reply came, on its own: "Just now", "12 min ago", "Oct 3". */
function Came({ at }: { at: number }) {
  const { i18n } = useTranslation()
  const now = useNow()
  const text = mediumAgo(at, now)
  return (
    <span className="tabular">
      {text.charAt(0).toLocaleUpperCase(i18n.language) + text.slice(1)}
    </span>
  )
}

/** Message Actions' words for Copy. */
function useCopyLabels(copyMessage: string) {
  const { t } = useTranslation('common')
  return { copy: t('actions.copy'), copied: t('actions.copied'), copyMessage }
}

function userText(content: UserContent[]): string {
  return content
    .map((c) => (c.type === 'text' ? c.text : c.ref.kind === 'link' ? c.ref.uri : ''))
    .filter(Boolean)
    .join('\n')
}

/** Under a message you sent, while the pointer is on it: the time and Copy. */
export function UserActions({
  content,
  at,
  steered,
}: {
  content: UserContent[]
  at?: number
  steered?: boolean
}) {
  const { t } = useTranslation('session')
  const labels = useCopyLabels(t('userActions.copyMessage'))
  return (
    <span className="ks-user__meta">
      {steered && (
        <span className="inline-flex shrink-0 items-center gap-1">
          <HugeiconsIcon
            icon={ArrowTurnDownIcon}
            aria-hidden
            strokeWidth={1.9}
            className="size-3 -scale-x-100"
          />
          {t('userActions.steered')}
        </span>
      )}
      {at !== undefined && <Ago at={at} />}
      <MessageActions
        quiet={false}
        text={userText(content)}
        actions={['copy']}
        label={t('userActions.label')}
        labels={labels}
      />
    </span>
  )
}

/**
 * Under a turn's reply: the files the turn changed, then Copy for the turn's messages, Fork where
 * the agent can fork from it, how the turn ended when it did not end on its own and when the reply
 * came. The actions show while the pointer is over the reply.
 */
export const ReplyFooter = memo(
  function ReplyFooter({
    replyKey,
    sessionId,
    projectPath,
    agentIds,
    toolIds,
    endId,
    latest,
  }: {
    replyKey: string
    sessionId: string
    projectPath: string
    agentIds: string[]
    toolIds: string[]
    endId: string | null
    latest: boolean
  }) {
    const { t } = useTranslation('session')
    const lastId = agentIds.at(-1)!
    const end = useEntry(sessionId, endId ?? '', 'turn_end')
    const animation = useEntryAnimation(sessionId, endId ?? lastId)
    const at = useThreadsStore((s) => {
      const entry = s.replicas[sessionId]?.state?.byId[lastId]
      return entry?.kind === 'agent' ? entry.at : undefined
    })
    // The session's view changes on most patches of a running turn, so take only what is shown.
    const session = useThreadsStore(
      useShallow((s) => {
        const view = s.replicas[sessionId]?.state?.session
        return view
          ? {
              agentId: view.agentId,
              projectPath: view.projectPath,
              origin: view.origin,
              blocked: forkBlocked(view.status),
            }
          : null
      }),
    )
    const forkAt = useAgentsStore((s) =>
      session
        ? forkEntry(
            { latest, agentIds },
            agentsOn(s, hostOfSession(session)).byId[session.agentId]?.capabilities,
          )
        : null,
    )
    const [forking, setForking] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const hovered = useReplyHover((s) => s.key === replyKey)
    const labels = useCopyLabels(t('replyFooter.copyReply'))
    // Joined when copied, not on every change of the thread.
    const copyText = () => {
      const byId = useThreadsStore.getState().replicas[sessionId]?.state?.byId
      const text = agentIds
        .map((id) => {
          const entry = byId?.[id]
          return entry?.kind === 'agent' ? entry.markdown.trim() : ''
        })
        .filter(Boolean)
        .join('\n\n')
      navigator.clipboard?.writeText(text).catch(() => {})
    }
    const fork = async () => {
      setForking(true)
      setError(null)
      try {
        await forkSession(sessionId, forkAt ?? undefined)
      } catch (e) {
        setError(errorMessage(e))
      } finally {
        setForking(false)
      }
    }
    const showFork = forkAt !== null && session?.origin === 'user'
    const blocked = session?.blocked ?? false
    const forkLabel = forking
      ? t('replyFooter.forking')
      : blocked
        ? t('replyFooter.forkNotReady')
        : t('replyFooter.fork')

    // A turn that ended on its own says how long it took in its folded work's row.
    const ending =
      end && end.stopReason !== 'end_turn' ? stopReasonText(end.stopReason, end.durationMs) : null
    const when =
      ending || at !== undefined ? (
        <span className="flex min-w-0 items-center gap-1.5 truncate tabular">
          {ending && <span>{ending}</span>}
          {ending && at !== undefined && <span aria-hidden>·</span>}
          {at !== undefined && (ending ? <Ago at={at} /> : <Came at={at} />)}
        </span>
      ) : undefined
    return (
      <>
        <ChangesCard sessionId={sessionId} projectPath={projectPath} toolIds={toolIds} />
        <div
          className={cn('ks-reply-foot', animation)}
          data-shown={hovered || forking ? '' : undefined}
        >
          <MessageActions
            quiet={false}
            onCopy={copyText}
            actions={['copy']}
            label={t('replyFooter.label')}
            labels={labels}
            extraActions={
              showFork
                ? [
                    {
                      key: 'fork',
                      tip: forkLabel,
                      label: forkLabel,
                      icon: forking ? <Spinner /> : <ForkIcon />,
                      disabled: forking || blocked,
                      onClick: () => void fork(),
                    },
                  ]
                : []
            }
            after={when}
          />
          {error && (
            <span className="ml-2 min-w-0 truncate text-danger" title={error}>
              {error}
            </span>
          )}
        </div>
      </>
    )
  },
  (a, b) =>
    a.replyKey === b.replyKey &&
    a.sessionId === b.sessionId &&
    a.projectPath === b.projectPath &&
    a.endId === b.endId &&
    a.latest === b.latest &&
    sameIds(a.agentIds, b.agentIds) &&
    sameIds(a.toolIds, b.toolIds),
)

const sameIds = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i])
