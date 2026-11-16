import { memo, useEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import {
  ArrowDown01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  SparklesIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import {
  usableWorkflow,
  type CheckLine,
  type CheckNext,
  type PickCheck,
  type ReportCheck,
  type StepPick,
} from '@shared/workflow'
import type { AgentId, ToolEntry } from '@shared/thread'
import { Icon } from '@renderer/components/affect/app-shell'
import { ApprovalCard } from '@renderer/components/affect/approval-card'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Glyph, MenuGlyph } from '@renderer/features/shell/glyph'
import { errorMessage, host } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { optionsOn, useAgentOptionsStore } from '@renderer/stores/agent-options'
import { agentName } from '@renderer/stores/agents'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { useHostWorkflows } from '@renderer/stores/workflows'
import { useTasksStore } from '@renderer/stores/tasks'
import { openWorkflowMarketplace, openTask } from '../new-session/open-task'
import {
  listOf,
  localStepName,
  pickNames,
  WORKFLOW_ICON,
  workflowBlocked,
  workflowName,
  stepChain,
} from '../new-session/workflow-picks'
import { PaceControl, PickLabel, StepRows, WhoChain } from '../new-session/workflow-steps'
import { useSessionView } from '../use-thread'
import { revealWaiting } from './helpers'
import {
  answerSuggestion,
  listedLines,
  pickOf,
  reportOf,
  savedOf,
  workflowCardOf,
  suggestionAnswer,
  suggestionOf,
  useSuggestionAnswers,
  type PickCall,
  type ReportCall,
  type Suggestion,
} from './workflow-tools'

/**
 * A call of one of Kettu's workflow tools, once it ended, as its card: a suggestion to start a task,
 * a workflow saved for approval, and a step's report or pick with what Kettu checked.
 */
export const WorkflowToolCard = memo(function WorkflowToolCard({
  ref,
  sessionId,
  entry,
  agentName: agent,
  className,
}: {
  ref: Ref<HTMLDivElement>
  sessionId: string
  entry: ToolEntry
  agentName: string
  className?: string
}) {
  const tool = workflowCardOf(entry)
  const body =
    tool === 'start' ? (
      <SuggestionCard sessionId={sessionId} entry={entry} agent={agent} />
    ) : tool === 'create' ? (
      <SavedCard sessionId={sessionId} entry={entry} agent={agent} />
    ) : tool === 'report' ? (
      <ReportCard sessionId={sessionId} call={reportOf(entry)} agent={agent} />
    ) : tool === 'pick' ? (
      <PickCard sessionId={sessionId} call={pickOf(entry)} agent={agent} />
    ) : null
  return (
    <div ref={ref} data-entry-id={entry.id} className={cn('min-w-0', className)}>
      {body}
    </div>
  )
})

/** The session the call came from: its host, agent and project, and its task when a step's. */
function useCaller(sessionId: string) {
  const summary = useSessionsStore((s) => s.byId[sessionId])
  return {
    summary,
    hostId: summary ? hostOfSession(summary) : null,
    task: summary?.task ?? null,
  }
}

// A suggestion.

function SuggestionCard({
  sessionId,
  entry,
  agent,
}: {
  sessionId: string
  entry: ToolEntry
  agent: string
}) {
  const answer = useSuggestionAnswers((s) => suggestionAnswer(s.answers, sessionId, entry.id))
  const suggestion = suggestionOf(entry)!
  if (answer?.kind === 'started') {
    return <SuggestionSettled suggestion={suggestion} taskId={answer.taskId} />
  }
  if (answer?.kind === 'declined') return <SuggestionSettled suggestion={suggestion} />
  return (
    <SuggestionPending
      sessionId={sessionId}
      entryId={entry.id}
      suggestion={suggestion}
      agent={agent}
    />
  )
}

/**
 * The agent's suggestion to run the work as a task, on Approval Card: the workflow, the task's text to
 * edit, the pace with the agent's reason and who does each step. Start starts the task with this
 * session's agent and options for the first step; No, just do it tells the agent so.
 */
function SuggestionPending({
  sessionId,
  entryId,
  suggestion,
  agent,
}: {
  sessionId: string
  entryId: string
  suggestion: Suggestion
  agent: string
}) {
  const { t } = useTranslation('session')
  const { summary, hostId } = useCaller(sessionId)
  const config = useSessionView(sessionId)?.config
  const { entries, loaded } = useHostWorkflows(hostId)
  const [workflowId, setWorkflowId] = useState(suggestion.workflowId)
  const [text, setText] = useState(suggestion.task)
  const [pace, setPace] = useState(suggestion.pace)
  const [pins, setPins] = useState<Record<string, StepPick>>({})
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const chosen = entries.find((e) => e.id === workflowId)
  const workflow =
    chosen && usableWorkflow(chosen) && chosen.workflow
      ? { ...chosen, workflow: chosen.workflow }
      : null

  useEffect(() => revealWaiting(root.current), [])

  // The first step goes on as this session does: its agent and its values but the mode, which
  // Kettu sets for every step.
  const firstPick: StepPick | null = summary
    ? {
        agentId: summary.agentId,
        model: valueOf(config, 'model'),
        effort: valueOf(config, 'thought_level'),
      }
    : null

  const start = async () => {
    if (!summary || !workflow) throw new Error('not ready')
    const task = text.trim()
    if (!task) {
      setError(t('workflow.suggest.emptyTask'))
      throw new Error('empty')
    }
    setError(null)
    const options = Object.fromEntries(
      (config ?? []).filter((o) => o.category !== 'mode').map((o) => [o.id, o.value]),
    )
    try {
      const view = await useTasksStore.getState().start(
        {
          projectPath: summary.projectPath,
          workflowId: workflow.id,
          text: task,
          ...(suggestion.title ? { title: suggestion.title } : {}),
          pace,
          ...(pace === suggestion.pace && suggestion.paceReason
            ? { paceReason: suggestion.paceReason }
            : {}),
          agentId: summary.agentId,
          options,
          pins,
          from: { sessionId },
        },
        hostId,
      )
      answerSuggestion(sessionId, entryId, { kind: 'started', taskId: view.id })
      openTask(view.id)
    } catch (caught) {
      setError(errorMessage(caught))
      throw caught
    }
  }

  const decline = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await host('sessions.queue', {
        sessionId,
        content: [{ type: 'text', text: t('workflow.suggest.declineMessage') }],
      })
      answerSuggestion(sessionId, entryId, { kind: 'declined' })
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  const waits = workflow
    ? workflow.workflow.steps.filter((s) => s.youReview || s.by === 'you').map((s) => s.id)
    : []
  const shownName = chosen
    ? workflowName(chosen)
    : (suggestion.workflowName ?? suggestion.workflowId)

  return (
    <div ref={root} className="min-w-0">
      <ApprovalCard
        className="ks-suggest"
        title={t('workflow.suggest.title')}
        description={
          workflow && waits.length > 0
            ? t('workflow.suggest.descriptionReview', {
                count: waits.length,
                steps: listOf(waits.map((id) => localStepName(workflow.workflow, id))),
              })
            : t('workflow.suggest.description')
        }
        icon={<Icon icon={WORKFLOW_ICON} size={15} />}
        label={t('workflow.suggest.label', { agent })}
        approveLabel={t('workflow.suggest.start')}
        denyLabel={t('workflow.suggest.decline')}
        allowAlways={false}
        shortcuts
        status="pending"
        onApprove={start}
        onDeny={() => void decline()}
        preview={
          <div className="flex flex-col gap-2 text-ui text-primary">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="text-meta text-secondary">{t('workflow.suggest.workflow')}</span>
              <WorkflowSwitch
                hostId={hostId}
                workflowId={workflowId}
                name={shownName}
                steps={chosen?.workflow?.steps.length ?? null}
                onChoose={(id) => {
                  setWorkflowId(id)
                  setPins({})
                }}
              />
            </div>
            {loaded && !workflow && (
              <p className="text-meta text-warning">
                {chosen
                  ? t('workflow.suggest.unusable', { workflow: shownName })
                  : t('workflow.suggest.missing')}
              </p>
            )}
            <label className="mt-1 text-meta text-secondary" htmlFor={`${entryId}-task`}>
              {t('workflow.suggest.task', { agent })}
            </label>
            <textarea
              id={`${entryId}-task`}
              value={text}
              rows={Math.min(8, Math.max(2, text.split('\n').length))}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                // Esc leaves the field, not the card: the card takes it as No.
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  event.currentTarget.blur()
                }
              }}
              className="w-full resize-none rounded-lg bg-card px-2.75 py-2 text-ui leading-relaxed text-primary shadow-outline outline-none focus-visible:shadow-field-focus"
            />
            <div className="mt-1 flex flex-wrap items-center gap-2.5">
              <span className="text-meta text-secondary">{t('workflow.pace')}</span>
              <PaceControl value={pace} onChange={setPace} />
            </div>
            {suggestion.paceReason && (
              <p className="text-meta text-secondary">{suggestion.paceReason}</p>
            )}
            {workflow && (
              <>
                <span className="mt-1 flex items-center justify-between gap-3 text-meta text-secondary">
                  {t('workflow.suggest.who')}
                  {editing && (
                    <button
                      type="button"
                      className="text-meta text-link hover:underline"
                      aria-expanded
                      onClick={() => setEditing(false)}
                    >
                      {t('workflow.suggest.doneEditing')}
                    </button>
                  )}
                </span>
                {editing ? (
                  <div className="overflow-hidden rounded-lg shadow-card">
                    <StepRows
                      workflow={workflow.workflow}
                      workflowPins={workflow.pins}
                      taskPins={pins}
                      hostId={hostId}
                      first={
                        firstPick && (
                          <span className="inline-flex h-7.5 items-center px-2.25 text-control">
                            <PickLabel pick={firstPick} hostId={hostId} />
                          </span>
                        )
                      }
                      onPin={(stepId, pick) =>
                        setPins((current) => {
                          const next = { ...current }
                          if (pick === null) delete next[stepId]
                          else next[stepId] = pick
                          return next
                        })
                      }
                    />
                  </div>
                ) : (
                  <WhoChain
                    workflow={workflow.workflow}
                    workflowPins={workflow.pins}
                    taskPins={pins}
                    firstAgentId={summary?.agentId ?? null}
                    hostId={hostId}
                    trailing={
                      <button
                        type="button"
                        className="text-meta text-link hover:underline"
                        aria-expanded={false}
                        onClick={() => setEditing(true)}
                      >
                        {t('workflow.suggest.edit')}
                      </button>
                    }
                  />
                )}
              </>
            )}
          </div>
        }
      />
      {error && (
        <p role="alert" className="ks-card-error">
          {error}
        </p>
      )}
    </div>
  )
}

