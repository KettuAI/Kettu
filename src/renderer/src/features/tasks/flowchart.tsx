import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type Viewport,
} from '@xyflow/react'
import '@xyflow/react/dist/base.css'
import {
  Add01Icon,
  ArrowExpand01Icon,
  MinusSignIcon,
  SparklesIcon,
  Tick02Icon,
  UserIcon,
} from '@hugeicons/core-free-icons'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { RoundView, StepPick, TaskEnd, TaskView, WaitingView } from '@shared/workflow'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Badge } from '@renderer/components/ui/badge'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { TurnDots } from '@renderer/features/session/turn-dots'
import { Glyph } from '@renderer/features/shell/glyph'
import { runningFor } from '@renderer/lib/format'
import { hostOfPath } from '@renderer/lib/host-paths'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useAgentOptionsStore } from '@renderer/stores/agent-options'
import { useSessionsStore } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'
import { useChartMorph, type ChartRect } from './chart-morph'
import {
  headOf,
  intoJoin,
  laneMiddle,
  layoutFlow,
  pathOf,
  sideways,
  type FlowEdge,
  type FlowLayout,
  type FlowMetrics,
} from './flow-layout'
import {
  latestRound,
  modelTextOf,
  outcomeTitle,
  pickedByText,
  pickLine,
  stepTitle,
  stepWord,
  useModelText,
  whoPicksText,
  type Word,
} from './model'
import { PinEditor } from './pin-editor'
import { textWidth } from './wrapped-lines'

/** Rounds that can still go on, so a step with one cannot be pinned. */
const LIVE = new Set(['queued', 'starting', 'working', 'picking', 'reviewing', 'person', 'stuck'])

/**
 * The chart runs from the left as the suggestion card's does, on the same layout: `nodeH` is a
 * step's width once turned, `nodeW` its height, `rowGap` the room between columns and `colGap`
 * between steps stacked in one.
 */
const METRICS: FlowMetrics = {
  nodeW: 90,
  nodeH: 200,
  endSize: 28,
  colGap: 20,
  rowGap: 48,
  laneStart: 34,
  laneGap: 20,
  labelRoom: 0,
  slot: 16,
  inset: 24,
  bend: 16,
  pad: 16,
}
// A step's width: its padding and who does it with the gap after it, around its widest line.
const NODE_X = 12 + 12 + 24 + 8 + 2
const NODE_MIN_W = 156
const NODE_MAX_W = 280
/** The chart is shown at 100% when it fits, and shrunk no further than this to fit. */
const MIN_FIT = 0.78
/** Room kept around the chart when it is placed, and above it when the pane has more. */
const MARGIN = 32
const TOP = 48

interface StepFacts {
  id: string
  name: string
  by: 'agent' | 'you'
  reviews: string[]
  youReview: boolean
  round: RoundView | undefined
  waiting: WaitingView | undefined
  /** Who does it or will: the round's agent, a pick made ahead, or this task's pin. */
  pick: StepPick | null
  word: Word | null
  state: TaskView['steps'][number]['state']
}

function factsOf(view: TaskView, stepId: string): StepFacts {
  const step = view.workflow.steps.find((s) => s.id === stepId)!
  const summary = view.steps.find((s) => s.id === stepId)!
  const round = latestRound(view, stepId)
  const waiting = view.waiting.find((w) => w.stepId === stepId)
  const live = round && round.state !== 'stopped' ? round : undefined
  return {
    id: stepId,
    name: stepTitle(view.workflow, stepId),
    by: step.by,
    reviews: step.reviewOf,
    youReview: step.youReview,
    round,
    waiting,
    pick: live?.by ?? waiting?.pick?.by ?? view.pins[stepId] ?? round?.by ?? null,
    word: stepWord(summary, view),
    state: summary.state,
  }
}

