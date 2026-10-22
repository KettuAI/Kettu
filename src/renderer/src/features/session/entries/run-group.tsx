import { memo, useMemo, useState } from 'react'
import { ChevronRightIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { ToolContent } from '@shared/thread'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import { Spinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'
import { useThreadsStore } from '@renderer/stores/threads'
import { runParts, type RunPart } from '../thread-items'
import { useEntryAnimation } from '../use-thread'
import { Entry } from './entry'
import { PANEL, runSummary, type RunStep } from './helpers'
import { ToolGroup } from './tool-group'
import { useDiffStats } from './use-diff-stats'

interface RunGroupProps {
  sessionId: string
  entryIds: string[]
  /** The run's part of the thread signature, which changes only when its shape does. */
  signature: string
  projectPath: string
  agentName: string
}

/**
 * Two or more thoughts and tool calls between messages, or a finished turn's work before its
 * answer, folded into one line that says what they did ("Ran 3 commands, edited ui.md +3 −0")
 * and expands to the steps, and to the turn's earlier messages. A step waiting for permission
 * holds it open.
 */
export const RunGroup = memo(function RunGroup({
  sessionId,
  entryIds,
  signature,
  projectPath,
  agentName,
}: RunGroupProps) {
  const { t } = useTranslation('session')
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const animation = useEntryAnimation(sessionId, entryIds[0]!)
  const entries = useThreadsStore(
    useShallow((s) => {
      const byId = s.replicas[sessionId]?.state?.byId
      return entryIds.map((id) => byId?.[id])
    }),
  )
  const steps: RunStep[] = []
  const edits: ToolContent[] = []
  let waiting = false
  for (const entry of entries) {
    if (entry?.kind === 'thought') {
      steps.push({ kind: 'thought', durationMs: entry.durationMs, streaming: entry.streaming })
    } else if (entry?.kind === 'tool') {
      steps.push({
        kind: 'tool',
        toolKind: entry.toolKind,
        status: entry.status,
        path: entry.locations[0]?.path,
      })
      if (entry.toolKind === 'edit') edits.push(...entry.content)
      if (entry.permission) waiting = true
    }
  }
  const stats = useDiffStats(edits)
  const { parts, editAt, failed, running } = runSummary(steps)
  const contents = useMemo(() => runParts(entryIds, signature), [entryIds, signature])
  const open = waiting || (userOpen ?? false)

  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => setUserOpen(next)}
      className={cn('min-w-0', animation)}
    >
      <CollapsibleTrigger className="group/run -mx-1.5 flex h-6 max-w-[calc(100%+0.75rem)] items-center gap-1.5 rounded-md px-1.5 text-[13px] text-muted-foreground outline-none transition-colors duration-(--duration-fast) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
        <ChevronRightIcon
          aria-hidden
          className="size-3 shrink-0 transition-transform duration-(--duration-fast) group-data-panel-open/run:rotate-90"
        />
        <span className="min-w-0 truncate">
          {parts.map((part, i) => (
            <span key={i}>
              {i > 0 && t('summary.separator')}
              {part}
              {i === editAt && stats && (stats.insertions > 0 || stats.deletions > 0) && (
                <span className="ml-1.5 font-mono text-[11.5px] tabular">
                  <span className="text-success-text">+{stats.insertions}</span>{' '}
                  <span className="text-destructive">−{stats.deletions}</span>
                </span>
              )}
            </span>
          ))}
          {failed > 0 && (
            <span className="text-destructive">
              {t('summary.separator')}
              {t('summary.failed', { failed })}
            </span>
          )}
        </span>
        {running && <Spinner aria-label={t('status.running')} className="size-3 shrink-0" />}
      </CollapsibleTrigger>
      <CollapsibleContent className={PANEL}>
        <div className="mt-1 ml-1.5 flex flex-col border-l border-border pl-3.5">
          {contents.map((part, n) => (
            // Steps sit 4 px apart; a message keeps 16 px from what is around it.
            <div
              key={part.key}
              className={cn(n > 0 && (isStep(part) && isStep(contents[n - 1]!) ? 'pt-1' : 'pt-4'))}
            >
              {part.type === 'run' ? (
                <RunGroup
                  sessionId={sessionId}
                  entryIds={part.ids}
                  signature={part.signature}
                  projectPath={projectPath}
                  agentName={agentName}
                />
              ) : part.type === 'group' ? (
                <ToolGroup
                  sessionId={sessionId}
                  entryIds={part.ids}
                  projectPath={projectPath}
                  agentName={agentName}
                />
              ) : (
                <Entry
                  sessionId={sessionId}
                  entryId={part.id}
                  projectPath={projectPath}
                  agentName={agentName}
                />
              )}
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}, sameRun)

// The thread rebuilds its items on every change of shape, so the ids arrive as a new array.
function sameRun(a: RunGroupProps, b: RunGroupProps): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.signature === b.signature &&
    a.projectPath === b.projectPath &&
    a.agentName === b.agentName &&
    a.entryIds.length === b.entryIds.length &&
    a.entryIds.every((id, i) => id === b.entryIds[i])
  )
}

const isStep = (part: RunPart): boolean => part.type !== 'entry' || part.step