function valueOf(
  config: readonly { category: string; value: string | boolean }[] | undefined,
  category: string,
): string | null {
  const value = config?.find((o) => o.category === category)?.value
  return typeof value === 'string' ? value : null
}

/** The suggestion's workflow, switchable to another the library can start. */
function WorkflowSwitch({
  hostId,
  workflowId,
  name,
  steps,
  onChoose,
}: {
  hostId: string | null
  workflowId: string
  name: string
  steps: number | null
  onChoose: (workflowId: string) => void
}) {
  const { t } = useTranslation('session')
  const { entries } = useHostWorkflows(hostId)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={t('workflow.suggest.chooseWorkflow')}
            className="inline-flex h-7.5 min-w-0 items-center gap-1.5 rounded-lg bg-card px-2.25 text-control text-primary shadow-outline hover:bg-hover"
          />
        }
      >
        <Glyph icon={WORKFLOW_ICON} size={13} className="shrink-0" />
        <span className="truncate">{name}</span>
        {steps !== null && (
          <span className="shrink-0 text-secondary">
            {t('workflow.suggest.steps', { count: steps })}
          </span>
        )}
        <Glyph icon={ArrowDown01Icon} size={12} className="shrink-0 text-tertiary" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="w-80">
        <DropdownMenuRadioGroup
          value={workflowId}
          onValueChange={(value) => onChoose(String(value))}
        >
          {entries.map((entry) => {
            const blocked = workflowBlocked(entry)
            return (
              <DropdownMenuRadioItem
                key={entry.id}
                value={entry.id}
                closeOnClick
                disabled={blocked !== null}
                className="py-1.5 data-disabled:opacity-100"
              >
                <MenuGlyph icon={WORKFLOW_ICON} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={blocked ? 'truncate text-tertiary' : 'truncate'}>
                    {workflowName(entry)}
                  </span>
                  <span className="truncate text-meta text-tertiary">
                    {entry.workflow
                      ? stepChain(entry.workflow)
                      : t('newSession.workflow.unreadableHint')}
                  </span>
                </span>
                {blocked && (
                  <span
                    className={cn(
                      'shrink-0 text-small',
                      blocked === 'unreadable' ? 'text-danger' : 'text-warning',
                    )}
                  >
                    {t(`newSession.workflow.blocked.${blocked}`)}
                  </span>
                )}
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A suggestion once answered: started as a task, which opens again, or done without a workflow. */
function SuggestionSettled({ suggestion, taskId }: { suggestion: Suggestion; taskId?: string }) {
  const { t } = useTranslation('session')
  const title = useTasksStore((s) => (taskId ? (s.summaries[taskId]?.title ?? null) : null))
  return (
    <div className="ks-answered" data-kind={taskId ? 'done' : 'other'}>
      <div className="ks-answered__head">
        <Icon icon={taskId ? CheckmarkCircle02Icon : Cancel01Icon} size={16} />
        <span className="ks-answered__title">
          {taskId ? t('workflow.suggest.started') : t('workflow.suggest.declined')}
        </span>
        <span className="ks-answered__device">
          · {title ?? suggestion.title ?? suggestion.workflowName ?? suggestion.workflowId}
        </span>
        {taskId && (
          <button type="button" className="ks-answered__toggle" onClick={() => openTask(taskId)}>
            {t('workflow.suggest.openTask')}
          </button>
        )}
      </div>
      <div className="ks-answered__end" />
    </div>
  )
}

// A workflow an agent wrote.

/**
 * What became of a workflow an agent wrote: saved, with its steps and where it stands now in the
 * library, and the way to the Marketplace to approve it; or refused, with each problem.
 */
function SavedCard({
  sessionId,
  entry,
  agent,
}: {
  sessionId: string
  entry: ToolEntry
  agent: string
}) {
  const { t } = useTranslation('session')
  const { hostId } = useCaller(sessionId)
  const { entries, loaded } = useHostWorkflows(hostId)
  const saved = savedOf(entry)
  if (!saved) return null
  if (!saved.saved) {
    return (
      <CardShell tone="bad">
        <CardHead icon={WORKFLOW_ICON} title={t('workflow.saved.refused')} badge={null} />
        {saved.problems.length > 0 && (
          <ul className="flex flex-col gap-0.75">
            {saved.problems.map((problem, i) => (
              <CheckItem key={i} ok={false}>
                {problem}
              </CheckItem>
            ))}
          </ul>
        )}
        <p className="text-meta text-primary">{t('workflow.saved.refusedHint', { agent })}</p>
      </CardShell>
    )
  }
  const library = entries.find((e) => e.id === saved.workflowId)
  const name = library ? workflowName(library) : saved.name
  const state = !loaded
    ? 'pending'
    : !library
      ? 'removed'
      : library.approval === 'approved'
        ? 'approved'
        : library.approval === 'changed'
          ? 'changed'
          : 'pending'
  return (
    <CardShell tone={state === 'approved' ? 'good' : 'quiet'}>
      <CardHead
        icon={WORKFLOW_ICON}
        title={t(`workflow.saved.${state}`, { name })}
        badge={null}
        aside={
          state !== 'removed' && (
            <button
              type="button"
              className="shrink-0 text-meta text-link hover:underline"
              onClick={() => openWorkflowMarketplace(saved.workflowId)}
            >
              {t('workflow.saved.open')}
            </button>
          )
        }
      />
      {library?.workflow && (
        <p className="text-meta text-secondary">{stepChain(library.workflow)}</p>
      )}
      <p className="text-meta text-tertiary">
        {state === 'pending'
          ? t('workflow.saved.approveHint')
          : t('workflow.saved.madeBy', { agent })}
      </p>
    </CardShell>
  )
}

// A step's report and pick.

/** The step session's task: its steps' names, by id. */
function useStepNames(task: { taskId: string; stepId: string } | null) {
  const steps = useTasksStore((s) => (task ? s.summaries[task.taskId]?.steps : undefined))
  return (id: string) => steps?.find((step) => step.id === id)?.name ?? id
}

function ReportCard({
  sessionId,
  call,
  agent,
}: {
  sessionId: string
  call: ReportCall
  agent: string
}) {
  const { t } = useTranslation('session')
  const { task } = useCaller(sessionId)
  const nameOf = useStepNames(task)
  const label = (line: CheckLine<ReportCheck>): string => {
    if (!line.ok && line.detail) return line.detail
    if (line.check === 'outcome') {
      return call.outcome
        ? t('workflow.check.lines.report.outcome', { outcome: call.outcome })
        : t('workflow.check.lines.report.outcomePlain')
    }
    return KNOWN_REPORT.has(line.check)
      ? t(`workflow.check.lines.report.${line.check}`)
      : line.check
  }
  return (
    <CardShell tone={call.accepted ? 'good' : 'bad'}>
      <CardHead
        icon={WORKFLOW_ICON}
        title={
          call.outcome
            ? t('workflow.check.report', { outcome: call.outcome })
            : t('workflow.check.reportPlain')
        }
        badge={call.accepted}
      />
      <CheckList
        lines={call.checks
          ?.filter((line) => !(line.ok && line.check === 'step_open'))
          .map((line) => ({ ok: line.ok, text: label(line) }))}
        answer={call.answer}
      />
      <NextLine
        next={call.next}
        accepted={call.accepted}
        agent={agent}
        stepName={task ? nameOf(task.stepId) : null}
        nameOf={nameOf}
        retry="retryReport"
      />
      <Details answer={call.answer} />
    </CardShell>
  )
}

const KNOWN_REPORT: ReadonlySet<string> = new Set([
  'step_open',
  'outcome',
  'note',
  'document',
  'committed',
  'merged',
  'picks',
])

function PickCard({
  sessionId,
  call,
  agent,
}: {
  sessionId: string
  call: PickCall
  agent: string
}) {
  const { t } = useTranslation('session')
  const { hostId, task } = useCaller(sessionId)
  const nameOf = useStepNames(task)
  const options = useAgentOptionsStore((s) => optionsOn(s, hostId))
  const steps = [...new Set(call.picks.map((p) => p.step))]
  return (
    <CardShell tone={call.accepted ? 'good' : 'bad'}>
      <CardHead
        icon={SparklesIcon}
        title={t('workflow.check.pick', { steps: listOf(steps.map(nameOf)) })}
        badge={call.accepted}
      />
      {call.picks.map((pick, i) => {
        const agentId = pick.agent as AgentId
        const names = pickNames(options[agentId], {
          agentId,
          model: pick.model,
          effort: pick.effort,
        })
        const who = agentName(agentId, hostId)
        const lines = call.checks?.find((c) => c.step === pick.step)?.lines
        const label = (line: CheckLine<PickCheck>): string => {
          if (!line.ok && line.detail) return line.detail
          switch (line.check) {
            case 'step':
              return t('workflow.check.lines.pick.step', { step: nameOf(pick.step) })
            case 'agent':
            case 'allowed':
              return t(`workflow.check.lines.pick.${line.check}`, { agent: who })
            case 'model':
              return names.model
                ? t('workflow.check.lines.pick.model', { agent: who, model: names.model })
                : t('workflow.check.lines.pick.modelPlain', { agent: who })
            case 'effort':
              return names.effort
                ? t('workflow.check.lines.pick.effort', { effort: names.effort })
                : t('workflow.check.lines.pick.effortPlain')
            case 'tools':
            case 'limit':
            case 'review':
              return t(`workflow.check.lines.pick.${line.check}`)
            default:
              return line.check
          }
        }
        return (
          <div key={i} className="flex flex-col gap-1">
            <p className="flex min-w-0 flex-wrap items-center gap-x-1.75 gap-y-0.5 text-ui">
              <AgentMark agent={agentId} size={14} hostId={hostId} />
              <span className="font-medium text-primary">{who}</span>
              {(names.model || names.effort) && (
                <span className="text-secondary">
                  {[names.model, names.effort].filter(Boolean).join(' · ')}
                </span>
              )}
              {steps.length > 1 && <span className="text-tertiary">· {nameOf(pick.step)}</span>}
            </p>
            {pick.reason && (
              <p className="text-meta leading-relaxed text-secondary">
                {t('workflow.hint', { hint: pick.reason })}
              </p>
            )}
            {lines && (
              <CheckList
                lines={lines
                  .filter((line) => !(line.ok && line.check === 'step'))
                  .map((line) => ({ ok: line.ok, text: label(line) }))}
                answer=""
              />
            )}
          </div>
        )
      })}
      {!call.checks && <CheckList answer={call.answer} />}
      <NextLine
        next={call.next}
        accepted={call.accepted}
        agent={agent}
        stepName={task ? nameOf(task.stepId) : null}
        nameOf={nameOf}
        retry="retryPick"
      />
      <Details answer={call.answer} />
    </CardShell>
  )
}

/** The card's frame, with a bar on its left in the outcome's color. */
function CardShell({ tone, children }: { tone: 'good' | 'bad' | 'quiet'; children: ReactNode }) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-1.5 rounded-card bg-card py-2.5 pr-3.5 pl-4 text-ui',
        tone === 'good'
          ? 'shadow-[inset_3px_0_0_var(--color-success),var(--card-ring)]'
          : tone === 'bad'
            ? 'shadow-[inset_3px_0_0_var(--color-danger),var(--card-ring)]'
            : 'shadow-card',
      )}
    >
      {children}
    </div>
  )
}

