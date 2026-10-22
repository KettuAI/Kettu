import { memo, useMemo, useState } from 'react'
import { ChevronRightIcon } from 'lucide-react'
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
import { stepItems } from '../thread-items'
import { useEntryAnimation } from '../use-thread'
import { ThoughtEntry } from './basic'
import { PANEL, runSummary, type RunStep } from './helpers'
import { ToolCard } from './tool-card'
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
 * Two or more thoughts and tool calls between messages, folded into one line that says what they
 * did ("Ran 3 commands, edited ui.md +3 −0") and expands to the steps. A step waiting for
 * permission holds it open.
 */
export const RunGroup = memo(function RunGroup({
  sessionId,
  entryIds,
  signature,
  projectPath,
  agentName,
}: RunGroupProps) {
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
  const items = useMemo(() => stepItems(entryIds, signature), [entryIds, signature])
  const thoughts = useMemo(
    () => new Set(entryIds.filter((_, i) => signature[i] === 'h')),
    [entryIds, signature],
  )
  const open = waiting || (userOpen ?? false)

  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => setUserOpen(next)}
      className={cn('min-w-0', animation)}
    >
      <CollapsibleTrigger className="group/run -mx-1 flex h-6 max-w-[calc(100%+0.5rem)] items-center gap-1 rounded-md px-1 text-ui text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
        <span className="min-w-0 truncate">
          {parts.map((part, i) => (
            <span key={i}>
              {i > 0 && ', '}
              {part}
              {i === editAt && stats && (stats.insertions > 0 || stats.deletions > 0) && (
                <span className="ml-1.5 font-mono text-[11.5px] tabular">
                  <span className="text-success-text">+{stats.insertions}</span>{' '}
                  <span className="text-destructive">−{stats.deletions}</span>
                </span>
              )}
            </span>
          ))}
          {failed > 0 && <span className="text-destructive">, {failed} failed</span>}
        </span>
        {running && <Spinner aria-label="Running" className="size-3 shrink-0" />}
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 shrink-0 transition-transform duration-(--duration-fast) group-data-panel-open/run:rotate-90"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className={PANEL}>
        <div className="mt-1.5 flex flex-col gap-2.5 border-l border-border pl-3">
          {items.map((item) =>
            item.type === 'group' ? (
              <ToolGroup
                key={item.key}
                sessionId={sessionId}
                entryIds={item.ids}
                projectPath={projectPath}
                agentName={agentName}
              />
            ) : thoughts.has(item.id) ? (
              <ThoughtEntry key={item.key} sessionId={sessionId} entryId={item.id} />
            ) : (
              <ToolCard
                key={item.key}
                sessionId={sessionId}
                entryId={item.id}
                projectPath={projectPath}
                agentName={agentName}
              />
            ),
          )}
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
