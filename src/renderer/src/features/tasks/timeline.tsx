import type { ReactNode } from 'react'
import {
  ArrowTurnBackwardIcon,
  File01Icon,
  Message01Icon,
  Tick02Icon,
  UserIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { isBackArrow, type RoundView, type TaskView } from '@shared/workflow'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Badge } from '@renderer/components/ui/badge'
import { ProjectPathContext } from '@renderer/features/files/file-refs'
import { UserContentView } from '@renderer/features/session/entries/user-content'
import { Markdown } from '@renderer/features/session/markdown'
import { TurnDots } from '@renderer/features/session/turn-dots'
import { Glyph } from '@renderer/features/shell/glyph'
import { clockTime, runningFor } from '@renderer/lib/format'
import { hostOfPath } from '@renderer/lib/host-paths'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import {
  artifactShown,
  openArtifactTab,
  openSession,
  taskPanel,
  useViewStore,
} from '@renderer/stores/view'
import {
  outcomeTitle,
  pickedByText,
  pickLine,
  workflowTitle,
  stepTitle,
  useModelText,
} from './model'
import { Delivered, StepsSummary } from './ended-summary'
import { NeedCards } from './needs'

/** A thing on the timeline, in the order it happened: a round of a step, or a note you added. */
type Item =
  { kind: 'round'; at: number; round: RoundView } | { kind: 'note'; at: number; text: string }

/** Rounds the timeline shows: finished ones and those at work, not those still queued. */
const SHOWN = new Set(['starting', 'working', 'picking', 'done', 'stopped', 'stuck'])

/**
 * The task as it went: what was asked and where it came from, a card per round of a step, with
 * who did it, who picked them and why, its outcome and time and what it handed in; the notes you
 * added; then the cards that wait for you and the steps still to come. Once it ended, what it
 * delivered and a row per step instead.
 */
export function Timeline({ view }: { view: TaskView }) {
  if (view.status !== 'running') {
    return (
      <ProjectPathContext value={view.worktreePath ?? view.projectPath}>
        <div className="flex flex-col gap-5">
          <Asked view={view} />
          <Delivered view={view} />
          <StepsSummary view={view} />
        </div>
      </ProjectPathContext>
    )
  }
  const items: Item[] = [
    ...view.rounds
      .filter((round) => SHOWN.has(round.state))
      .map((round): Item => ({ kind: 'round', at: round.startedAt ?? round.queuedAt, round })),
    ...view.notes.map((note): Item => ({ kind: 'note', at: note.at, text: note.text })),
  ].sort((a, b) => a.at - b.at)
  return (
    <ProjectPathContext value={view.worktreePath ?? view.projectPath}>
      <div className="flex flex-col gap-2.5">
        <Asked view={view} />
        {items.map((item) =>
          item.kind === 'round' ? (
            <RoundCard key={item.round.id} view={view} round={item.round} />
          ) : (
            <NoteBubble key={`note:${item.at}`} text={item.text} at={item.at} />
          ),
        )}
        <NeedCards view={view} />
        <Upcoming view={view} />
      </div>
    </ProjectPathContext>
  )
}

/** The task's own text at the top, as the message that started it, and where it came from. */
function Asked({ view }: { view: TaskView }) {
  return (
    <div className="ks-user mb-2">
      <SentText text={view.text} />
      <StartedFrom view={view} />
    </div>
  )
}

/** Where the task came from, the conversation it opens when it started from one, and when. */
export function StartedFrom({ view, className }: { view: TaskView; className?: string }) {
  const { t } = useTranslation('tasks')
  const from = useSessionsStore((s) => (view.from ? s.byId[view.from.sessionId] : undefined))
  return (
    <span
      className={cn('flex min-w-0 items-center gap-1.5 text-hint text-(--thread-faint)', className)}
    >
      <Glyph icon={Message01Icon} size={12} className="shrink-0" />
      {from ? (
        <button
          type="button"
          className="truncate hover:text-(--thread-ink) hover:underline"
          onClick={() => openSession(from.id, from.projectPath)}
        >
          {t('timeline.startedFrom', {
            session: sessionTitle(from),
            workflow: workflowTitle(view, view),
            time: clockTime(view.createdAt),
          })}
        </button>
      ) : (
        <span className="truncate">
          {t('timeline.started', {
            workflow: workflowTitle(view, view),
            time: clockTime(view.createdAt),
          })}
        </span>
      )}
    </span>
  )
}