function CardHead({
  icon,
  title,
  badge,
  aside,
}: {
  icon: typeof WORKFLOW_ICON
  title: string
  /** Accepted or refused, or null for no badge. */
  badge: boolean | null
  aside?: ReactNode
}) {
  const { t } = useTranslation('session')
  return (
    <div className="flex min-w-0 items-center gap-1.75">
      <Glyph icon={icon} size={14} className="shrink-0 text-icon" />
      <span className="min-w-0 truncate font-medium text-primary">{title}</span>
      {badge !== null && (
        <span
          className={cn(
            'ml-auto shrink-0 rounded-md px-1.75 text-small leading-5 font-medium',
            badge ? 'bg-success-tint text-success' : 'bg-danger-tint text-danger',
          )}
        >
          {badge ? t('workflow.check.accepted') : t('workflow.check.refused')}
        </span>
      )}
      {aside && <span className="ml-auto flex shrink-0">{aside}</span>}
    </div>
  )
}

function CheckItem({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className="flex min-w-0 items-start gap-1.75 text-secondary">
      <Glyph
        icon={ok ? Tick02Icon : Cancel01Icon}
        size={13}
        className={cn('mt-0.75 shrink-0', ok ? 'text-success' : 'text-danger')}
      />
      <span className="min-w-0 wrap-anywhere">{children}</span>
    </li>
  )
}

