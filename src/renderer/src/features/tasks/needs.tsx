import { useState, type ReactNode } from 'react'
import {
  Alert02Icon,
  Comment01Icon,
  FileEditIcon,
  GitMergeIcon,
  HelpCircleIcon,
  UserIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { TaskNeed, TaskView } from '@shared/workflow'
import { ApprovalCard } from '@renderer/components/affect/approval-card'
import { Button } from '@renderer/components/ui/button'
import { useComments } from '@renderer/features/artifacts/use-comments'
import { Clamp } from '@renderer/features/session/clamp'
import { Markdown } from '@renderer/features/session/markdown'
import { Glyph } from '@renderer/features/shell/glyph'
import { errorMessage, host } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useTasksStore } from '@renderer/stores/tasks'
import { openSession } from '@renderer/stores/view'
import {
  blockedText,
  heldRound,
  needKey,
  nextAfter,
  outcomeTitle,
  stepTitle,
  stuckText,
} from './model'
import { PinEditor } from './pin-editor'
import { DocumentChip } from './timeline'

/** A request to the task's host that returns its view, with its state for the card that sent it. */
function useTaskRequest(taskId: string) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (request: () => Promise<TaskView>): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      const view = await request()
      useTasksStore.getState().receive(view, useTasksStore.getState().hosts[taskId] ?? null)
      return true
    } catch (reason) {
      setError(errorMessage(reason))
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

/** What waits for you on the task, a card each, in the order it came. */
export function NeedCards({ view }: { view: TaskView }) {
  if (view.status !== 'running' || view.needs.length === 0) return null
  return (
    <div className="mt-2 flex flex-col gap-3">
      {view.needs.map((need) => (
        <NeedCard key={needKey(need)} view={view} need={need} />
      ))}
    </div>
  )
}

function NeedCard({ view, need }: { view: TaskView; need: TaskNeed }) {
  switch (need.kind) {
    case 'review':
      return <ReviewCard view={view} roundId={need.roundId} />
    case 'person':
      return <PersonCard view={view} roundId={need.roundId} />
    case 'asking':
      return <AskingCard view={view} need={need} />
    case 'blocked':
      return <BlockedCard view={view} need={need} />
    case 'stuck':
      return <StuckCard view={view} need={need} />
    case 'end_merge':
      return <MergeCard view={view} need={need} />
  }
}

/**
 * A document waiting for your review, on affectUI's Approval Card: the document, which opens
 * beside the page, how many of your comments on it go back with a send back, and a note.
 */
function ReviewCard({ view, roundId }: { view: TaskView; roundId: string }) {
  const { t } = useTranslation('tasks')
  const round = view.rounds.find((r) => r.id === roundId)
  const [note, setNote] = useState('')
  const [empty, setEmpty] = useState(false)
  const { busy, error, run } = useTaskRequest(view.id)
  const { threads } = useComments(round?.document?.artifactId ?? null)
  if (!round) return null
  const hostId = hostOfPath(view.projectPath)
  const step = stepTitle(view.workflow, round.stepId)
  const agent = round.by ? agentName(round.by.agentId, hostId) : t('picked.person')
  const comments = threads?.filter((thread) => thread.resolvedAt === null).length ?? 0
  const next = nextAfter(view, round)
  const outcome =
    round.outcome === null
      ? t('state.done')
      : outcomeTitle(view.workflow, round.stepId, round.outcome)
  const answer = (approve: boolean) =>
    run(() =>
      host('tasks.review', {
        taskId: view.id,
        roundId,
        approve,
        ...(!approve && note.trim() ? { note: note.trim() } : {}),
      }),
    )
  return (
    <div className="min-w-0">
      <p className="mb-1.5 px-1 text-hint text-(--thread-muted)">
        {[t('timeline.round', { step, n: round.n }), agent].join(t('separator'))}
      </p>
      <ApprovalCard
        title={t('review.title', { step })}
        description={
          round.note
            ? t('review.reportedNote', { agent, outcome, note: round.note })
            : t('review.reported', { agent, outcome })
        }
        icon={<Glyph icon={FileEditIcon} size={15} />}
        approveLabel={next ? t('review.approveNext', { next }) : t('review.approve')}
        denyLabel={t('review.sendBack')}
        allowAlways={false}
        shortcuts
        status="pending"
        onApprove={async () => {
          if (busy || !(await answer(true))) throw new Error('not sent')
        }}
        onDeny={() => {
          if (busy) return
          // A send back must give the next round something to fix.
          if (!note.trim() && comments === 0) {
            setEmpty(true)
            return
          }
          void answer(false)
        }}
        preview={
          <div className="flex flex-col gap-2.5">
            {round.document && (
              <DocumentChip
                taskId={view.id}
                artifactId={round.document.artifactId}
                label={round.document.title}
                className="w-full rounded-[10px] px-3 py-2"
              >
                <span className="flex min-w-0 flex-col text-left">
                  <span className="truncate text-small font-medium">{round.document.title}</span>
                  <span className="truncate text-hint text-(--thread-muted)">
                    {t('review.version', { version: round.document.version })}
                  </span>
                </span>
              </DocumentChip>
            )}
            {comments > 0 && (
              <span className="flex items-center gap-1.5 text-hint text-(--thread-muted)">
                <Glyph icon={Comment01Icon} size={13} />
                {t('review.comments', { count: comments, agent })}
              </span>
            )}
            <NoteField
              value={note}
              onChange={(value) => {
                setNote(value)
                setEmpty(false)
              }}
              placeholder={t('review.notePlaceholder', { agent })}
            />
          </div>
        }
      />
      {empty && <CardError text={t('review.sendBackEmpty')} />}
      {error && <CardError text={error} />}
    </div>
  )
}

/** A step the workflow gives you: what it asks, a note, and its outcomes as buttons. */
function PersonCard({ view, roundId }: { view: TaskView; roundId: string }) {
  const { t } = useTranslation('tasks')
  const round = view.rounds.find((r) => r.id === roundId)
  const step = view.workflow.steps.find((s) => s.id === round?.stepId)
  const [note, setNote] = useState('')
  const [chosen, setChosen] = useState<string | null>(null)
  const { busy, error, run } = useTaskRequest(view.id)
  if (!round || !step) return null
  const answer = (outcome: string) => {
    setChosen(outcome)
    void run(() =>
      host('tasks.answer', {
        taskId: view.id,
        roundId,
        outcome,
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    )
  }
  return (
    <Card
      icon={UserIcon}
      title={t('person.title', { step: stepTitle(view.workflow, step.id) })}
      body={<Prompt text={step.prompt} />}
      error={error}
    >
      <NoteField value={note} onChange={setNote} placeholder={t('person.notePlaceholder')} />
      <div className="flex flex-wrap justify-end gap-2">
        {step.outcomes.map((outcome) => (
          <Button
            key={outcome.name}
            size="sm"
            variant="outline"
            disabled={busy}
            aria-busy={busy && chosen === outcome.name}
            onClick={() => answer(outcome.name)}
          >
            {outcomeTitle(view.workflow, step.id, outcome.name)}
          </Button>
        ))}
      </div>
    </Card>
  )
}

/** A step's agent asks you something in its session, which opens there. */
function AskingCard({
  view,
  need,
}: {
  view: TaskView
  need: Extract<TaskNeed, { kind: 'asking' }>
}) {
  const { t } = useTranslation('tasks')
  const round = view.rounds.find((r) => r.id === need.roundId)
  const session = useSessionsStore((s) => s.byId[need.sessionId])
  const hostId = hostOfPath(view.projectPath)
  const agent = round?.by ? agentName(round.by.agentId, hostId) : ''
  return (
    <Card
      icon={HelpCircleIcon}
      title={t('asking.title', { agent, step: stepTitle(view.workflow, need.stepId) })}
      body={t('asking.body')}
    >
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={!session}
          onClick={() => session && openSession(session.id, session.projectPath)}
        >
          {t('asking.open')}
        </Button>
      </div>
    </Card>
  )
}

/**
 * A step that cannot start, or whose work a used-up plan limit stopped, in words; Retry, or pin
 * someone else for it.
 */
function BlockedCard({
  view,
  need,
}: {
  view: TaskView
  need: Extract<TaskNeed, { kind: 'blocked' }>
}) {
  const { t } = useTranslation('tasks')
  const now = useNow()
  const [pinning, setPinning] = useState(false)
  const hostId = hostOfPath(view.projectPath)
  const step = stepTitle(view.workflow, need.stepId)
  const held = heldRound(view, need.stepId)
  // A step that reported and only picks who goes next is not taken over.
  const canPin =
    view.workflow.steps.find((s) => s.id === need.stepId)?.by === 'agent' &&
    held?.state !== 'picking'
  return (
    <Card
      icon={Alert02Icon}
      tone="warning"
      title={t(held ? 'blocked.heldTitle' : 'blocked.title', { step })}
      body={blockedText(need.reason, hostId, now, held !== undefined)}
    >
      {pinning ? (
        <PinEditor view={view} stepId={need.stepId} onDone={() => setPinning(false)} />
      ) : (
        <RetryRow
          view={view}
          stepId={need.stepId}
          extra={
            canPin && (
              <Button size="sm" variant="outline" onClick={() => setPinning(true)}>
                {t('blocked.pin')}
              </Button>
            )
          }
        />
      )}
    </Card>
  )
}

/** A step that stopped and waits for you: what happened, then Retry with a note. */
function StuckCard({ view, need }: { view: TaskView; need: Extract<TaskNeed, { kind: 'stuck' }> }) {
  const { t } = useTranslation('tasks')
  const round = view.rounds.find((r) => r.id === need.roundId)
  const session = useSessionsStore((s) => (round?.sessionId ? s.byId[round.sessionId] : undefined))
  const step = stepTitle(view.workflow, need.stepId)
  return (
    <Card
      icon={Alert02Icon}
      tone="danger"
      title={t('stuckTitle', { step })}
      body={
        <>
          <span>{stuckText(need.reason, step)}</span>
          {need.detail && (
            <span className="mt-1 block font-mono text-code whitespace-pre-wrap text-(--thread-muted)">
              {need.detail}
            </span>
          )}
        </>
      }
    >
      <RetryRow
        view={view}
        stepId={need.stepId}
        extra={
          session && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => openSession(session.id, session.projectPath)}
            >
              {t('asking.open')}
            </Button>
          )
        }
      />
    </Card>
  )
}

/** The task's branch would not merge at its end: the files in conflict, then Retry. */
function MergeCard({
  view,
  need,
}: {
  view: TaskView
  need: Extract<TaskNeed, { kind: 'end_merge' }>
}) {
  const { t } = useTranslation('tasks')
  return (
    <Card
      icon={GitMergeIcon}
      tone="danger"
      title={t('merge.title')}
      body={
        <>
          <span>{need.error ?? t('merge.body', { count: need.conflicts.length })}</span>
          {need.conflicts.length > 0 && (
            <span className="mt-1 flex flex-col font-mono text-code text-(--thread-muted)">
              {need.conflicts.map((file) => (
                <span key={file} className="truncate">
                  {file}
                </span>
              ))}
            </span>
          )}
        </>
      }
    >
      <RetryRow view={view} stepId={need.stepId} />
    </Card>
  )
}

/** Retry with an optional note for the step's agent, beside the card's other actions. */
function RetryRow({ view, stepId, extra }: { view: TaskView; stepId: string; extra?: ReactNode }) {
  const { t } = useTranslation('tasks')
  const [note, setNote] = useState('')
  const { busy, error, run } = useTaskRequest(view.id)
  return (
    <>
      <NoteField value={note} onChange={setNote} placeholder={t('retry.notePlaceholder')} />
      <div className="flex flex-wrap items-center justify-end gap-2">
        {extra}
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            void run(() =>
              host('tasks.retry', {
                taskId: view.id,
                stepId,
                ...(note.trim() ? { note: note.trim() } : {}),
              }),
            )
          }
        >
          {t('retry.button')}
        </Button>
      </div>
      {error && <CardError text={error} />}
    </>
  )
}