/** Text you wrote, in the bubble and Markdown a message you sent has in a session. */
function SentText({ text }: { text: string }) {
  return (
    <div className="ks-user__bubble">
      <UserContentView content={[{ type: 'text', text }]} />
    </div>
  )
}

function NoteBubble({ text, at }: { text: string; at: number }) {
  const { t } = useTranslation('tasks')
  return (
    <div className="ks-user my-1">
      <SentText text={text} />
      <span className="text-hint text-(--thread-faint)">
        {t('timeline.noteAdded', { time: clockTime(at) })}
      </span>
    </div>
  )
}

/**
 * What you sent this round back with, when you did in its review. A send back by an agent is that
 * agent's own outcome, which its round shows.
 */
function reviewedBack(view: TaskView, round: RoundView) {
  const sent = view.rounds.find(
    (r) => r.sentBack?.by === 'person' && r.sentBack.roundId === round.id,
  )?.sentBack
  return sent ?? null
}

/** A round of a step as a card: its head opens the round's session. */
function RoundCard({ view, round }: { view: TaskView; round: RoundView }) {
  const { t } = useTranslation('tasks')
  const now = useNow()
  const hostId = hostOfPath(view.projectPath)
  const models = useModelText(hostId, round.by)
  const name = stepTitle(view.workflow, round.stepId)
  const several = view.rounds.filter((r) => r.stepId === round.stepId).length > 1
  const title = several ? t('timeline.round', { step: name, n: round.n }) : name
  const back = reviewedBack(view, round)
  const step = view.workflow.steps.find((x) => x.id === round.stepId)
  const outcome = step?.outcomes.find((o) => o.name === round.outcome)
  const backward = !!outcome && isBackArrow(view.workflow, round.stepId, outcome)
  const session = useSessionsStore((s) => (round.sessionId ? s.byId[round.sessionId] : undefined))
  const time =
    round.startedAt !== null ? runningFor((round.endedAt ?? now) - round.startedAt) : null
  const who = [
    round.by ? pickLine(round.by, hostId, models) : null,
    pickedByText(round.pickedBy, view),
  ]
    .filter(Boolean)
    .join(t('separator'))
  return (
    <article className="flex flex-col gap-2 rounded-xl bg-(--thread-card) px-3.5 py-3 shadow-(--thread-card-shadow)">
      <header className="flex min-w-0 items-center gap-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-(--thread-chip)">
          {round.by ? (
            <AgentMark agent={round.by.agentId} size={14} hostId={hostId} />
          ) : (
            <Glyph icon={UserIcon} size={14} />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          {session ? (
            <button
              type="button"
              className="w-fit max-w-full truncate text-left text-label font-medium text-(--thread-ink) hover:underline"
              onClick={() => openSession(session.id, session.projectPath)}
            >
              {title}
            </button>
          ) : (
            <span className="truncate text-label font-medium text-(--thread-ink)">{title}</span>
          )}
          <span className="truncate text-hint text-(--thread-muted)">{who}</span>
        </span>
        <RoundState
          round={round}
          outcome={
            round.outcome === null ? null : outcomeTitle(view.workflow, round.stepId, round.outcome)
          }
          sentBack={!!back}
          backward={backward}
        />
        {time && (
          <span className="shrink-0 text-hint text-(--thread-text) tabular-nums">{time}</span>
        )}
      </header>
      {round.reason && (
        <p className="text-small text-(--thread-muted)" data-selectable="">
          {t('timeline.why', { reason: round.reason })}
        </p>
      )}
      {back ? (
        <p className="text-small whitespace-pre-wrap text-(--thread-text)" data-selectable="">
          {t('timeline.youSaid', { note: back.note ?? t('timeline.noNote') })}
        </p>
      ) : (
        round.note && (
          <div data-selectable="">
            <Markdown markdown={round.note} className="markdown-compact" />
          </div>
        )
      )}
      {round.document && (
        <DocumentChip
          taskId={view.id}
          artifactId={round.document.artifactId}
          label={t('timeline.document', {
            title: round.document.title,
            version: round.document.version,
          })}
        />
      )}
    </article>
  )
}

/**
 * A round's state in a pill: its outcome, amber when it sends work back; sent back by you, stopped,
 * stuck, or at work.
 */
function RoundState({
  round,
  outcome,
  sentBack,
  backward,
}: {
  round: RoundView
  /** Its outcome's name in the language shown. */
  outcome: string | null
  sentBack: boolean
  backward: boolean
}) {
  const { t } = useTranslation('tasks')
  if (backward && round.state === 'done') {
    return (
      <Badge variant="warning">
        <Glyph icon={ArrowTurnBackwardIcon} size={12} />
        {outcome}
      </Badge>
    )
  }
  if (sentBack) {
    return (
      <Badge variant="warning">
        <Glyph icon={ArrowTurnBackwardIcon} size={12} />
        {t('timeline.sentBack')}
      </Badge>
    )
  }
  switch (round.state) {
    case 'done':
      return (
        <Badge variant="success">
          <Glyph icon={Tick02Icon} size={12} />
          {outcome ?? t('state.done')}
        </Badge>
      )
    case 'stopped':
      return <Badge variant="neutral">{t('timeline.stopped')}</Badge>
    case 'stuck':
      return <Badge variant="error">{t('state.failed')}</Badge>
    case 'picking':
      return (
        <Badge variant="info">
          <TurnDots phase="thinking" />
          {t('timeline.picking')}
        </Badge>
      )
    default:
      return (
        <Badge variant="info">
          <TurnDots phase="working" />
          {t('state.running')}
        </Badge>
      )
  }
}

/** A document a step handed in; it opens beside the page. */
export function DocumentChip({
  taskId,
  artifactId,
  label,
  className,
  children,
}: {
  taskId: string
  artifactId: string
  label: string
  className?: string
  children?: ReactNode
}) {
  const panel = taskPanel(taskId)
  const open = useViewStore((s) => artifactShown(s, panel, artifactId))
  return (
    <button
      type="button"
      aria-pressed={open}
      onClick={() => openArtifactTab(panel, artifactId, { preview: true })}
      className={cn(
        'flex w-fit max-w-full items-center gap-1.5 rounded-lg bg-(--thread-chip) px-2.5 py-1 text-hint text-(--thread-ink) hover:bg-(--shell-chip-hover) focus-visible:outline-[1.5px] focus-visible:outline-(--focus) aria-pressed:shadow-[inset_0_0_0_1px_var(--focus)]',
        className,
      )}
    >
      <Glyph icon={File01Icon} size={13} className="shrink-0" />
      {children ?? <span className="truncate">{label}</span>}
    </button>
  )
}

/** The steps still to come, in the workflow's order, each marked when it waits for you or is pinned. */
function Upcoming({ view }: { view: TaskView }) {
  const { t } = useTranslation('tasks')
  if (view.status !== 'running') return null
  const furthest = Math.max(
    -1,
    ...view.rounds.map((round) => view.workflow.steps.findIndex((s) => s.id === round.stepId)),
  )
  const next = view.workflow.steps
    .slice(furthest + 1)
    .filter((step) => !view.rounds.some((round) => round.stepId === step.id))
  if (next.length === 0) return null
  const hostId = hostOfPath(view.projectPath)
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-hint text-(--thread-faint)">
      <span>{t('timeline.next')}</span>
      {next.map((step, i) => (
        <span key={step.id} className="inline-flex items-center gap-1.5">
          {i > 0 && <span aria-hidden>→</span>}
          <span className="text-(--thread-muted)">{stepTitle(view.workflow, step.id)}</span>
          {(step.by === 'you' || step.youReview) && (
            <Badge variant="warning" className="font-medium">
              {step.by === 'you' ? t('flow.you') : t('timeline.youReview')}
            </Badge>
          )}
          {view.pins[step.id] && (
            <span className="inline-flex items-center gap-1">
              <AgentMark agent={view.pins[step.id]!.agentId} size={11} hostId={hostId} />
              {t('timeline.pinned')}
            </span>
          )}
        </span>
      ))}
    </p>
  )
}
