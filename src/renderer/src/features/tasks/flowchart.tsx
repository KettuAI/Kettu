import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { useTranslation } from 'react-i18next'
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
import { useSessionsStore } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'
import { END_SIZE, headOf, layoutFlow, NODE_H, NODE_W, pathOf, type FlowEdge } from './flow-layout'
import {
  latestRound,
  pickedByText,
  pickLine,
  stepTitle,
  stepWord,
  useModelText,
  whoPicksText,
  type Word,
} from './model'
import { PinEditor } from './pin-editor'

/** Rounds that can still go on, so a step with one cannot be pinned. */
const LIVE = new Set(['queued', 'starting', 'working', 'picking', 'reviewing', 'person', 'stuck'])

/** Above the first row, room for its kind tag. */
const TOP = 32
/** The chart is shown at 100% when it fits, and shrunk no further than this to fit. */
const MIN_FIT = 0.78

interface StepFacts {
  id: string
  name: string
  by: 'agent' | 'you'
  reviews: string[]
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
    round,
    waiting,
    pick: live?.by ?? waiting?.pick?.by ?? view.pins[stepId] ?? round?.by ?? null,
    word: stepWord(summary, view),
    state: summary.state,
  }
}

/** The arrows the task took that an edge stands for, by its outcomes; a review's own by ''. */
function arrowsOf(view: TaskView, edge: FlowEdge) {
  const names = edge.outcomes.length > 0 ? edge.outcomes : ['']
  return view.arrows.filter((a) => a.from === edge.from && names.includes(a.outcome))
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

type StepNodeData = { view: TaskView; stepId: string }
type EndNodeData = { end: TaskEnd; reached: boolean }
type EdgeData = { view: TaskView; edge: FlowEdge }

/**
 * The task's workflow as a flowchart on a canvas that pans and zooms: each step a card with who
 * does it, who picked it and its state, solid arrows for the path taken and quiet ones for the
 * rest, arrows back dashed with how often they were taken. A card opens its step's session; a step
 * not started yet can be pinned from it.
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
  const layout = useMemo(() => layoutFlow(view.workflow), [view.workflow])
  const nodes = useMemo<Node[]>(
    () => [
      ...layout.nodes.map((n) => ({
        id: n.id,
        type: 'step',
        position: { x: n.x, y: n.y },
        width: NODE_W,
        height: NODE_H,
        data: { view, stepId: n.id } satisfies StepNodeData,
      })),
      ...layout.ends.map((e) => ({
        id: `end:${e.end}`,
        type: 'end',
        position: { x: e.x - END_SIZE / 2, y: e.y - END_SIZE / 2 },
        width: END_SIZE,
        height: END_SIZE,
        data: { end: e.end, reached: view.end === e.end } satisfies EndNodeData,
      })),
    ],
    [layout, view],
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

  const box = useRef<HTMLDivElement>(null)
  const flow = useReactFlow()
  const fit = useCallback(() => {
    const el = box.current
    if (!el) return
    const zoom = Math.max(
      MIN_FIT,
      Math.min(
        1,
        el.clientHeight / (layout.height + TOP * 2),
        el.clientWidth / (layout.width + 48),
      ),
    )
    void flow.setViewport({ x: (el.clientWidth - layout.width * zoom) / 2, y: TOP * zoom, zoom })
  }, [flow, layout])
  // Placed again when the chart or the window changes; a pan or zoom stays until then.
  useEffect(() => {
    const el = box.current
    if (!el) return
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    return () => observer.disconnect()
  }, [fit])

  return (
    <div
      ref={box}
      role="group"
      aria-label={view.title}
      className="relative min-h-80 flex-1 overflow-hidden rounded-2xl bg-(--thread-card) shadow-(--thread-card-shadow)"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
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
  const tone = on
    ? edge.back
      ? 'stroke-warning!'
      : 'stroke-(--focus)!'
    : 'stroke-(--thread-line-strong)!'
  const last = edge.points.at(-1)!
  // Into a join the arrow stops at its dot.
  const points = edge.join
    ? [...edge.points.slice(0, -1), [last[0], last[1] - 7] as [number, number]]
    : edge.points
  const step = view.workflow.steps.find((s) => s.id === edge.from)
  // A step with one way forward needs no label on it.
  const labelled = edge.back || (step?.outcomes.length ?? 0) > 1
  const arrow = arrowsOf(view, edge)[0]
  const name = edge.outcomes.length > 0 ? edge.outcomes.join(t('or')) : t('flow.youSendBack')
  const text = edge.back
    ? `${name}${t('separator')}${
        arrow && arrow.taken > 0
          ? t('flow.taken', {
              taken: arrow.taken,
              limit: arrow.limit ?? view.workflow.sendBackLimit,
            })
          : t('flow.upTo', { limit: arrow?.limit ?? view.workflow.sendBackLimit })
      }`
    : name
  return (
    <>
      <BaseEdge
        path={pathOf(points, 14)}
        className={cn(
          tone,
          '[stroke-linecap:round] [stroke-linejoin:round]',
          // React Flow's own stylesheet is unlayered and would win over plain utilities.
          on ? '[stroke-width:1.6]!' : '[stroke-width:1.25]!',
          edge.back && '[stroke-dasharray:4_4]',
        )}
      />
      {edge.back && (
        <path
          d={headOf(points)}
          className={cn(tone, 'fill-none [stroke-linecap:round] [stroke-width:1.25]')}
        />
      )}
      {edge.join && (
        <circle
          cx={last[0]}
          cy={last[1] - 4}
          r={3.5}
          className={on ? 'fill-(--focus)' : 'fill-(--thread-line-strong)'}
        />
      )}
      {labelled && (
        <EdgeLabelRenderer>
          <span
            className={cn(
              'pointer-events-none absolute max-w-60 truncate rounded-[5px] bg-(--thread-card) px-1.5 text-[10.5px] leading-4 font-medium tracking-[0.3px] whitespace-nowrap uppercase shadow-(--thread-card-shadow)',
              on ? (edge.back ? 'text-warning' : 'text-(--focus)') : 'text-(--thread-muted)',
            )}
            style={{
              transform: `translate(${edge.label[0]}px, ${edge.label[1]}px) translate(${
                edge.align === 'center' ? '-50%' : edge.align === 'start' ? '0' : '-100%'
              }, -50%)`,
            }}
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
    <div className="relative flex flex-col items-center">
      <Handle type="target" position={Position.Top} isConnectable={false} className="invisible!" />
      <span
        className={cn(
          'grid place-items-center rounded-full bg-(--thread-card) shadow-(--thread-card-shadow)',
          reached
            ? end === 'done'
              ? 'text-(--thread-done)'
              : 'text-(--shell-faint)'
            : 'text-(--thread-faint)',
        )}
        style={{ width: END_SIZE, height: END_SIZE }}
      >
        {end === 'done' ? (
          <Glyph icon={Tick02Icon} size={13} />
        ) : (
          <span className="size-2 rounded-[2px] bg-current" />
        )}
      </span>
      <span className="absolute top-[calc(100%+6px)] text-[10.5px] font-medium tracking-[0.3px] whitespace-nowrap text-(--thread-muted) uppercase">
        {t(`flow.end.${end}`)}
      </span>
    </div>
  )
}

function StepNode({ data }: NodeProps) {
  const { view, stepId } = data as StepNodeData
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} className="invisible!" />
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className="invisible!"
      />
      <StepCard view={view} facts={factsOf(view, stepId)} />
    </>
  )
}

/** Who does a step on its card: its agent's mark, Auto's spark or you. */
function WhoMark({ facts, hostId }: { facts: StepFacts; hostId: string | null }) {
  return (
    <span className="grid size-6 shrink-0 place-items-center rounded-[7px] bg-(--thread-chip)">
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

/** The small tag over a card: who does the step, or that a review or Auto picks for it. */
function KindTag({ facts }: { facts: StepFacts }) {
  const { t } = useTranslation('tasks')
  const kind =
    facts.by === 'you' ? 'you' : facts.reviews.length > 0 ? 'review' : facts.pick ? 'agent' : 'auto'
  return (
    <span
      className={cn(
        'absolute bottom-[calc(100%+6px)] left-0 rounded-[5px] px-1.5 text-[10px] leading-4 font-medium tracking-[0.5px] uppercase',
        kind === 'you'
          ? 'bg-warning-tint text-warning'
          : kind === 'auto'
            ? 'bg-[color-mix(in_srgb,var(--agent-violet)_12%,transparent)] text-(--agent-violet)'
            : 'bg-(--shell-accent-soft) text-(--focus)',
      )}
    >
      {t(`flow.kind.${kind}`)}
    </span>
  )
}

function StepCard({ view, facts }: { view: TaskView; facts: StepFacts }) {
  const { t } = useTranslation('tasks')
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
        : t('state.waiting')
      : round?.outcome
        ? t('flow.reported', { outcome: round.outcome })
        : round && round.n > 1 && facts.state === 'running'
          ? t('round', { n: round.n })
          : facts.reviews.length > 0
            ? t('flow.reviews', {
                steps: facts.reviews.map((id) => stepTitle(view.workflow, id)).join(t('and')),
              })
            : null
  const who =
    facts.by === 'you'
      ? t('flow.you')
      : facts.pick
        ? pickLine(facts.pick, hostId, models)
        : t('flow.picksAtStart')
  const reason = round?.reason ?? facts.waiting?.pick?.reason
  const action = session
    ? t('asking.open')
    : canPin
      ? view.pins[facts.id]
        ? t('pin.change')
        : t('pin.open')
      : null
  const title =
    [action, reason ? t('timeline.why', { reason }) : null].filter(Boolean).join('\n') || undefined
  const notReached = facts.state === 'not_reached' && !round
  const className = cn(
    'relative flex size-full flex-col gap-2 rounded-[10px] bg-(--thread-card) px-3 pt-3 pb-1.5 text-left shadow-(--thread-card-shadow) outline-none',
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
      <KindTag facts={facts} />
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
        <StateChip facts={facts} />
      </span>
      <span className="truncate pl-8 text-[12.5px] leading-[18px] text-(--thread-text)">
        {picked}
      </span>
      <span className="truncate pl-8 text-[12.5px] leading-[18px] text-(--thread-muted)">
        {now ?? ' '}
      </span>
      <span className="-mx-1.5 mt-auto flex h-8 min-w-0 items-center rounded-[7px] bg-(--thread-chip) px-2">
        <span className="truncate font-mono text-[11px] leading-4 text-(--thread-muted)">
          {who}
        </span>
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
