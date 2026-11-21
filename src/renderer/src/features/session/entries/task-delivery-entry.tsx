import { memo, useState } from 'react'
import {
  BookmarkCheck01Icon,
  Bookmark01Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  MinusSignCircleIcon,
  Store01Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { MARKET_WAIT_MS } from '@shared/market-publish'
import type { TaskDeliveryEntry as Entry, ThreadState } from '@shared/thread'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Glyph } from '@renderer/features/shell/glyph'
import { DeliverableRows } from '@renderer/features/tasks/deliverables'
import { useTaskView } from '@renderer/features/tasks/use-task'
import { WorkflowChart } from '@renderer/features/tasks/workflow-chart'
import { runningFor } from '@renderer/lib/format'
import { errorMessage, hostAt } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { useThreadsStore } from '@renderer/stores/threads'
import { openTask } from '@renderer/stores/view'
import { useHostWorkflows, useWorkflowsStore } from '@renderer/stores/workflows'
import { useEntry, useEntryAnimation } from '../use-thread'
import type { EntryProps } from './basic'

const ENDED = {
  done: { icon: CheckmarkCircle02Icon, tone: 'text-success' },
  dropped: { icon: MinusSignCircleIcon, tone: 'text-tertiary' },
  cancelled: { icon: CancelCircleIcon, tone: 'text-tertiary' },
} as const

/**
 * Where a task this conversation started came back: a quiet block with how it ended, Open task
 * and what it delivered; for a workflow the agent wrote that worked, its chart with Save as my
 * workflow and Publish to the Marketplace.
 */
export const TaskDeliveryEntry = memo(function TaskDeliveryEntry({
  sessionId,
  entryId,
}: EntryProps) {
  const { t } = useTranslation('session')
  const entry = useEntry(sessionId, entryId, 'task_delivery')
  const animation = useEntryAnimation(sessionId, entryId)
  const summary = useSessionsStore((s) => s.byId[sessionId])
  if (!entry || !summary) return null
  const hostId = hostOfSession(summary)
  const ended = ENDED[entry.status]
  return (
    <section
      className={cn(
        'my-1 flex min-w-0 flex-col gap-2.5 rounded-xl bg-(--thread-hover) px-3.5 py-3',
        animation,
      )}
    >
      <header className="flex min-w-0 items-center gap-2 text-small">
        <Glyph icon={ended.icon} size={15} className={cn('shrink-0', ended.tone)} />
        <span className="min-w-0 flex-1 truncate font-medium text-(--thread-ink)">
          {t(`workflow.delivery.${entry.status}`, {
            count: entry.steps,
            time: runningFor(entry.durationMs),
          })}
        </span>
        <button
          type="button"
          className="shrink-0 text-link hover:underline"
          onClick={() => openTask(entry.taskId)}
        >
          {t('workflow.delivery.openTask')}
        </button>
      </header>
      <DeliverableRows
        deliverables={entry.deliverables}
        panel={sessionId}
        projectPath={summary.projectPath}
        local={hostId === null}
        className="pl-6"
      />
      {entry.written && (
        <Written
          sessionId={sessionId}
          entry={entry}
          hostId={hostId}
          agent={agentName(entry.written.agentId, hostId)}
        />
      )}
    </section>
  )
})

/**
 * Whether the publish the user last asked for still waits: the agent has opened no card for it
 * yet, or the one it opened is unanswered.
 */
function publishWaits(thread: ThreadState | null | undefined, entry: Entry): boolean {
  if (entry.publishAsked === undefined) return false
  if (!thread) return true
  // Its cards come after it, so the walk back stops there.
  for (let i = thread.order.length - 1; i >= 0 && thread.order[i] !== entry.id; i--) {
    const card = thread.byId[thread.order[i]!]
    if (card?.kind !== 'market_publish' || card.fromTask?.taskId !== entry.taskId) continue
    // A card opened before the user asked again answered an earlier ask.
    if (card.expiresAt - MARKET_WAIT_MS < entry.publishAsked) return true
    return card.outcome === null
  }
  return true
}

function Written({
  sessionId,
  entry,
  hostId,
  agent,
}: {
  sessionId: string
  entry: Entry
  hostId: string | null
  agent: string
}) {
  const { t } = useTranslation('session')
  const { view } = useTaskView(entry.taskId)
  const waits = useThreadsStore((s) => publishWaits(s.replicas[sessionId]?.state, entry))
  const { entries } = useHostWorkflows(hostId)
  const [busy, setBusy] = useState<'save' | 'publish' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const saved = !!view && entries.some((e) => e.hash === view.workflowHash)
  const run = async (kind: 'save' | 'publish') => {
    setBusy(kind)
    setError(null)
    try {
      if (kind === 'save') {
        await hostAt(hostId, 'tasks.saveWorkflow', { taskId: entry.taskId })
        useWorkflowsStore.getState().changed(hostId)
      } else {
        await hostAt(hostId, 'tasks.publishWorkflow', { taskId: entry.taskId })
      }
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-2.5 border-t border-(--thread-line) pt-2.5 pl-6">
      <p className="text-small text-(--thread-muted)">
        {t('workflow.delivery.written', { agent })}
      </p>
      {view ? (
        <WorkflowChart
          workflow={view.workflow}
          agentId={entry.written!.agentId}
          agentName={agent}
          hostId={hostId}
        />
      ) : (
        <Skeleton className="h-24 w-full rounded-lg" />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={saved || busy !== null}
          onClick={() => void run('save')}
        >
          <Glyph icon={saved ? BookmarkCheck01Icon : Bookmark01Icon} size={14} />
          {saved ? t('workflow.delivery.saved') : t('workflow.delivery.save')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => void run('publish')}
        >
          <Glyph icon={Store01Icon} size={14} />
          {t('workflow.delivery.publish')}
        </Button>
      </div>
      {waits && (
        <p className="text-hint text-(--thread-faint)">
          {t('workflow.delivery.publishAsked', { agent })}
        </p>
      )}
      {error && (
        <p role="alert" className="ks-card-error">
          {error}
        </p>
      )}
    </div>
  )
}
