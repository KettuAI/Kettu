import { memo, useState, type ReactNode } from 'react'
import { GitForkIcon, SquareIcon, Volume2Icon } from 'lucide-react'
import type { UserContent } from '@shared/thread'
import { forkSession } from '@renderer/app/actions'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { CopyButton } from '@renderer/features/git/branch-popover'
import { longAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { canSpeak, speak, speakable, stopSpeaking, useSpeaking } from '@renderer/lib/speech'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useAgentsStore } from '@renderer/stores/agents'
import { useThreadsStore } from '@renderer/stores/threads'
import { useEntry, useEntryAnimation, useSessionView } from '../use-thread'
import { stopReasonText } from './helpers'

// Rows under messages: hidden until the message is hovered or focused, except under the latest
// reply, where they stay in view.
const REVEAL =
  'opacity-0 transition-opacity duration-(--duration-fast) group-hover/actions:opacity-100 group-focus-within/actions:opacity-100'

function Ago({ at }: { at: number }) {
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
      <TooltipTrigger
        render={
          <Button
            variant="quiet"
            size="icon-xs"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            className="shrink-0 rounded-[6px] [&_svg]:size-3.5"
          />
        }
      >
        {children}
      </TooltipTrigger>
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

/** Under a user message, at its end: when it was sent, and Copy. */
export function UserActions({ content, at }: { content: UserContent[]; at?: number }) {
  return (
    <div className={cn('flex h-6 items-center gap-1 text-xs text-muted-foreground', REVEAL)}>
      {at !== undefined && <Ago at={at} />}
      <CopyButton text={() => userText(content)} label="Copy message" />
    </div>
  )
}

/**
 * Under a turn's reply: Copy and Read aloud for the turn's messages, Fork under the latest one,
 * then how the turn ended and when the reply came.
 */
export const ReplyFooter = memo(
  function ReplyFooter({
    sessionId,
    agentIds,
    endId,
    latest,
  }: {
    sessionId: string
    agentIds: string[]
    endId: string | null
    latest: boolean
  }) {
    const lastId = agentIds.at(-1)!
    const end = useEntry(sessionId, endId ?? '', 'turn_end')
    const animation = useEntryAnimation(sessionId, endId ?? lastId)
    const at = useThreadsStore((s) => {
      const entry = s.replicas[sessionId]?.state?.byId[lastId]
      return entry?.kind === 'agent' ? entry.at : undefined
    })
    const session = useSessionView(sessionId)
    const canFork = useAgentsStore(
      (s) => !!session && !!s.byId[session.agentId]?.capabilities.forkSession,
    )
    const speechId = `${sessionId}:${lastId}`
    const speaking = useSpeaking(speechId)
    const [forking, setForking] = useState(false)
    const [error, setError] = useState<string | null>(null)

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
        await forkSession(sessionId)
      } catch (e) {
        setError(errorMessage(e))
      } finally {
        setForking(false)
      }
    }
    const showFork = latest && canFork && session?.origin === 'user'

    return (
      <div
        className={cn(
          'group/actions -ml-1 flex h-7 min-w-0 items-center gap-0.5 text-xs text-muted-foreground',
          animation,
        )}
      >
        <div className={cn('flex items-center gap-0.5', !latest && REVEAL)}>
          <CopyButton text={text} label="Copy reply" />
          {canSpeak && (
            <ActionButton
              label={speaking ? 'Stop reading' : 'Read aloud'}
              onClick={() => (speaking ? stopSpeaking() : speak(speechId, speakable(text())))}
            >
              {speaking ? <SquareIcon /> : <Volume2Icon />}
            </ActionButton>
          )}
          {showFork && (
            <ActionButton
              label="Fork into a new session"
              disabled={forking || session.status !== 'ready'}
              onClick={() => void fork()}
            >
              <GitForkIcon />
            </ActionButton>
          )}
        </div>
        {(end || at !== undefined) && (
          <span className="ml-1.5 flex min-w-0 items-center gap-1.5 truncate tabular">
            {end && <span>{stopReasonText(end.stopReason, end.durationMs)}</span>}
            {end && at !== undefined && <span aria-hidden>·</span>}
            {at !== undefined && <Ago at={at} />}
          </span>
        )}
        {error && (
          <span className="ml-2 min-w-0 truncate text-destructive" title={error}>
            {error}
          </span>
        )}
      </div>
    )
  },
  (a, b) =>
    a.sessionId === b.sessionId &&
    a.endId === b.endId &&
    a.latest === b.latest &&
    a.agentIds.length === b.agentIds.length &&
    a.agentIds.every((id, i) => id === b.agentIds[i]),
)
