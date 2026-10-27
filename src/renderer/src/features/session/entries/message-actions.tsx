import { memo, useState, type ReactNode } from 'react'
import { CornerDownRightIcon, GitForkIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { UserContent } from '@shared/thread'
import { forkSession } from '@renderer/app/actions'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { CopyButton } from '@renderer/features/git/branch-popover'
import { longAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useAgentsStore } from '@renderer/stores/agents'
import { useThreadsStore } from '@renderer/stores/threads'
import { useReplyHover } from '../reply-hover'
import { useEntry, useEntryAnimation, useSessionView } from '../use-thread'
import { forkBlocked, forkEntry, stopReasonText } from './helpers'

// Rows under messages: hidden until the message is hovered or focused.
const REVEAL =
  'opacity-0 transition-opacity duration-(--duration-fast) group-hover/actions:opacity-100 group-focus-within/actions:opacity-100'

function Ago({ at }: { at: number }) {
  useTranslation()
  const now = useNow()
  return <span className="tabular">{longAgo(at, now)}</span>
}

function ActionButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <Tooltip>
      {disabled ? (
        // A disabled button takes no pointer, so its tooltip opens from around it.
        <TooltipTrigger render={<span className="inline-flex" />}>
          <Button
            variant="quiet"
            size="icon-message"
            aria-label={label}
            disabled
            className="shrink-0"
          >
            {children}
          </Button>
        </TooltipTrigger>
      ) : (
        <TooltipTrigger
          render={
            <Button
              variant="quiet"
              size="icon-message"
              aria-label={label}
              onClick={onClick}
              className="shrink-0"
            />
          }
        >
          {children}
        </TooltipTrigger>
      )}
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function userText(content: UserContent[]): string {
  return content
    .map((c) => (c.type === 'text' ? c.text : c.ref.kind === 'link' ? c.ref.uri : ''))
    .filter(Boolean)
    .join('\n')
}

/**
 * Under a user message, at its end: "Steered" for one sent into a running turn, then on hover
 * when it was sent, and Copy.
 */
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
  return (
    <div className="-mr-1 flex h-6 items-center gap-1 text-xs text-muted-foreground">
      {steered && (
        <span className="mr-1 inline-flex items-center gap-1">
          <CornerDownRightIcon className="size-3" />
          {t('userActions.steered')}
        </span>
      )}
      <span className={cn('flex items-center gap-1', REVEAL)}>
        {at !== undefined && <Ago at={at} />}
        <CopyButton
          text={() => userText(content)}
          label={t('userActions.copyMessage')}
          size="icon-message"
        />
      </span>
    </div>
  )
}

/**
 * Under a turn's reply: Copy for the turn's messages, Fork where the agent can fork from it, then
 * how the turn ended and when the reply came. It shows while the pointer is over the reply.
 */
export const ReplyFooter = memo(
  function ReplyFooter({
    replyKey,
    sessionId,
    agentIds,
    endId,
    latest,
  }: {
    replyKey: string
    sessionId: string
    agentIds: string[]
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
    const session = useSessionView(sessionId)
    const forkAt = useAgentsStore((s) =>
      session ? forkEntry({ latest, agentIds }, s.byId[session.agentId]?.capabilities) : null,
    )
    const [forking, setForking] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const hovered = useReplyHover((s) => s.key === replyKey)

    const text = () => {
      const byId = useThreadsStore.getState().replicas[sessionId]?.state?.byId
      return agentIds
        .map((id) => {
          const entry = byId?.[id]
          return entry?.kind === 'agent' ? entry.markdown.trim() : ''
        })
        .filter(Boolean)
        .join('\n\n')
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
    const blocked = session ? forkBlocked(session.status) : null
    const forkLabel = forking
      ? t('replyFooter.forking')
      : blocked === 'turn'
        ? t('replyFooter.forkBetweenTurns')
        : blocked === 'not-ready'
          ? t('replyFooter.forkNotReady')
          : t('replyFooter.fork')

    return (
      <div
        className={cn(
          'group/actions -ml-1 flex h-6 min-w-0 items-center gap-0.5 text-xs text-muted-foreground',
          animation,
        )}
      >
        <div
          className={cn(
            'flex min-w-0 items-center gap-0.5',
            REVEAL,
            (hovered || forking) && 'opacity-100',
          )}
        >
          <CopyButton text={text} label={t('replyFooter.copyReply')} size="icon-message" />
          {showFork && (
            <ActionButton
              label={forkLabel}
              disabled={forking || blocked !== null}
              onClick={() => void fork()}
            >
              {forking ? <Spinner /> : <GitForkIcon />}
            </ActionButton>
          )}
          {(end || at !== undefined) && (
            <span className="ml-1 flex min-w-0 items-center gap-1.5 truncate tabular">
              {end && <span>{stopReasonText(end.stopReason, end.durationMs)}</span>}
              {end && at !== undefined && <span aria-hidden>·</span>}
              {at !== undefined && <Ago at={at} />}
            </span>
          )}
        </div>
        {error && (
          <span className="ml-2 min-w-0 truncate text-danger" title={error}>
            {error}
          </span>
        )}
      </div>
    )
  },
  (a, b) =>
    a.replyKey === b.replyKey &&
    a.sessionId === b.sessionId &&
    a.endId === b.endId &&
    a.latest === b.latest &&
    a.agentIds.length === b.agentIds.length &&
    a.agentIds.every((id, i) => id === b.agentIds[i]),
)
