import { memo, startTransition, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { IconSvgElement } from '@hugeicons/react'
import type { ThreadEntry, ToolContent } from '@shared/thread'
import type { ToolCallLabels } from '@renderer/components/affect/tool-call-card'
import { Icon } from '@renderer/components/affect/app-shell'
import { ToolCallGroup } from '@renderer/components/affect/tool-call-card'
import { cn } from '@renderer/lib/utils'
import { useThreadsStore } from '@renderer/stores/threads'
import { toolTime } from '../tool-times'
import { useEntryAnimation } from '../use-thread'
import {
  runLabels,
  runSummary,
  thoughtTitle,
  toolStep,
  type RunStep,
  type SummaryPart,
} from './helpers'
import { RowThumbs } from './row-thumbs'
import { StepCard, StepStub } from './tool-call'
import {
  runPictures,
  stackedGlyphs,
  stepFacts,
  useToolCallLabels,
  type StepFacts,
} from './tool-call-model'
import { cachedStats, useDiffStats } from './use-diff-stats'
import { useOpenedOnce } from './use-opened'

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

// A step's row is 30 px tall, so a window this tall shows at most its height over this many.
const STEP_PX = 30

/**
 * A step of an opened run, which reads its own entry: a change to one step re-renders that step's
 * card alone. Its facts come as props too, since the run's line reads them off its children.
 */
const OpenedStep = memo(function OpenedStep({
  sessionId,
  entryId,
  glyph,
  late,
  ...rest
}: Omit<StepFacts, 'glyph'> & {
  sessionId: string
  entryId: string
  glyph: IconSvgElement
  projectPath: string
  labels: Partial<ToolCallLabels>
  rail: boolean
  /** Mounted after the run's first open, below the window, so it takes no entrance. */
  late: boolean
}) {
  const entry = useThreadsStore((s) => s.replicas[sessionId]?.state?.byId[entryId])
  if (!entry) return null
  return (
    <StepCard
      {...rest}
      icon={<Icon icon={glyph} size={14} />}
      sessionId={sessionId}
      entry={entry}
      late={late}
    />
  )
})

/**
 * The work between messages on affectUI's Tool Call Group: one line that says what it did ("Read
 * plan.md · Edited ui.md +3 −0 · Ran 3 commands") over the stacked icons of its last steps, how
 * many failed and how long it took, opening to a card per step. An agent's own label for the work
 * comes first. While the work runs, or is the last thing in a turn that still runs, the line ends
 * with the latest thought's heading. A lone step shows as its card alone.
 */
export const RunGroup = memo(function RunGroup({
  sessionId,
  entryIds,
  projectPath,
  latest,
}: RunGroupProps) {
  const { t } = useTranslation('session')
  const labels = useToolCallLabels()
  const animation = useEntryAnimation(sessionId, entryIds[0]!)
  const entries = useThreadsStore(
    useShallow((s) => {
      const byId = s.replicas[sessionId]?.state?.byId
      return entryIds.map((id) => byId?.[id])
    }),
  )
  const shown = entries.filter((entry): entry is ThreadEntry => entry !== undefined)
  // Loads the counts of every edit's diffs, which the line then reads from the cache.
  const diffs = useMemo(
    () =>
      shown.flatMap((entry): ToolContent[] =>
        entry.kind === 'tool' ? entry.content.filter((c) => c.type === 'diff') : [],
      ),
    [shown],
  )
  useDiffStats(diffs)
  const pictures = useMemo(() => runPictures(entries), [entries])
  const [opened, onOpenChange, opening] = useOpenedOnce()
  // A first open mounts the steps a window can show, with their entrance; the rest follow in a
  // transition, without one.
  const [shownSteps, setShownSteps] = useState(Number.POSITIVE_INFINITY)
  const [lateFrom, setLateFrom] = useState(Number.POSITIVE_INFINITY)
  const open = useCallback(
    (next: boolean) => {
      if (next && !opened) {
        const fit = Math.ceil(window.innerHeight / STEP_PX)
        setShownSteps(fit)
        setLateFrom(fit)
      }
      onOpenChange(next)
    },
    [opened, onOpenChange],
  )
  useEffect(() => {
    if (shownSteps !== Number.POSITIVE_INFINITY) {
      startTransition(() => setShownSteps(Number.POSITIVE_INFINITY))
    }
  }, [shownSteps])
  const card = (entry: ThreadEntry, index: number, folded: boolean) => {
    const facts = stepFacts(sessionId, entry)
    if (!facts) return null
    const { glyph, ...rest } = facts
    if (folded) return <StepStub key={entry.id} {...rest} icon={<Icon icon={glyph} size={14} />} />
    return (
      <OpenedStep
        key={entry.id}
        {...rest}
        glyph={glyph}
        sessionId={sessionId}
        entryId={entry.id}
        projectPath={projectPath}
        labels={labels}
        rail={shown.length > 1}
        late={index >= lateFrom}
      />
    )
  }

  if (shown.length === 1) {
    return <div className={cn('min-w-0', animation)}>{card(shown[0]!, 0, false)}</div>
  }

  const steps: RunStep[] = []
  for (const entry of shown) {
    if (entry.kind === 'thought') {
      steps.push({ kind: 'thought', durationMs: entry.durationMs, streaming: entry.streaming })
    } else if (entry.kind === 'tool') {
      steps.push(toolStep(entry))
    }
  }
  const summary = runSummary(steps)
  const own = runLabels(steps)
  const parts: SummaryPart[] =
    own.length > 0
      ? [
          ...own.map((text) => ({ text })),
          ...summary.parts.filter((part) => !part.kind || !LABELLED.has(part.kind)),
        ]
      : summary.parts
  const texts = parts.map((part) => {
    const stats = part.diffs ? cachedStats(part.diffs) : null
    return stats && (stats.insertions > 0 || stats.deletions > 0)
      ? `${part.text} +${stats.insertions} −${stats.deletions}`
      : part.text
  })
  if (summary.running || latest) {
    for (let i = shown.length - 1; i >= 0; i--) {
      const entry = shown[i]!
      if (entry.kind !== 'thought') continue
      const title = thoughtTitle(entry.markdown)
      if (title) texts.push(title)
      break
    }
  }
  const label = texts.join(t('summary.separator'))

  // The time the run took, when this window saw each of its steps start and end.
  let total = 0
  let known = true
  for (const entry of shown) {
    if (entry.kind === 'thought' && entry.durationMs !== undefined) total += entry.durationMs
    else if (entry.kind === 'tool') {
      const time = toolTime(sessionId, entry.id)
      if (time.durationMs !== undefined) total += time.durationMs
      else if (!summary.running || time.startedAt === undefined) known = false
    } else known = false
  }

  return (
    <ToolCallGroup
      className={cn('min-w-0', animation, opening && 'ks-run-opening')}
      label={label}
      runningLabel={label}
      chevron="before"
      labels={labels}
      time={known}
      duration={summary.running ? undefined : total}
      icons={stackedGlyphs(sessionId, shown).map(({ id, glyph }) => ({
        key: id,
        icon: <Icon icon={glyph} size={14} />,
      }))}
      trail={
        pictures.length > 0 ? <RowThumbs sessionId={sessionId} pictures={pictures} /> : undefined
      }
      onOpenChange={open}
    >
      {shown.map((entry, index) => card(entry, index, !opened || index >= shownSteps))}
    </ToolCallGroup>
  )
}, sameRun)

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