/** A card that waits for you, in the thread's card look, its tone on its icon. */
function Card({
  icon,
  tone,
  title,
  body,
  error,
  children,
}: {
  icon: Parameters<typeof Glyph>[0]['icon']
  tone?: 'warning' | 'danger'
  title: string
  body: ReactNode
  error?: string | null
  children?: ReactNode
}) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl bg-(--thread-card) p-4 shadow-(--thread-card-shadow)">
      <header className="flex gap-3">
        <span
          className={cn(
            'mt-px grid size-5 shrink-0 place-items-center text-(--thread-muted)',
            tone === 'warning' && 'text-warning',
            tone === 'danger' && 'text-danger',
          )}
        >
          <Glyph icon={icon} size={16} />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-label font-medium text-(--thread-ink)">{title}</span>
          <div className="text-small text-(--thread-text)" data-selectable="">
            {body}
          </div>
        </div>
      </header>
      {children}
      {error && <CardError text={error} />}
    </section>
  )
}

/** A person's step's prompt, cut to a few lines until opened. */
function Prompt({ text }: { text: string }) {
  const { t } = useTranslation('tasks')
  return (
    <Clamp
      maxHeight={120}
      more={t('sentBack.more')}
      less={t('sentBack.less')}
      buttonClassName="-mx-1.5 mt-1"
    >
      <Markdown markdown={text} className="markdown-compact" />
    </Clamp>
  )
}

function NoteField({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
}) {
  return (
    <textarea
      rows={1}
      value={value}
      placeholder={placeholder}
      aria-label={placeholder}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        // Esc leaves the field rather than answering the card around it.
        if (event.key === 'Escape') {
          event.stopPropagation()
          event.currentTarget.blur()
        }
      }}
      className="field-sizing-content max-h-40 min-h-9 w-full resize-none rounded-[9px] bg-(--bg-surface) px-2.5 py-2 text-small text-(--thread-ink) shadow-[inset_0_0_0_0.5px_var(--border-strong)] outline-none placeholder:text-(--thread-faint) focus-visible:shadow-[inset_0_0_0_1px_var(--focus)]"
    />
  )
}

function CardError({ text }: { text: string }) {
  return (
    <p role="alert" className="ks-card-error">
      {text}
    </p>
  )
}
