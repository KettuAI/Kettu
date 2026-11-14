import { useMemo, useRef, useState, type ReactNode } from 'react'
import { SparklesIcon, Tick02Icon, UserIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { RoundView, StepPick, TaskView, WaitingView } from '@shared/sop'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { TurnDots } from '@renderer/features/session/turn-dots'
import { Glyph } from '@renderer/features/shell/glyph'
import { runningFor } from '@renderer/lib/format'
import { hostOfPath } from '@renderer/lib/host-paths'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useSessionsStore } from '@renderer/stores/sessions'
import { prefersReducedMotion } from '@renderer/stores/settings'
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

interface StepFacts {
  id: string
  name: string
  by: 'agent' | 'you'
  round: RoundView | undefined
  waiting: WaitingView | undefined
  /** Who does it or will: the round's agent, a pick made ahead, or this task's pin. */
  pick: StepPick | null
  word: Word | null
  state: TaskView['steps'][number]['state']
}

function factsOf(view: TaskView, stepId: string): StepFacts {
  const step = view.sop.steps.find((s) => s.id === stepId)!
  const summary = view.steps.find((s) => s.id === stepId)!
  const round = latestRound(view, stepId)
  const waiting = view.waiting.find((w) => w.stepId === stepId)
  const live = round && round.state !== 'stopped' ? round : undefined
  return {
    id: stepId,
    name: stepTitle(view.sop, stepId),
    by: step.by,
    round,
    waiting,
    pick: live?.by ?? waiting?.pick?.by ?? view.pins[stepId] ?? round?.by ?? null,
    word: stepWord(summary, view),
    state: summary.state,
  }
}

/** The step a flowchart selects first: the one that needs you, else the one at work, else the furthest. */
function firstSelected(view: TaskView): string {
  const order = view.sop.steps.map((s) => view.steps.find((x) => x.id === s.id)!)
  return (
    order.find((s) => s.state === 'needs_you' || s.state === 'error')?.id ??
    order.find((s) => s.state === 'running')?.id ??
    (view.at !== null ? view.sop.steps[view.at - 1]?.id : undefined) ??
    view.sop.steps[0]!.id
  )
}

/**
 * The task's SOP as a flowchart: each step with who does it and its state, solid arrows for the
 * path taken and quiet ones for the rest, arrows back dashed with how often they were taken; the
 * step picked shows its details under the chart.
 */
export function Flowchart({ view }: { view: TaskView }) {
  const layout = useMemo(() => layoutFlow(view.sop), [view.sop])
  const [selected, setSelected] = useState(() => firstSelected(view))
  const details = useRef<HTMLDivElement>(null)
  // A step picked on a tall chart shows its details, which sit under it.
  const select = (id: string) => {
    setSelected(id)
    requestAnimationFrame(() =>
      details.current?.scrollIntoView({
        block: 'nearest',
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      }),
    )
  }
  const taken = (edge: FlowEdge) => arrowsOf(view, edge).some((arrow) => arrow.taken > 0)
  // Quiet arrows first, so the path taken is drawn over them.
  const edges = [...layout.edges].sort((a, b) => Number(taken(a)) - Number(taken(b)))
  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto pb-1">
        <div
          role="group"
          aria-label={view.title}
          className="relative mx-auto"
          style={{ width: layout.width, height: layout.height }}
        >
          <svg
            aria-hidden
            width={layout.width}
            height={layout.height}
            className="pointer-events-none absolute inset-0 fill-none"
          >
            {edges.map((edge) => (
              <Arrow key={edge.id} edge={edge} taken={taken(edge)} />
            ))}
            {layout.edges
              .filter((edge) => edge.join)
              .map((edge) => (
                <circle
                  key={`dot:${edge.id}`}
                  cx={edge.points.at(-1)![0]}
                  cy={edge.points.at(-1)![1] - 6}
                  r={3}
                  className={taken(edge) ? 'fill-(--focus)' : 'fill-(--thread-line-strong)'}
                />
              ))}
          </svg>
          {layout.nodes.map((node) => (
            <Node
              key={node.id}
              view={view}
              facts={factsOf(view, node.id)}
              selected={selected === node.id}
              onSelect={() => select(node.id)}
              style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H }}
            />
          ))}
          {layout.edges.map((edge) => (
            <EdgeLabel key={`label:${edge.id}`} view={view} edge={edge} taken={taken(edge)} />
          ))}
          {layout.ends.map((end) => (
            <EndMark
              key={end.end}
              end={end.end}
              reached={view.end === end.end}
              style={{ left: end.x, top: end.y }}
            />
          ))}
        </div>
      </div>
      <div ref={details} className="scroll-mb-4">
        <NodeDetails key={selected} view={view} facts={factsOf(view, selected)} />
      </div>
    </div>
  )
}

