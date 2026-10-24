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
import { stepItems } from '../thread-items'
import { useEntryAnimation } from '../use-thread'
import { AgentEntry } from './basic'
import { Entry } from './entry'
import { CutLabel } from './cut-label'
import { PANEL, runSummary, toolStep, type RunStep, type SummaryPart } from './helpers'
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
 * The work between messages, two or more steps or a lone tool call, folded into one line that
 * says what it did ("Read plan.md · Edited ui.md +3 −0 · Ran 3 commands") and expands to the
 * steps. A step waiting for permission holds it open.
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
  let waiting = false
  for (const entry of entries) {
    if (entry?.kind === 'thought') {
      steps.push({ kind: 'thought', durationMs: entry.durationMs, streaming: entry.streaming })
    } else if (entry?.kind === 'tool') {
      steps.push(toolStep(entry))
      if (entry.permission) waiting = true
    } else if (entry?.kind === 'plan') {
      steps.push({ kind: 'plan' })
    } else if (entry?.kind === 'compaction') {
      steps.push({ kind: 'compaction', running: entry.status === 'in_progress' })
    }
  }
  const { parts, failed, running } = runSummary(steps)
  const items = useMemo(() => stepItems(entryIds, signature), [entryIds, signature])
  const spaced = useMemo(
    () => new Set(entryIds.filter((_, i) => signature[i] === 'p' || signature[i] === 'c')),
    [entryIds, signature],
  )
  const notes = useMemo(
    () => new Set(entryIds.filter((_, i) => signature[i] === 'c')),
    [entryIds, signature],
  )
  const open = waiting || (userOpen ?? false)

  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => setUserOpen(next)}
      className={cn('min-w-0', animation)}
    >
      <CollapsibleTrigger className="group/run -mx-1.5 flex h-6 max-w-[calc(100%+0.75rem)] items-center gap-1 rounded-md px-1.5 text-ui text-muted-foreground outline-none transition-colors duration-(--duration-fast) hover:bg-hover hover:text-primary focus-ring">
        <CutLabel
          className="min-w-0 truncate"
          full={<Summary parts={parts} failed={failed} plain />}
        >
          <Summary parts={parts} failed={failed} />
        </CutLabel>
        {running && (
          <Spinner aria-label={t('status.running')} className="size-3 shrink-0 text-info" />
        )}
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 shrink-0 transition-transform duration-(--duration-fast) group-data-panel-open/run:rotate-90"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className={PANEL}>
        <div className="mt-1 ml-1.5 flex flex-col gap-0.5 border-l border-subtle pl-3.5">
          {items.map((item) =>
            item.type === 'group' ? (
              <ToolGroup
                key={item.key}
                sessionId={sessionId}
                entryIds={item.ids}
                projectPath={projectPath}
                agentName={agentName}
              />
            ) : (
              // A plan, a compaction or a progress note is not a row, so it keeps room from them.
              <div key={item.key} className={cn(spaced.has(item.id) && 'py-1.5')}>
                {notes.has(item.id) ? (
                  <AgentEntry sessionId={sessionId} entryId={item.id} note />
                ) : (
                  <Entry
                    sessionId={sessionId}
                    entryId={item.id}
                    projectPath={projectPath}
                    agentName={agentName}
                  />
                )}
              </div>
            ),
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}, sameRun)

/** The fold line's text; `plain` drops its colors for the tooltip's inverted surface. */
function Summary({
  parts,
  failed,
  plain = false,
}: {
  parts: SummaryPart[]
  failed: number
  plain?: boolean
}) {
  const { t } = useTranslation('session')
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 && t('summary.separator')}
          <PartText part={part} plain={plain} />
          {part.diffs && <PartStats diffs={part.diffs} plain={plain} />}
        </span>
      ))}
      {failed > 0 && (
        <span className={cn(!plain && 'text-danger')}>
          {t('summary.separator')}
          {t('summary.failed', { failed })}
        </span>
      )}
    </>
  )
}

/** A part's words, its file names in the primary text color. */
function PartText({ part, plain }: { part: SummaryPart; plain: boolean }) {
  const at = part.names ? part.text.indexOf(part.names) : -1
  if (plain || !part.names || at < 0) return part.text
  return (
    <>
      {part.text.slice(0, at)}
      <span className="text-primary">{part.names}</span>
      {part.text.slice(at + part.names.length)}
    </>
  )
}

/** The insertions and deletions of a part's diffs, after the file it names. */
function PartStats({ diffs, plain }: { diffs: ToolContent[]; plain: boolean }) {
  const stats = useDiffStats(diffs)
  if (!stats || (stats.insertions === 0 && stats.deletions === 0)) return null
  return (
    <span className="ml-1.5 font-mono text-meta tabular">
      <span className={cn(!plain && 'text-success')}>+{stats.insertions}</span>{' '}
      <span className={cn(!plain && 'text-danger')}>−{stats.deletions}</span>
    </span>
  )
}

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
