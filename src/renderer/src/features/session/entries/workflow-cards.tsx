import { memo, useState, type ReactNode, type Ref } from 'react'
import { ArrowDown01Icon, Cancel01Icon, SparklesIcon, Tick02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import {
  LEGACY_OFFICIAL,
  type CheckLine,
  type CheckNext,
  type PickCheck,
  type ReportCheck,
} from '@shared/workflow'
import type { AgentId, ToolEntry } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Glyph } from '@renderer/features/shell/glyph'
import { outcomeTitle, stepTitle } from '@renderer/features/tasks/model'
import { useTaskView } from '@renderer/features/tasks/use-task'
import { cn } from '@renderer/lib/utils'
import { optionsOn, useAgentOptionsStore } from '@renderer/stores/agent-options'
import { agentName } from '@renderer/stores/agents'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { useHostWorkflows } from '@renderer/stores/workflows'
import { useTasksStore } from '@renderer/stores/tasks'
import { openWorkflowMarketplace } from '../new-session/open-task'
import {
  listOf,
  pickNames,
  WORKFLOW_ICON,
  workflowName,
  stepChain,
} from '../new-session/workflow-picks'
import { SuggestionCard } from './suggestion-card'
import {
  cardIdOf,
  listedLines,
  pickOf,
  reportOf,
  savedOf,
  workflowCardOf,
  type PickCall,
  type ReportCall,
} from './workflow-tools'

/**
 * A call of one of Kettu's workflow tools, once it ended, as its card: a suggestion to start a task
 * or a workflow to keep, a workflow refused, and a step's report or pick with what Kettu checked.
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
    tool === 'start' || (tool === 'create' && cardIdOf(entry)) ? (
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
      : library.approval === 'approved' || library.approval === LEGACY_OFFICIAL
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

/**
 * The step session's task: its steps' names by id, and its outcomes' names, in the language shown
 * once its workflow is read, the file's own names until then.
 */
function useStepText(task: { taskId: string; stepId: string } | null) {
  const steps = useTasksStore((s) => (task ? s.summaries[task.taskId]?.steps : undefined))
  const workflow = useTaskView(task?.taskId ?? '', task !== null).view?.workflow
  return {
    nameOf: (id: string) =>
      stepTitle(workflow, id, steps?.find((step) => step.id === id)?.name ?? id),
    outcomeOf: (outcome: string) => (task ? outcomeTitle(workflow, task.stepId, outcome) : outcome),
  }
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
  const { nameOf, outcomeOf } = useStepText(task)
  const outcome = call.outcome ? outcomeOf(call.outcome) : null
  const label = (line: CheckLine<ReportCheck>): string => {
    if (!line.ok && line.detail) return line.detail
    if (line.check === 'outcome') {
      return outcome
        ? t('workflow.check.lines.report.outcome', { outcome })
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
        title={outcome ? t('workflow.check.report', { outcome }) : t('workflow.check.reportPlain')}
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
  'answered',
  'outcome',
  'note',
  'document',
  'deliverables',
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
  const { nameOf } = useStepText(task)
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