function Arrow({ edge, taken }: { edge: FlowEdge; taken: boolean }) {
  const tone = taken
    ? edge.back
      ? 'stroke-warning'
      : 'stroke-(--focus)'
    : 'stroke-(--thread-line-strong)'
  // Into an end the arrow stops at its ring; into a join, at the dot.
  const points = edge.join
    ? [...edge.points.slice(0, -1), [edge.points.at(-1)![0], edge.points.at(-1)![1] - 9] as const]
    : edge.points
  return (
    <g className={cn(tone, '[stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.5]')}>
      <path
        d={pathOf(points as [number, number][])}
        className={cn(edge.back && '[stroke-dasharray:4_4]')}
      />
      {!edge.join && <path d={headOf(points as [number, number][])} />}
    </g>
  )
}

/** The arrows the task took that an edge stands for, by its outcomes; a review's own by ''. */
function arrowsOf(view: TaskView, edge: FlowEdge) {
  const names = edge.outcomes.length > 0 ? edge.outcomes : ['']
  return view.arrows.filter((a) => a.from === edge.from && names.includes(a.outcome))
}

/** An arrow's outcomes, and on an arrow back how often it was taken of how often it may be. */
function EdgeLabel({ view, edge, taken }: { view: TaskView; edge: FlowEdge; taken: boolean }) {
  const { t } = useTranslation('tasks')
  const step = view.sop.steps.find((s) => s.id === edge.from)
  // A step with one way forward needs no label on it.
  if (!edge.back && (step?.outcomes.length ?? 0) < 2) return null
  const arrow = arrowsOf(view, edge)[0]
  const name = edge.outcomes.length > 0 ? edge.outcomes.join(t('or')) : t('flow.youSendBack')
  const text = edge.back
    ? `${name}${t('separator')}${
        arrow && arrow.taken > 0
          ? t('flow.taken', { taken: arrow.taken, limit: arrow.limit ?? view.sop.sendBackLimit })
          : t('flow.upTo', { limit: arrow?.limit ?? view.sop.sendBackLimit })
      }`
    : name
  return (
    <span
      className={cn(
        'pointer-events-none absolute z-2 max-w-48 truncate rounded-[5px] px-1.5 text-[11px] leading-4 font-medium whitespace-nowrap',
        edge.align === 'center'
          ? '-translate-1/2'
          : edge.align === 'start'
            ? '-translate-y-1/2'
            : '-translate-x-full -translate-y-1/2',
        edge.back && taken
          ? 'bg-warning-tint text-warning'
          : 'bg-(--bg-app) text-(--thread-muted) shadow-(--thread-card-shadow)',
        !edge.back && taken && 'text-(--focus)',
      )}
      style={{ left: edge.label[0], top: edge.label[1] }}
    >
      {text}
    </span>
  )
}

function EndMark({
  end,
  reached,
  style,
}: {
  end: 'done' | 'dropped'
  reached: boolean
  style: React.CSSProperties
}) {
  const { t } = useTranslation('tasks')
  return (
    <span
      className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1"
      style={style}
    >
      <span
        className={cn(
          'grid place-items-center rounded-full border-[1.5px]',
          reached
            ? end === 'done'
              ? 'border-(--thread-done) text-(--thread-done)'
              : 'border-(--shell-faint) text-(--shell-faint)'
            : 'border-(--thread-line-strong) text-(--thread-faint)',
        )}
        style={{ width: END_SIZE, height: END_SIZE }}
      >
        {reached && end === 'done' ? (
          <Glyph icon={Tick02Icon} size={14} />
        ) : (
          <span className="size-2 rounded-full bg-current" />
        )}
      </span>
      <span className="text-hint text-(--thread-muted)">{t(`flow.end.${end}`)}</span>
    </span>
  )
}

