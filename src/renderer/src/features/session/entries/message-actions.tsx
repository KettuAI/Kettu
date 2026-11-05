import { memo, useState, type ReactNode } from 'react'
import { CornerDownRightIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { UserContent } from '@shared/thread'
import { forkSession } from '@renderer/app/actions'
import { ForkIcon } from '@renderer/components/fork-icon'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { CopyButton } from '@renderer/features/git/branch-popover'
import { longAgo, mediumAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useAgentsStore } from '@renderer/stores/agents'
import { useThreadsStore } from '@renderer/stores/threads'
import { useReplyHover } from '../reply-hover'
import { useEntry, useEntryAnimation, useSessionView } from '../use-thread'
import { ChangesCard } from './changes-card'
import { forkBlocked, forkEntry, stopReasonText } from './helpers'

// Rows under messages: hidden until the message is hovered or focused.
const REVEAL =
  'opacity-0 transition-opacity duration-(--duration-fast) group-hover/actions:opacity-100 group-focus-within/actions:opacity-100'

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
          <Button variant="quiet" size="icon-sm" aria-label={label} disabled className="shrink-0">
            {children}
          </Button>
        </TooltipTrigger>
      ) : (
        <TooltipTrigger
          render={
            <Button
              variant="quiet"
              size="icon-sm"
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

/** Message metadata and Copy, revealed on hover or focus. */
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
    <div
      className={cn(
        'flex h-7 max-w-full items-center gap-2 text-hint whitespace-nowrap text-tertiary',
        steered ? 'pr-0.5' : '-mr-1.5',
        REVEAL,
      )}
    >
      <span className="flex min-w-0 items-center gap-1">
        {at !== undefined && (
          <span className="truncate">
            <Ago at={at} />
          </span>
        )}
        <CopyButton
          text={() => userText(content)}
          label={t('userActions.copyMessage')}
          size="icon-sm"
        />
      </span>
      {steered && (
        <span className="inline-flex shrink-0 items-center gap-1">
          <CornerDownRightIcon className="size-3" />
          {t('userActions.steered')}
        </span>
      )}
    </div>
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
    const blocked = session ? forkBlocked(session.status) : false
    const forkLabel = forking
      ? t('replyFooter.forking')
      : blocked
        ? t('replyFooter.forkNotReady')
        : t('replyFooter.fork')

    // A turn that ended on its own says how long it took in its folded work's row.
    const ending =
      end && end.stopReason !== 'end_turn' ? stopReasonText(end.stopReason, end.durationMs) : null
    return (
      <>
        <ChangesCard
          sessionId={sessionId}
          projectPath={projectPath}
          toolIds={toolIds}
          className="mt-3 mb-2.5"
        />
        <div
          className={cn(
            'group/actions -ml-1.5 flex h-7 min-w-0 items-center gap-0.5 text-hint text-tertiary',
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
            <CopyButton text={text} label={t('replyFooter.copyReply')} size="icon-sm" />
            {showFork && (
              <ActionButton
                label={forkLabel}
                disabled={forking || blocked}
                onClick={() => void fork()}
              >
                {forking ? <Spinner /> : <ForkIcon />}
              </ActionButton>
            )}
            {(ending || at !== undefined) && (
              <span className="ml-1.5 flex min-w-0 items-center gap-1.5 truncate tabular">
                {ending && <span>{ending}</span>}
                {ending && at !== undefined && <span aria-hidden>·</span>}
                {at !== undefined && (ending ? <Ago at={at} /> : <Came at={at} />)}
              </span>
            )}
          </div>
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