/** Who does a step, under its name: you, its agent and model, or a pick to come; and a review. */
function whoLine(
  facts: StepFacts,
  hostId: string | null,
  models: { model: string | null; effort: string | null },
  t: TFunction<['tasks', 'session']>,
): string {
  const who =
    facts.by === 'you'
      ? t('session:workflow.card.node.yours')
      : facts.pick
        ? pickLine(facts.pick, hostId, { model: models.model, effort: null })
        : t('flow.picksAtStart')
  return facts.reviews.length > 0
    ? `${who}${t('separator')}${t('session:workflow.card.node.other')}`
    : who
}

/** Beside a step's state: that you see it, and its round once it was sent back. */
function besideText(
  facts: StepFacts,
  index: number,
  t: TFunction<['tasks', 'session']>,
): [see: string | null, again: string | null] | null {
  const see = facts.youReview
    ? t(index === 0 ? 'session:workflow.card.node.firstSee' : 'session:workflow.card.node.see')
    : null
  const again = facts.round && facts.round.n > 1 ? t('round', { n: facts.round.n }) : null
  return see || again ? [see, again] : null
}

/** The arrows the task took that an edge stands for, by its outcomes. */
function arrowsOf(view: TaskView, edge: FlowEdge) {
  return view.arrows.filter((a) => a.from === edge.from && edge.outcomes.includes(a.outcome))
}

const taken = (view: TaskView, edge: FlowEdge) =>
  arrowsOf(view, edge).some((arrow) => arrow.taken > 0)

/** The steps a waiting step still waits on: those leading to it that are not done. */
function waitsOn(view: TaskView, stepId: string): string[] {
  return view.workflow.steps
    .filter((s) => s.outcomes.some((o) => o.to.includes(stepId)) && s.id !== stepId)
    .filter((s) => {
      const state = view.steps.find((x) => x.id === s.id)?.state
      return state === 'running' || state === 'needs_you' || state === 'waiting'
    })
    .map((s) => stepTitle(view.workflow, s.id))
}

/**
 * Where the chart sits in a pane of `size`: at 100% when it fits, else shrunk to fit down to
 * MIN_FIT; centred across, or past that kept on `focusX`, the step at work; near the top.
 */
function placement(
  layout: FlowLayout,
  size: { width: number; height: number },
  focusX: number,
): Viewport {
  const zoom = Math.max(
    MIN_FIT,
    Math.min(
      1,
      (size.width - MARGIN * 2) / layout.width,
      (size.height - MARGIN * 2) / layout.height,
    ),
  )
  const width = layout.width * zoom
  const height = layout.height * zoom
  const x =
    width <= size.width - MARGIN * 2
      ? (size.width - width) / 2
      : Math.min(MARGIN, Math.max(size.width - MARGIN - width, size.width / 2 - focusX * zoom))
  const y = height + MARGIN * 2 > size.height ? MARGIN : Math.min(TOP, (size.height - height) / 2)
  return { x, y, zoom }
}

type StepNodeData = { view: TaskView; stepId: string; index: number; who: string }
type EndNodeData = { end: TaskEnd; reached: boolean }
type EdgeData = { view: TaskView; edge: FlowEdge }

/**
 * The task's workflow as a flowchart from the left, the suggestion card's chart at work, on a
 * canvas that pans and zooms: each step with who does it and its state, solid arrows for the path
 * taken and quiet ones for the rest, arrows back and early ends dashed on lanes below and above,
 * with how often they were taken. A step opens its session; one not started yet can be pinned.
 */
export function Flowchart({ view }: { view: TaskView }) {
  return (
    <ReactFlowProvider>
      <Canvas view={view} />
    </ReactFlowProvider>
  )
}

const NODE_TYPES = { step: StepNode, end: EndNode }
const EDGE_TYPES = { flow: FlowArrow }