/**
 * What Kettu checked, each line ok or what did not hold; without the checks, as an agent's harness
 * may pass on only Kettu's words, the lines those words list as not holding.
 */
function CheckList({
  lines,
  answer,
}: {
  lines?: { ok: boolean; text: string }[] | undefined
  answer: string
}) {
  const shown = lines ?? listedLines(answer).map((text) => ({ ok: false, text }))
  if (shown.length === 0) return null
  return (
    <ul className="flex flex-col gap-0.75">
      {shown.map((line, i) => (
        <CheckItem key={i} ok={line.ok}>
          {line.text}
        </CheckItem>
      ))}
    </ul>
  )
}

/** What happens next, as Kettu decided it; without that, a refusal's retry and nothing else. */
function NextLine({
  next,
  accepted,
  agent,
  stepName,
  nameOf,
  retry,
}: {
  next: CheckNext | null
  accepted: boolean
  agent: string
  stepName: string | null
  nameOf: (id: string) => string
  retry: 'retryReport' | 'retryPick'
}) {
  const { t } = useTranslation('session')
  const list = (ids: string[]) => listOf(ids.map(nameOf))
  let text: string
  if (!next) {
    text = accepted ? '' : t(`workflow.check.next.${retry}`, { agent })
  } else {
    switch (next.kind) {
      case 'review':
        text = t('workflow.check.next.review', { step: stepName ?? '' })
        break
      case 'pick':
        text = t('workflow.check.next.pick', { agent, steps: list(next.steps) })
        break
      case 'start':
      case 'wait':
      case 'person':
        text = t(`workflow.check.next.${next.kind}`, {
          steps: list(next.steps),
          count: next.steps.length,
        })
        break
      case 'end':
        text = t(
          next.end === 'done' ? 'workflow.check.next.endDone' : 'workflow.check.next.endDropped',
        )
        break
      case 'retry':
        text = t(`workflow.check.next.${retry}`, { agent })
        break
      case 'stuck':
        text = t('workflow.check.next.stuck')
        break
    }
  }
  if (!text) return null
  return <p className="text-meta text-primary">{text}</p>
}

/** Kettu's answer as the agent read it, such as the facts a pick is made from. */
function Details({ answer }: { answer: string }) {
  const { t } = useTranslation('session')
  const [open, setOpen] = useState(false)
  if (!answer) return null
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex w-fit items-center gap-1 text-meta text-tertiary hover:text-secondary"
      >
        {open ? t('workflow.check.hideDetails') : t('workflow.check.showDetails')}
        <Glyph
          icon={ArrowDown01Icon}
          size={12}
          className={cn('transition-transform duration-(--duration-fast)', open && 'rotate-180')}
        />
      </button>
      {open && (
        <pre
          data-selectable=""
          className="max-h-80 overflow-auto rounded-lg bg-raised p-2.5 font-mono text-code whitespace-pre-wrap text-secondary"
        >
          {answer}
        </pre>
      )}
    </>
  )
}
