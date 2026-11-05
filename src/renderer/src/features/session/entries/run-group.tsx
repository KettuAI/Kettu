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
import { Entry } from './entry'
import { CutLabel } from './cut-label'
import {
  PANEL,
  runLabels,
  runSummary,
  thoughtTitle,
  toolStep,
  type RunStep,
  type SummaryPart,
} from './helpers'
import { stepPictures } from './row-pictures'
import { ThumbRow } from './row-thumbs'
import { ToolGroup } from './tool-group'
import { useDiffStats } from './use-diff-stats'

interface RunGroupProps {
  sessionId: string
  entryIds: string[]
  /** The run's part of the thread signature, which changes only when its shape does. */
  signature: string
  projectPath: string
  agentName: string
  /** The last thing in a thread whose turn still runs. */
  latest: boolean
}

// What an agent's own label for a run names, so the counts after it leave these out.
const LABELLED = new Set(['read', 'search', 'fetch'])

/**
 * The work between messages, two or more steps or a lone tool call or thought, folded into one
 * line that says what it did ("Read plan.md · Edited ui.md +3 −0 · Ran 3 commands") and expands to
 * the steps. An agent's own label for the work comes first and its counts follow. While the work
 * runs, or is the last thing in a turn that still runs, the line ends with the latest thought's
 * heading. A step waiting for permission holds it open.
 */
export const RunGroup = memo(function RunGroup({
  sessionId,
  entryIds,
  signature,
  projectPath,
  agentName,
  latest,
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
    } else if (entry?.kind === 'compaction') {
      steps.push({ kind: 'compaction', running: entry.status === 'in_progress' })
    }
  }
  const summary = runSummary(steps)
  const { failed, running } = summary
  const labels = runLabels(steps)
  const parts: SummaryPart[] =
    labels.length > 0
      ? [
          ...labels.map((text) => ({ text })),
          ...summary.parts.filter((part) => !part.kind || !LABELLED.has(part.kind)),
        ]
      : summary.parts
  let thought: string | null = null
  if (running || latest) {
    for (let i = entries.length - 1; i >= 0 && thought === null; i--) {
      const entry = entries[i]
      if (entry?.kind === 'thought') thought = thoughtTitle(entry.markdown)
    }
  }
  const pictures = useMemo(() => stepPictures(entries), [entries])
  const items = useMemo(() => stepItems(entryIds, signature), [entryIds, signature])
  const spaced = useMemo(
    () => new Set(entryIds.filter((_, i) => signature[i] === 'p' || signature[i] === 'h')),
    [entryIds, signature],
  )
  const open = waiting || (userOpen ?? false)

  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => setUserOpen(next)}
      className={cn('min-w-0', animation)}
    >
      <ThumbRow
        sessionId={sessionId}
        pictures={pictures}
        open={open}
        className="-ml-2 min-h-7 w-fit max-w-[calc(100%+0.5rem)]"
        filled="w-[calc(100%+0.5rem)]"
      >
        <CollapsibleTrigger className="group/run flex min-w-0 grow items-center gap-1.5 rounded-tile px-2 py-0.75 text-left text-control text-tertiary outline-none focus-ring">
          <ChevronRightIcon
            aria-hidden
            strokeWidth={1.75}
            className="size-3 shrink-0 transition-transform duration-(--duration-fast) group-data-panel-open/run:rotate-90 motion-reduce:transition-none"
          />
          <CutLabel
            className="min-w-0 truncate"
            full={<Summary parts={parts} failed={failed} thought={thought} plain />}
          >
            <Summary parts={parts} failed={failed} thought={thought} />
          </CutLabel>
          {running && (
            <Spinner aria-label={t('status.running')} className="size-3 shrink-0 text-info" />
          )}
        </CollapsibleTrigger>
      </ThumbRow>
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
              // A compaction or thought is not a row, so it keeps room from them.
              <div key={item.key} className={cn(spaced.has(item.id) && 'py-1.5')}>
                <Entry
                  sessionId={sessionId}
                  entryId={item.id}
                  projectPath={projectPath}
                  agentName={agentName}
                />
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
  thought,
  plain = false,
}: {
  parts: SummaryPart[]
  failed: number
  thought: string | null
  plain?: boolean
}) {
  const { t } = useTranslation('session')
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 && <Separator plain={plain} />}
          <PartText part={part} plain={plain} />
          {part.diffs && <PartStats diffs={part.diffs} plain={plain} />}
        </span>
      ))}
      {failed > 0 && (
        <span className={cn(!plain && 'text-danger')}>
          <Separator plain={plain} />
          {t('summary.failed', { failed })}
        </span>
      )}
      {thought && (
        <span>
          <Separator plain={plain} />
          {thought}
        </span>
      )}
    </>
  )
}

/** The dot between parts, faint so the parts lead. */
function Separator({ plain }: { plain: boolean }) {
  const { t } = useTranslation('session')
  return <span className={cn(!plain && 'text-(--border-strong)')}>{t('summary.separator')}</span>
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
    <span className="ml-1.5 tabular">
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
    a.latest === b.latest &&
    a.entryIds.length === b.entryIds.length &&
    a.entryIds.every((id, i) => id === b.entryIds[i])
  )
}