/** Who does a step on its node: its agent's mark, Auto's spark or you. */
function WhoMark({ facts, hostId }: { facts: StepFacts; hostId: string | null }) {
  return (
    <span className="grid size-6.5 shrink-0 place-items-center rounded-lg bg-(--thread-chip)">
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

function Node({
  view,
  facts,
  selected,
  onSelect,
  style,
}: {
  view: TaskView
  facts: StepFacts
  selected: boolean
  onSelect: () => void
  style: React.CSSProperties
}) {
  const { t } = useTranslation('tasks')
  const hostId = hostOfPath(view.projectPath)
  const models = useModelText(hostId, facts.pick)
  const who =
    facts.by === 'you'
      ? t('flow.you')
      : facts.pick
        ? (models.model ?? pickLine(facts.pick, hostId, { model: null, effort: null }))
        : t('flow.auto')
  const line =
    facts.by === 'you'
      ? t('flow.yourCall')
      : facts.round
        ? pickedByText(facts.round.pickedBy, view)
        : facts.waiting?.pick
          ? pickedByText(facts.waiting.pick.pickedBy, view)
          : whoPicksText(view, facts.id)
  const notReached = facts.state === 'not_reached' && !facts.round
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      style={style}
      className={cn(
        'absolute z-1 flex flex-col gap-1.5 rounded-xl bg-(--thread-card) px-3 py-2.5 text-left shadow-(--thread-card-shadow) outline-none hover:shadow-(--shell-card-shadow-hover) focus-visible:ring-[1.5px] focus-visible:ring-(--focus)',
        facts.state === 'running' && 'shadow-[0_0_0_1px_var(--focus)]',
        facts.state === 'waiting' &&
          'bg-transparent shadow-none outline-1 outline-(--thread-line-strong) outline-dashed',
        selected && 'shadow-[0_0_0_1.5px_var(--focus),0_0_0_4.5px_var(--shell-accent-soft)]',
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <WhoMark facts={facts} hostId={hostId} />
        <span className="flex min-w-0 flex-col">
          <span
            className={cn(
              'truncate text-small font-medium text-(--thread-ink)',
              notReached && 'text-(--thread-muted)',
            )}
          >
            {facts.name}
          </span>
          <span className="truncate text-[11.5px] text-(--thread-muted)">{who}</span>
        </span>
      </span>
      <span className="truncate text-hint text-(--thread-text)">{line}</span>
      <span className="flex min-w-0 items-center gap-1.5">
        <StateBadge facts={facts} view={view} />
      </span>
    </button>
  )
}

/** A step's state in a pill, with its time or round where it has one. */
function StateBadge({ facts, view }: { facts: StepFacts; view: TaskView }) {
  const { t } = useTranslation('tasks')
  const now = useNow()
  const round = facts.round
  const time =
    round?.startedAt != null ? runningFor((round.endedAt ?? now) - round.startedAt) : null
  if (facts.state === 'waiting') {
    const on = waitsOn(view, facts.id)
    return (
      <Badge variant="neutral">
        {on.length > 0 ? t('flow.waitingOn', { steps: on.join(t('and')) }) : t('state.waiting')}
      </Badge>
    )
  }
  if (!facts.word) return <Badge variant="neutral">{t('flow.notStarted')}</Badge>
  const label = t(`state.${facts.word}`)
  const extra =
    round && round.n > 1 ? t('round', { n: round.n }) : facts.state === 'done' ? time : null
  return (
    <>
      <Badge
        variant={
          facts.state === 'done'
            ? 'success'
            : facts.state === 'running'
              ? 'info'
              : facts.state === 'error'
                ? 'error'
                : 'warning'
        }
        className="min-w-0"
      >
        {facts.state === 'running' && <TurnDots phase="working" />}
        {facts.state === 'done' && <Glyph icon={Tick02Icon} size={12} />}
        <span className="truncate">{label}</span>
      </Badge>
      {extra && (
        <span className="shrink-0 text-hint text-(--thread-text) tabular-nums">{extra}</span>
      )}
    </>
  )
}

/** The steps a waiting step still waits on: those leading to it that are not done. */
function waitsOn(view: TaskView, stepId: string): string[] {
  return view.sop.steps
    .filter((s) => s.outcomes.some((o) => o.to.includes(stepId)) && s.id !== stepId)
    .filter((s) => {
      const state = view.steps.find((x) => x.id === s.id)?.state
      return state === 'running' || state === 'needs_you' || state === 'waiting'
    })
    .map((s) => stepTitle(view.sop, s.id))
}

/** The step picked on the chart: who does it and why, its state and branch, and what to do. */
function NodeDetails({ view, facts }: { view: TaskView; facts: StepFacts }) {
  const { t } = useTranslation('tasks')
  const [pinning, setPinning] = useState(false)
  const hostId = hostOfPath(view.projectPath)
  const models = useModelText(hostId, facts.pick)
  const round = facts.round
  const step = view.sop.steps.find((s) => s.id === facts.id)!
  const session = useSessionsStore((s) => (round?.sessionId ? s.byId[round.sessionId] : undefined))
  const live = view.rounds.some((r) => r.stepId === facts.id && LIVE.has(r.state))
  const canPin = view.status === 'running' && step.by === 'agent' && !live
  const sent = round?.sentBack
  const now = useNow()
  const rows: [string, ReactNode][] = []
  rows.push([
    t('details.agent'),
    step.by === 'you'
      ? t('flow.you')
      : facts.pick
        ? pickLine(facts.pick, hostId, models)
        : t('flow.auto'),
  ])
  if (round) rows.push([t('details.picked'), pickedByText(round.pickedBy, view)])
  else if (facts.waiting?.pick)
    rows.push([t('details.picked'), pickedByText(facts.waiting.pick.pickedBy, view)])
  else if (step.by === 'agent') rows.push([t('details.picks'), whoPicksText(view, facts.id)])
  const reason = round?.reason ?? facts.waiting?.pick?.reason
  if (reason) rows.push([t('details.why'), t('details.quoted', { text: reason })])
  rows.push([
    t('details.status'),
    [
      facts.word ? t(`state.${facts.word}`) : t('flow.notStarted'),
      round?.startedAt != null ? runningFor((round.endedAt ?? now) - round.startedAt) : null,
      round && round.n > 1 ? t('round', { n: round.n }) : null,
      round?.outcome ? t('details.outcome', { outcome: round.outcome }) : null,
    ]
      .filter(Boolean)
      .join(t('separator')),
  ])
  if (round?.branch) {
    rows.push([
      t('details.branch'),
      <code key="branch" className="font-mono text-code">
        {round.branch}
      </code>,
    ])
  }
  if (step.reviewOf.length > 0) {
    rows.push([
      t('details.reviews'),
      step.reviewOf.map((id) => stepTitle(view.sop, id)).join(t('and')),
    ])
  }
  if (!round && step.hint) rows.push([t('details.hint'), t('details.quoted', { text: step.hint })])
  if (sent) {
    const from = sent.by === 'person' ? t('picked.person') : stepTitle(view.sop, sent.stepId)
    rows.push([
      t('details.sentBack'),
      <span key="sent" className="whitespace-pre-wrap">
        {[`${from}: ${sent.note ?? sent.outcome ?? ''}`, ...sent.comments].join('\n')}
      </span>,
    ])
  }
  return (
    <section
      aria-label={t('details.label', { step: facts.name })}
      className="overflow-hidden rounded-2xl bg-(--thread-card) shadow-(--thread-card-shadow)"
    >
      <header className="flex min-h-12 flex-wrap items-center gap-2 py-2 pr-2.5 pl-3.5">
        <WhoMark facts={facts} hostId={hostId} />
        <b className="text-small font-medium text-(--thread-ink)">{facts.name}</b>
        <StateBadge facts={facts} view={view} />
        <span className="flex-1" />
        {canPin && !pinning && (
          <Button size="sm" variant="outline" onClick={() => setPinning(true)}>
            {view.pins[facts.id] ? t('details.changePin') : t('details.pin')}
          </Button>
        )}
        {session && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => openSession(session.id, session.projectPath)}
          >
            {t('asking.open')}
          </Button>
        )}
      </header>
      {pinning && (
        <div className="border-t border-(--thread-line) px-3.5 py-3">
          <PinEditor view={view} stepId={facts.id} onDone={() => setPinning(false)} />
        </div>
      )}
      <dl className="grid grid-cols-[fit-content(150px)_minmax(0,1fr)] gap-x-5 gap-y-1.5 border-t border-(--thread-line) px-3.5 py-3 text-small">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="whitespace-nowrap text-(--thread-muted)">{label}</dt>
            <dd className="min-w-0 text-(--thread-ink)" data-selectable="">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
