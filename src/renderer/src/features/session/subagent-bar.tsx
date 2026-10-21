import { useState } from 'react'
import { ArrowLeftIcon, BotIcon, SquareIcon } from 'lucide-react'
import type { SessionSummary } from '@shared/agent-host'
import type { SessionView } from '@shared/thread'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { errorMessage, host } from '@renderer/lib/host'
import { agentName } from '@renderer/stores/agents'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'

/** In place of the composer: the agent drives a subagent, so you can only stop it or go back. */
export function SubagentBar({
  summary,
  session,
}: {
  summary: SessionSummary
  session: SessionView | undefined
}) {
  const parent = useSessionsStore((s) => (summary.parentId ? s.byId[summary.parentId] : undefined))
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const running = summary.status === 'running' || summary.status === 'awaiting_permission'
  const canStop = running && !!session?.subagent?.canCancel
  const parentTitle = parent ? sessionTitle(parent) : 'its parent session'

  const stop = async () => {
    setStopping(true)
    setError(null)
    try {
      await host('sessions.cancel', { sessionId: summary.id })
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setStopping(false)
    }
  }

  return (
    <div className="flex min-h-(--composer-min) items-center gap-2 rounded-2xl bg-card px-4 py-2 shadow-card">
      <BotIcon className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="truncate text-[13px] text-muted-foreground">
          {agentName(summary.agentId)} runs this subagent for{' '}
          <span className="text-foreground">{parentTitle}</span>
        </p>
        {error && <p className="truncate text-xs text-destructive">{error}</p>}
      </div>
      {canStop && (
        <Button variant="outline" size="compact" disabled={stopping} onClick={() => void stop()}>
          {stopping ? (
            <Spinner data-icon="inline-start" className="size-3" />
          ) : (
            <SquareIcon data-icon="inline-start" className="size-2.5 fill-current" />
          )}
          Stop
        </Button>
      )}
      {parent && (
        <Button
          variant="quiet"
          size="compact"
          onClick={() => openSession(parent.id, parent.projectPath)}
        >
          <ArrowLeftIcon data-icon="inline-start" />
          Back to {parentTitle.length > 24 ? `${parentTitle.slice(0, 23)}…` : parentTitle}
        </Button>
      )}
    </div>
  )
}