function Canvas({ view }: { view: TaskView }) {
  const { t } = useTranslation(['tasks', 'session'])
  const hostId = hostOfPath(view.projectPath)
  // A step the user sees says so on its node, so its send-back is not drawn as a loop.
  const drawn = useMemo(
    () => ({
      ...view.workflow,
      steps: view.workflow.steps.map((step) => ({ ...step, youReview: false })),
    }),
    [view.workflow],
  )
  const who = useAgentOptionsStore(
    useShallow((s) =>
      view.workflow.steps.map((step) => {
        const facts = factsOf(view, step.id)
        return whoLine(facts, hostId, modelTextOf(s, hostId, facts.pick), t)
      }),
    ),
  )
  // Each step as wide as its words need, within bounds, a column as its widest; the state's pill
  // as wide as Not started, so a step keeps its width as it runs. Longer words are cut, and whole
  // in its title.
  const lengths = useMemo(() => {
    const chip = textWidth(t('flow.notStarted'), 11, 600) + 16
    return new Map(
      view.workflow.steps.map((step, i) => {
        const beside = besideText(factsOf(view, step.id), i, t)
        const words = Math.max(
          textWidth(stepTitle(view.workflow, step.id), 13, 500),
          textWidth(who[i]!, 12, 400),
          chip + (beside ? 6 + textWidth(beside.join(t('separator')), 11, 400) : 0),
        )
        return [step.id, Math.min(NODE_MAX_W, Math.max(NODE_MIN_W, Math.ceil(words) + NODE_X))]
      }),
    )
  }, [view, who, t])
  const layout = useMemo(
    () => sideways(layoutFlow(drawn, METRICS, (id) => lengths.get(id) ?? METRICS.nodeH)),
    [drawn, lengths],
  )
  const nodes = useMemo<Node[]>(
    () => [
      ...layout.nodes.map((n) => ({
        id: n.id,
        type: 'step',
        position: { x: n.x, y: n.y },
        width: n.length,
        height: METRICS.nodeW,
        data: {
          view,
          stepId: n.id,
          index: view.workflow.steps.findIndex((s) => s.id === n.id),
          who: who[view.workflow.steps.findIndex((s) => s.id === n.id)] ?? '',
        } satisfies StepNodeData,
      })),
      ...layout.ends.map((e) => ({
        id: `end:${e.end}`,
        type: 'end',
        position: { x: e.x - METRICS.endSize / 2, y: e.y - METRICS.endSize / 2 },
        width: METRICS.endSize,
        height: METRICS.endSize,
        data: { end: e.end, reached: view.end === e.end } satisfies EndNodeData,
      })),
    ],
    [layout, view, who],
  )
  // Quiet arrows first, so the path taken is drawn over them.
  const edges = useMemo<Edge[]>(
    () =>
      [...layout.edges]
        .sort((a, b) => Number(taken(view, a)) - Number(taken(view, b)))
        .map((edge) => ({
          id: edge.id,
          source: edge.from,
          target: edge.to,
          type: 'flow',
          data: { view, edge } satisfies EdgeData,
        })),
    [layout, view],
  )
  // The step at work, which a chart too wide for the pane is placed on.
  const focusX = useMemo(() => {
    const lit = view.steps.find(
      (s) => s.state === 'running' || s.state === 'needs_you' || s.state === 'error',
    )
    const node = layout.nodes.find((n) => n.id === (lit ?? view.steps[0])?.id)
    return node ? node.x + node.length / 2 : 0
  }, [view.steps, layout])

  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const read = () =>
      setSize((was) =>
        was?.width === el.clientWidth && was.height === el.clientHeight
          ? was
          : { width: el.clientWidth, height: el.clientHeight },
      )
    read()
    const observer = new ResizeObserver(read)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const flow = useReactFlow()
  // The step at work when the chart is placed again; a step starting moves nothing by itself.
  const focus = useRef(focusX)
  useEffect(() => {
    focus.current = focusX
  }, [focusX])
  const fit = useCallback(() => {
    if (size) void flow.setViewport(placement(layout, size, focus.current))
  }, [flow, layout, size])
  // Placed again when the chart or the pane changes; a pan or zoom stays until then.
  useEffect(fit, [fit])
  // Started from a suggestion card, the chart grows out of the card's.
  useChartMorph(view.id, box, size !== null, (): ChartRect | null => {
    const el = box.current
    if (!el || !size) return null
    const at = placement(layout, size, focusX)
    const rect = el.getBoundingClientRect()
    return {
      left: rect.left + at.x,
      top: rect.top + at.y,
      width: layout.width * at.zoom,
      height: layout.height * at.zoom,
    }
  })

  return (
    <div
      ref={box}
      role="group"
      aria-label={view.title}
      className="relative min-h-80 flex-1 origin-top-left overflow-hidden rounded-2xl bg-(--thread-card) shadow-(--thread-card-shadow)"
    >
      {size && (
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          defaultViewport={placement(layout, size, focusX)}
          minZoom={0.3}
          maxZoom={1.5}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          zoomOnScroll={false}
          zoomOnDoubleClick={false}
          panOnScroll
          proOptions={{ hideAttribution: true }}
          className="[&_.react-flow__pane]:cursor-grab"
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={16}
            size={1.1}
            color="var(--thread-line-strong)"
          />
          <ZoomControls onFit={fit} />
        </ReactFlow>
      )}
    </div>
  )
}

