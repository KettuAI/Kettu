import type { ReactNode } from 'react'
import {
  AlertCircleIcon,
  ArrowTurnBackwardIcon,
  ArrowUpRight01Icon,
  CheckmarkCircle02Icon,
  StopCircleIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { FromSession, StopReason } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { BrandIcon } from '@renderer/components/brand'
import { cn } from '@renderer/lib/utils'
import { hostOfSession, sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'
import { reportSentence } from './helpers'
import { TurnEndTag } from './turn-end-tag'

/** The session a message or report came from, while Kettu still holds it. */
function useSender(sessionId: string) {
  return useSessionsStore(
    useShallow((s) => {
      const sender = s.byId[sessionId]
      return sender
        ? {
            id: sender.id,
            title: sessionTitle(sender),
            agentId: sender.agentId,
            projectPath: sender.projectPath,
          }
        : null
    }),
  )
}

/**
 * A message another session's agent sent: a quoted card on the agent's side of the thread, so the
 * user's own bubble at the right stays the only one. Its title opens the sender.
 */
export function FromSessionCard({ from, children }: { from: FromSession; children: ReactNode }) {
  useTranslation('session')
  const sender = useSender(from.sessionId)
  const title = sender?.title ?? from.title
  return (
    <figure className="ks-from">
      <figcaption className="ks-from__head">
        {sender && <AgentMark agent={sender.agentId} size={14} hostId={hostOfSession(sender)} />}
        {sender ? (
          <button
            type="button"
            className="min-w-0 truncate rounded-sm outline-none hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline"
            onClick={() => openSession(sender.id, sender.projectPath)}
          >
            {title}
          </button>
        ) : (
          <span className="min-w-0 truncate">{title}</span>
        )}
        <HugeiconsIcon
          icon={ArrowTurnBackwardIcon}
          strokeWidth={1.9}
          aria-hidden
          className="size-3 shrink-0"
        />
      </figcaption>
      {children}
    </figure>
  )
}

/**
 * A message Kettu itself wrote to the agent, such as a workflow step's prompt or reminder: the same
 * quoted card on the agent's side, headed by Kettu's own mark, since the user never wrote it.
 */
export function KettuCard({ children }: { children: ReactNode }) {
  const { t } = useTranslation('session')
  return (
    <figure className="ks-from">
      <figcaption className="ks-from__head">
        <BrandIcon size={14} />
        <span className="min-w-0 truncate">{t('userEntry.kettu')}</span>
      </figcaption>
      {children}
    </figure>
  )
}

/**
 * Kettu's report that a turn the session asked for ended: an event line like the thread's other
 * ones, since it is not something anyone said. It is drawn from the report's fields, never from
 * the sentence the agent was sent.
 */
export function ReportLine({
  from,
  ended,
  end,
  className,
}: {
  from: FromSession
  ended: NonNullable<FromSession['ended']>
  /** How the turn the report started ended, when it got no reply. */
  end?: { stopReason: StopReason; durationMs: number }
  className?: string
}) {
  useTranslation('session')
  const sender = useSender(from.sessionId)
  const title = sender?.title ?? from.title
  const done = ended.stopReason === 'end_turn'
  const stopped = ended.stopReason === 'cancelled'
  return (
    <div className={cn('flex flex-col', className)} data-selectable="">
      <div className="flex min-h-6 min-w-0 items-center gap-2 text-ui text-muted-foreground">
        <HugeiconsIcon
          icon={done ? CheckmarkCircle02Icon : stopped ? StopCircleIcon : AlertCircleIcon}
          strokeWidth={1.9}
          aria-hidden
          className={cn(
            'size-3.5 shrink-0',
            done && 'text-success',
            !done && !stopped && 'text-danger',
          )}
        />
        <span className="shrink-0">{reportSentence(ended)}</span>
        {sender ? (
          <button
            type="button"
            className="flex min-w-0 items-center gap-1 rounded-sm font-medium text-foreground outline-none hover:underline focus-visible:underline"
            onClick={() => openSession(sender.id, sender.projectPath)}
          >
            <span className="truncate">{title}</span>
            <HugeiconsIcon
              icon={ArrowUpRight01Icon}
              strokeWidth={1.9}
              aria-hidden
              className="size-3 shrink-0 text-muted-foreground"
            />
          </button>
        ) : (
          <span className="min-w-0 truncate font-medium">{title}</span>
        )}
      </div>
      {end && <TurnEndTag stopReason={end.stopReason} durationMs={end.durationMs} />}
    </div>
  )
}
