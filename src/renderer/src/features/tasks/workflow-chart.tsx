// A workflow as the cards of a session draw it: a still chart from the left, each step a tile with
// who does it, its name and a line under it, each on up to two lines rather than cut off; what a
// step does shows on hover. The suggestion card, a task's delivery and the publish card draw it.

import { useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react'
import { SparklesIcon, Tick02Icon, UserIcon } from '@hugeicons/core-free-icons'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { SuggestedTool, Workflow, WorkflowStep } from '@shared/workflow'
import type { AgentId } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import { Glyph } from '@renderer/features/shell/glyph'
import { listOf, localStepName } from '@renderer/features/session/new-session/workflow-picks'
import { cn } from '@renderer/lib/utils'
import { layoutFlow, sideways, type FlowEdge, type FlowMetrics } from './flow-layout'
import { outcomeTitle, whoPicksText } from './model'
import { SidewaysFlow } from './sideways-flow'
import { Phrase } from './phrase'
import { textWidth, wrappedLines } from './wrapped-lines'

/** Steps from the left, each a tile with who does it, its name and one line under it. */
const METRICS: FlowMetrics = {
  nodeW: 44,
  nodeH: 136,
  endSize: 18,
  colGap: 10,
  rowGap: 26,
  laneStart: 20,
  laneGap: 16,
  labelRoom: 0,
  slot: 10,
  inset: 12,
  bend: 8,
  pad: 14,
}
/** Narrower steps for a long chart, so it shrinks less to fit. */
const NARROW: FlowMetrics = { ...METRICS, nodeH: 112, rowGap: 22 }
/** A chart is shrunk to fit the card, but no further than this, so its names stay readable. */
const MIN_FIT = 0.66
// A tile's insides: its padding, who does it and the gap after it, and its two kinds of line.
const TILE_X = 8 + 24 + 8 + 8
const TILE_Y = 10
const NAME = { size: 12, weight: 500, line: 16, lines: 3 }
const UNDER = { size: 11, weight: 400, line: 14, lines: 2 }
/** The widest a name's text grows to keep to its lines. */
const NAME_MAX_W = 112

const nameLines = (name: string, width: number) => wrappedLines(name, NAME.size, NAME.weight, width)

/** The narrowest text width, up to the cap, at which a name takes at most `lines` lines. */
function widthFor(name: string, lines: number): number {
  let low = 0
  let high = NAME_MAX_W
  if (nameLines(name, high) > lines) return high
  while (high - low > 2) {
    const mid = Math.floor((low + high) / 2)
    if (nameLines(name, mid) > lines) low = mid
    else high = mid
  }
  return high
}

export interface WorkflowChartProps {
  workflow: Workflow
  /**
   * The agent that does the first step: the one that suggested or wrote it; none for a workflow
   * shown apart from a conversation, whose every step is picked.
   */
  agentId?: AgentId | null
  agentName?: string
  hostId: string | null
  /** The tools the workflow names, for their titles. */
  tools?: readonly SuggestedTool[]
  className?: string
  chartRef?: Ref<HTMLDivElement>
}

export function WorkflowChart({
  workflow,
  agentId = null,
  agentName = '',
  hostId,
  tools = [],
  className,
  chartRef,
}: WorkflowChartProps) {
  const { t } = useTranslation(['session', 'tasks'])
  const box = useRef<HTMLDivElement>(null)
  const [room, setRoom] = useState(0)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    setRoom(el.clientWidth)
    const observer = new ResizeObserver(() => setRoom(el.clientWidth))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  // A step the user sees says so on its tile, so its send-back is not drawn as a loop.
  const drawn = useMemo(
    () => ({
      ...workflow,
      steps: workflow.steps.map((step) => ({ ...step, youReview: false })),
    }),
    [workflow],
  )
  const metrics = useMemo(() => {
    if (room === 0) return METRICS
    const base = sideways(layoutFlow(drawn, METRICS)).width * 0.85 > room ? NARROW : METRICS
    // Wide enough for every name on two lines when the chart then fits, else on three, so a long
    // chart scrolls as little as it can; as tall as the wordiest tile then needs. No name ends in
    // an ellipsis.
    const names = workflow.steps.map((step) => localStepName(workflow, step.id))
    // A line under a name that fits the widest tile keeps to one line, so a short phrase such as
    // "换一个智能体" is never broken.
    const oneLine = Math.max(
      0,
      ...workflow.steps
        .map((step, index) => stepLine(tools, step, index, t)?.text ?? '')
        .map((text) => Math.ceil(textWidth(text, UNDER.size, UNDER.weight)) + 1)
        .filter((width) => width <= NAME_MAX_W),
    )
    const least = Math.max(base.nodeH - TILE_X, oneLine)
    const two = Math.max(least, ...names.map((name) => widthFor(name, 2)))
    const fits = sideways(layoutFlow(drawn, { ...base, nodeH: TILE_X + two })).width * MIN_FIT
    const width =
      fits <= room - 20 ? two : Math.max(least, ...names.map((name) => widthFor(name, 3)))
    const tallest = Math.max(
      ...workflow.steps.map((step, index) => {
        const name = Math.min(NAME.lines, nameLines(names[index]!, width))
        const under = stepLine(tools, step, index, t)
        const lines = under
          ? Math.min(UNDER.lines, wrappedLines(under.text, UNDER.size, UNDER.weight, width))
          : 0
        return TILE_Y + name * NAME.line + lines * UNDER.line
      }),
    )
    return { ...base, nodeH: TILE_X + width, nodeW: Math.max(base.nodeW, tallest) }
  }, [drawn, workflow, tools, room, t])
  // Only the lanes are named, where there is room; a forward arrow's gap is too short.
  const label = (edge: FlowEdge): string | null =>
    (edge.back || (edge.to === 'end:dropped' && edge.points.length > 4)) && edge.outcomes.length > 0
      ? edge.outcomes.map((o) => outcomeTitle(workflow, edge.from, o)).join(t('tasks:or'))
      : null
  return (
    <div
      ref={box}
      className={cn(
        'flex min-w-0 scroll-fade-x overflow-x-auto rounded-xl bg-(--bg-code-block) bg-[radial-gradient(var(--thread-line-strong)_0.8px,transparent_1px)] bg-size-[14px_14px] px-2 py-1',
        className,
      )}
    >
      {room > 0 && (
        <div ref={chartRef} className="mx-auto shrink-0">
          <SidewaysFlow
            workflow={drawn}
            metrics={metrics}
            scale={(width) => Math.max(MIN_FIT, (room - 20) / width)}
            labelOf={label}
            labelClassName="bg-(--bg-code-block)"
            step={(_, index) => (
              <StepTile
                workflow={workflow}
                tools={tools}
                step={workflow.steps[index]!}
                index={index}
                agentId={agentId}
                agentName={agentName}
                hostId={hostId}
              />
            )}
            end={(end) => (
              <span className="relative grid size-full place-items-center rounded-full bg-card text-(--thread-faint) shadow-(--thread-card-shadow)">
                {end === 'done' ? (
                  <Glyph icon={Tick02Icon} size={11} className="text-(--thread-done)" />
                ) : (
                  <span className="size-1.5 rounded-[2px] bg-current" />
                )}
                {end === 'done' && (
                  <span className="absolute top-[calc(100%+3px)] text-[10px] whitespace-nowrap text-(--thread-muted)">
                    {t('tasks:flow.end.done')}
                  </span>
                )}
              </span>
            )}
          />
        </div>
      )}
    </div>
  )
}

/** The line under a step's name: what the user does there, a second agent, or its tools. */
function stepLine(
  tools: readonly SuggestedTool[],
  step: WorkflowStep,
  index: number,
  t: TFunction<['session', 'tasks']>,
): { text: string; you: boolean } | null {
  if (step.by === 'you') return { text: t('workflow.card.node.yours'), you: true }
  if (step.youReview) {
    return {
      text: t(index === 0 ? 'workflow.card.node.firstSee' : 'workflow.card.node.see'),
      you: true,
    }
  }
  if (step.reviewOf.length > 0) return { text: t('workflow.card.node.other'), you: false }
  const titles = toolTitles(tools, step)
  if (titles.length > 0)
    return { text: t('workflow.card.node.uses', { tools: listOf(titles) }), you: false }
  return null
}

function toolTitles(tools: readonly SuggestedTool[], step: WorkflowStep): string[] {
  const named = [
    ...step.tools.skills.map((ref) => ({ kind: 'skill' as const, ref })),
    ...step.tools.mcp.map((ref) => ({ kind: 'mcp' as const, ref })),
  ]
  return named.map(
    (n) => tools.find((tool) => tool.kind === n.kind && tool.ref === n.ref)?.title ?? n.ref,
  )
}

function StepTile({
  workflow,
  tools,
  step,
  index,
  agentId,
  agentName,
  hostId,
}: {
  workflow: Workflow
  tools: readonly SuggestedTool[]
  step: WorkflowStep
  index: number
  agentId: AgentId | null
  agentName: string
  hostId: string | null
}) {
  const { t } = useTranslation(['session', 'tasks'])
  const name = localStepName(workflow, step.id)
  const line = stepLine(tools, step, index, t)
  const titles = toolTitles(tools, step)
  const who =
    step.by === 'you'
      ? t('workflow.card.tip.yours')
      : index === 0 && agentId
        ? t('workflow.card.tip.first', { agent: agentName })
        : t('workflow.card.tip.picks', { who: whoPicksText({ workflow, pins: {} }, step.id) })
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={250}
        closeDelay={0}
        render={
          <span
            tabIndex={0}
            className="flex size-full min-w-0 cursor-default items-center gap-2 rounded-[9px] bg-card px-2 shadow-(--thread-card-shadow) outline-none focus-visible:ring-[1.5px] focus-visible:ring-(--focus)"
          />
        }
      >
        <WhoMark step={step} index={index} agentId={agentId} hostId={hostId} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="line-clamp-3 text-small leading-4 font-medium break-keep break-words text-(--thread-ink)">
            <Phrase text={name} />
          </span>
          {line && (
            <span
              className={cn(
                'line-clamp-2 text-[11px] leading-3.5 break-keep break-words',
                line.you ? 'text-warning' : 'text-(--thread-muted)',
              )}
            >
              <Phrase text={line.text} />
            </span>
          )}
        </span>
      </HoverCardTrigger>
      <HoverCardContent side="bottom" align="start" sideOffset={6} className="w-72 p-3">
        <div className="flex flex-col gap-1.5 text-meta leading-relaxed">
          <span className="text-ui font-medium text-primary">{name}</span>
          {step.prompt && (
            <span className="line-clamp-5 whitespace-pre-line text-secondary">{step.prompt}</span>
          )}
          {step.youReview && step.by === 'agent' && (
            <span className="text-secondary">{t('workflow.card.tip.see')}</span>
          )}
          {titles.length > 0 && (
            <span className="text-secondary">
              {t('workflow.card.node.uses', { tools: listOf(titles) })}
            </span>
          )}
          <span className="text-tertiary">{who}</span>
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}

/** Who does a step: the user, the first step's agent, or the spark of a pick to come. */
function WhoMark({
  step,
  index,
  agentId,
  hostId,
}: {
  step: WorkflowStep
  index: number
  agentId: AgentId | null
  hostId: string | null
}) {
  return (
    <span
      className={cn(
        'grid size-6 shrink-0 place-items-center rounded-[7px]',
        step.by === 'you' ? 'bg-warning-tint text-warning' : 'bg-(--thread-chip)',
      )}
    >
      {step.by === 'you' ? (
        <Glyph icon={UserIcon} size={12} />
      ) : index === 0 && agentId ? (
        <AgentMark agent={agentId} size={12} hostId={hostId} />
      ) : (
        <Glyph icon={SparklesIcon} size={12} className="text-(--agent-violet)" />
      )}
    </span>
  )
}