function ZoomControls({ onFit }: { onFit: () => void }) {
  const { t } = useTranslation('tasks')
  const flow = useReactFlow()
  const button =
    'grid size-7 place-items-center rounded-md text-(--thread-muted) outline-none hover:bg-(--thread-chip) hover:text-(--thread-ink) focus-visible:ring-[1.5px] focus-visible:ring-(--focus)'
  const actions = [
    { label: t('flow.zoomOut'), icon: MinusSignIcon, run: () => void flow.zoomOut() },
    { label: t('flow.zoomIn'), icon: Add01Icon, run: () => void flow.zoomIn() },
    { label: t('flow.fit'), icon: ArrowExpand01Icon, run: onFit },
  ]
  return (
    <Panel
      position="bottom-left"
      className="flex items-center gap-0.5 rounded-lg bg-(--thread-card) p-0.5 shadow-(--thread-card-shadow)"
    >
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          aria-label={action.label}
          title={action.label}
          className={button}
          onClick={action.run}
        >
          <Glyph icon={action.icon} size={14} />
        </button>
      ))}
    </Panel>
  )
}

function FlowArrow({ data }: EdgeProps) {
  const { view, edge } = data as EdgeData
  const { t } = useTranslation('tasks')
  const on = taken(view, edge)
  // An arrow to the early end runs above the steps like one back, so it is dashed as they are.
  const dashed = edge.back || edge.to === 'end:dropped'
  const tone = on
    ? edge.back
      ? 'stroke-warning!'
      : 'stroke-(--focus)!'
    : 'stroke-(--thread-line-strong)!'
  const { points, dot } = edge.join ? intoJoin(edge.points) : { points: edge.points, dot: null }
  // Only the lanes are named; a forward arrow's gap is too short for words.
  const lane = edge.back || (edge.to === 'end:dropped' && edge.points.length > 4)
  const arrow = arrowsOf(view, edge)[0]
  const name = edge.outcomes.map((o) => outcomeTitle(view.workflow, edge.from, o)).join(t('or'))
  const text = !lane
    ? null
    : edge.back
      ? `${name}${t('separator')}${
          arrow && arrow.taken > 0
            ? t('flow.taken', {
                taken: arrow.taken,
                limit: arrow.limit ?? view.workflow.sendBackLimit,
              })
            : t('flow.upTo', { limit: arrow?.limit ?? view.workflow.sendBackLimit })
        }`
      : name
  const [x, y] = laneMiddle(edge.points)
  return (
    <>
      <BaseEdge
        path={pathOf(points, 10)}
        className={cn(
          tone,
          '[stroke-linecap:round] [stroke-linejoin:round]',
          // React Flow's own stylesheet is unlayered and would win over plain utilities.
          on ? '[stroke-width:1.6]!' : '[stroke-width:1.25]!',
          dashed && '[stroke-dasharray:4_4]',
        )}
      />
      {!edge.join && (
        <path
          d={headOf(points)}
          className={cn(tone, 'fill-none [stroke-linecap:round] [stroke-width:1.25]')}
        />
      )}
      {dot && (
        <circle
          cx={dot[0]}
          cy={dot[1]}
          r={3.5}
          className={on ? 'fill-(--focus)' : 'fill-(--thread-line-strong)'}
        />
      )}
      {text && (
        <EdgeLabelRenderer>
          <span
            className={cn(
              'pointer-events-none absolute max-w-60 truncate rounded-[5px] px-1.5 text-[11px] leading-4 whitespace-nowrap',
              on && edge.back
                ? 'bg-warning-tint text-warning'
                : 'bg-(--thread-card) text-(--thread-muted)',
            )}
            style={{ transform: `translate(${x}px, ${y}px) translate(-50%, -50%)` }}
          >
            {text}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

function EndNode({ data }: NodeProps) {
  const { end, reached } = data as EndNodeData
  const { t } = useTranslation('tasks')
  return (
    <div className="relative flex size-full flex-col items-center">
      <Handle type="target" position={Position.Left} isConnectable={false} className="invisible!" />
      <span
        className={cn(
          'grid size-full place-items-center rounded-full bg-(--thread-card) shadow-(--thread-card-shadow)',
          reached
            ? end === 'done'
              ? 'text-(--thread-done)'
              : 'text-(--shell-faint)'
            : 'text-(--thread-faint)',
        )}
      >
        {end === 'done' ? (
          <Glyph icon={Tick02Icon} size={13} />
        ) : (
          <span className="size-2 rounded-[2px] bg-current" />
        )}
      </span>
      <span className="absolute top-[calc(100%+5px)] text-[11px] whitespace-nowrap text-(--thread-muted)">
        {t(`flow.end.${end}`)}
      </span>
    </div>
  )
}

function StepNode({ data }: NodeProps) {
  const { view, stepId, index, who } = data as StepNodeData
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} className="invisible!" />
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        className="invisible!"
      />
      <StepCard view={view} facts={factsOf(view, stepId)} index={index} who={who} />
    </>
  )
}

/** Who does a step on its card: its agent's mark, Auto's spark or you. */
function WhoMark({ facts, hostId }: { facts: StepFacts; hostId: string | null }) {
  return (
    <span
      className={cn(
        'grid size-6 shrink-0 place-items-center rounded-[7px]',
        facts.by === 'you' ? 'bg-warning-tint text-warning' : 'bg-(--thread-chip)',
      )}
    >
      {facts.by === 'you' ? (
        <Glyph icon={UserIcon} size={13} />
      ) : facts.pick ? (
        <AgentMark agent={facts.pick.agentId} size={13} hostId={hostId} />
      ) : (
        <Glyph icon={SparklesIcon} size={13} className="text-(--agent-violet)" />
      )}
    </span>
  )
}

function StepCard({
  view,
  facts,
  index,
  who,
}: {
  view: TaskView
  facts: StepFacts
  index: number
  who: string
}) {
  const { t } = useTranslation(['tasks', 'session'])
  const [pinning, setPinning] = useState(false)
  const hostId = hostOfPath(view.projectPath)
  const models = useModelText(hostId, facts.pick)
  const sessionId = facts.round?.sessionId
  const session = useSessionsStore((s) => (sessionId ? s.byId[sessionId] : undefined))
  const live = view.rounds.some((r) => r.stepId === facts.id && LIVE.has(r.state))
  const canPin = !session && view.status === 'running' && facts.by === 'agent' && !live
  const round = facts.round
  const picked =
    facts.by === 'you'
      ? t('flow.yourCall')
      : round
        ? pickedByText(round.pickedBy, view)
        : facts.waiting?.pick
          ? pickedByText(facts.waiting.pick.pickedBy, view)
          : whoPicksText(view, facts.id)
  const on = facts.state === 'waiting' ? waitsOn(view, facts.id) : []
  const now =
    facts.state === 'waiting'
      ? on.length > 0
        ? t('flow.waitingOn', { steps: on.join(t('and')) })
        : null
      : round?.outcome
        ? t('flow.reported', { outcome: outcomeTitle(view.workflow, facts.id, round.outcome) })
        : facts.reviews.length > 0
          ? t('flow.reviews', {
              steps: facts.reviews.map((id) => stepTitle(view.workflow, id)).join(t('and')),
            })
          : null
  const [see, again] = besideText(facts, index, t) ?? [null, null]
  const reason = round?.reason ?? facts.waiting?.pick?.reason
  const action = session
    ? t('asking.open')
    : canPin
      ? view.pins[facts.id]
        ? t('pin.change')
        : t('pin.open')
      : null
  const title = [
    facts.name,
    facts.pick ? pickLine(facts.pick, hostId, models) : who,
    picked,
    now,
    reason ? t('timeline.why', { reason }) : null,
    action,
  ]
    .filter(Boolean)
    .join('\n')
  const notReached = facts.state === 'not_reached' && !round
  const className = cn(
    'relative flex size-full flex-col justify-center gap-1 rounded-[10px] bg-(--thread-card) px-3 py-2.5 text-left shadow-(--thread-card-shadow) outline-none',
    action &&
      'cursor-pointer hover:shadow-(--shell-card-shadow-hover) focus-visible:ring-[1.5px] focus-visible:ring-(--focus)',
    facts.state === 'running' &&
      'shadow-[0_0_0_1px_var(--focus),0_0_0_4px_var(--shell-accent-soft)]',
    facts.state === 'waiting' &&
      'bg-transparent shadow-none outline-1 -outline-offset-1 outline-(--thread-line-strong) outline-dashed',
    pinning && 'shadow-[0_0_0_1.5px_var(--focus),0_0_0_4.5px_var(--shell-accent-soft)]',
  )
  const body = (
    <>
      <span className="flex h-6 min-w-0 items-center gap-2">
        <WhoMark facts={facts} hostId={hostId} />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[13px] leading-5 font-medium',
            notReached ? 'text-(--thread-muted)' : 'text-(--thread-ink)',
          )}
        >
          {facts.name}
        </span>
      </span>
      <span
        className={cn(
          'truncate pl-8 text-[12px] leading-4',
          facts.by === 'you' ? 'text-warning' : 'text-(--thread-muted)',
        )}
      >
        {who}
      </span>
      <span className="mt-0.5 flex h-5 min-w-0 items-center gap-1.5 pl-8">
        <StateChip facts={facts} />
        {(see || again) && (
          <span className="min-w-0 truncate text-caption text-(--thread-muted)">
            {see && <span className="text-warning">{see}</span>}
            {see && again && t('separator')}
            {again}
          </span>
        )}
      </span>
    </>
  )
  if (session) {
    return (
      <button
        type="button"
        title={title}
        onClick={() => openSession(session.id, session.projectPath)}
        className={className}
      >
        {body}
      </button>
    )
  }
  if (canPin) {
    return (
      <Popover open={pinning} onOpenChange={setPinning}>
        <PopoverTrigger render={<button type="button" title={title} className={className} />}>
          {body}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto max-w-[min(32rem,90vw)]">
          <span className="px-0.5 text-small font-medium text-(--thread-ink)">{facts.name}</span>
          <PinEditor view={view} stepId={facts.id} onDone={() => setPinning(false)} />
        </PopoverContent>
      </Popover>
    )
  }
  return (
    <div title={title} className={className}>
      {body}
    </div>
  )
}

/** A step's state in a small pill: done and running with their time, the rest in a word. */
function StateChip({ facts }: { facts: StepFacts }) {
  const { t } = useTranslation('tasks')
  const now = useNow()
  const round = facts.round
  const time =
    round?.startedAt != null ? runningFor((round.endedAt ?? now) - round.startedAt) : null
  if (facts.state === 'waiting') return <Badge variant="neutral">{t('state.waiting')}</Badge>
  if (!facts.word) return <Badge variant="neutral">{t('flow.notStarted')}</Badge>
  const variant =
    facts.state === 'done'
      ? 'success'
      : facts.state === 'running'
        ? 'info'
        : facts.state === 'error'
          ? 'error'
          : 'warning'
  return (
    <Badge variant={variant} className="min-w-0 tabular-nums">
      {facts.state === 'running' && <TurnDots phase="working" />}
      {facts.state === 'done' && <Glyph icon={Tick02Icon} size={11} />}
      <span className="truncate">
        {(facts.state === 'done' || facts.state === 'running') && time
          ? time
          : t(`state.${facts.word}`)}
      </span>
    </Badge>
  )
}
