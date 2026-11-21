// What a task's row, card and page say about it, from its summary and its full view.

import type { SessionSummary } from '@shared/agent-host'
import { harnessOf } from '@shared/agents'
import {
  outcomeName,
  stepIndex,
  stepName,
  type BlockedReason,
  type PickedBy,
  type RoundView,
  type Workflow,
  type StepPick,
  type StuckReason,
  type TaskNeed,
  type TaskStepSummary,
  type TaskSummary,
  type TaskView,
} from '@shared/workflow'
import type { AgentId } from '@shared/thread'
import type { RowStatus } from '@renderer/features/sidebar/row-status'
import { i18n } from '@renderer/lib/i18n'
import { agentName } from '@renderer/stores/agents'
import { optionsOn, useAgentOptionsStore } from '@renderer/stores/agent-options'
import { useShallow } from 'zustand/react/shallow'

const t = i18n.getFixedT(null, 'tasks')

/** Only these harnesses can do a step. */
export const STEP_HARNESSES: readonly string[] = ['claude-code', 'codex']

export function canDoSteps(agentId: AgentId): boolean {
  return STEP_HARNESSES.includes(harnessOf(agentId))
}

const failed = (summary: SessionSummary | undefined): boolean =>
  summary?.attention === 'error' || summary?.status === 'failed'

/**
 * A task row's one status, by the session row's priority: its own, and folded, the loudest of its
 * steps' sessions as well.
 */
export function taskRowStatus(
  task: TaskSummary,
  sessions: readonly (SessionSummary | undefined)[],
  folded: boolean,
  view?: TaskView,
): RowStatus {
  const live = task.status === 'running'
  // A stuck step is the task's error; what else waits is for you. The summary alone cannot tell
  // a stuck task that also waits for a review, which its view can.
  const waits = view
    ? view.needs.filter((need) => need.kind !== 'stuck' && need.kind !== 'end_merge').length
    : task.needsYou && !task.error
      ? 1
      : 0
  const own: RowStatus = {
    waiting: live ? waits : 0,
    failed: live && task.error,
    running: live && task.running,
    starting: live && sessions.some((s) => s?.status === 'starting'),
    unread: task.unread,
  }
  if (!folded) return own
  return {
    waiting: own.waiting + sessions.reduce((n, s) => n + (s?.permissionCount ?? 0), 0),
    failed: own.failed || sessions.some(failed),
    running: own.running,
    starting: own.starting,
    unread: own.unread || sessions.some((s) => s?.attention === 'unread'),
  }
}

/**
 * A step row's status, its own session's alone: at work, asking for an answer, failed or unread. A
 * document waiting for review is the task's, so its row shows it.
 */
export function stepRowStatus(
  step: TaskStepSummary,
  summary: SessionSummary | undefined,
  round: RoundView | undefined,
): RowStatus {
  const asking = summary ? summary.permissionCount : round?.asking ? 1 : 0
  return {
    waiting: asking,
    failed: step.state === 'error' || failed(summary),
    running: step.state === 'running' && summary?.status !== 'starting',
    starting: summary?.status === 'starting',
    unread: summary?.attention === 'unread',
  }
}

/** The step's latest round, as the session it resumes or started names it. */
export function latestRound(view: TaskView | undefined, stepId: string): RoundView | undefined {
  return view?.rounds.findLast((round) => round.stepId === stepId)
}

/** A step's name in the language shown, from the workflow's own locale when it has one. */
export function stepTitle(
  workflow: Workflow | undefined,
  stepId: string,
  fallback?: string,
): string {
  if (!workflow) return fallback ?? stepId
  return stepName(workflow, stepId, i18n.language)
}

/** An outcome's name in the language shown; a step still reports the file's own name. */
export function outcomeTitle(
  workflow: Workflow | undefined,
  stepId: string,
  outcome: string,
): string {
  return workflow ? outcomeName(workflow, stepId, outcome, i18n.language) : outcome
}

/** The workflow's name in the language shown. */
export function workflowTitle(task: TaskSummary, view: TaskView | undefined): string {
  return view?.workflow.locales[i18n.language]?.name ?? task.workflowName
}

/** Which step it is on, for step/total: the furthest that started, while the task runs. */
export function progressText(task: TaskSummary): string | null {
  if (task.status !== 'running' || task.at === null) return null
  return t('progress', { at: task.at, total: task.steps.length })
}

/** A model's or an effort's name as its agent lists it, else the value itself. */
export function useModelText(
  hostId: string | null,
  pick: StepPick | null,
): { model: string | null; effort: string | null } {
  return useAgentOptionsStore(useShallow((s) => modelTextOf(s, hostId, pick)))
}

/** The names of a pick's model and effort in the host's cached options, as far as known. */
export function modelTextOf(
  s: Parameters<typeof optionsOn>[0],
  hostId: string | null,
  pick: StepPick | null,
): { model: string | null; effort: string | null } {
  if (!pick) return NO_MODEL
  const entry = optionsOn(s, hostId)[pick.agentId]
  const option = entry?.config.find((o) => o.category === 'model')
  const model = pick.model
    ? (option?.choices?.find((c) => c.value === pick.model)?.name ?? pick.model)
    : null
  const level =
    (pick.model ? entry?.levels[pick.model] : undefined) ??
    entry?.config.find((o) => o.category === 'thought_level')
  const effort = pick.effort
    ? (level?.choices?.find((c) => c.value === pick.effort)?.name ?? pick.effort)
    : null
  return { model, effort }
}

const NO_MODEL = { model: null, effort: null }

/** "Claude Code · Sonnet 5.5 · Medium", as far as each is known. */
export function pickLine(
  pick: StepPick,
  hostId: string | null,
  text: { model: string | null; effort: string | null },
): string {
  return [agentName(pick.agentId, hostId), text.model, text.effort]
    .filter(Boolean)
    .join(t('separator'))
}

/** How a round's agent was chosen, in a few words. */
export function pickedByText(pickedBy: PickedBy, view: TaskView): string {
  switch (pickedBy.kind) {
    case 'first':
      return t('picked.first')
    case 'task_pin':
      return t('picked.taskPin')
    case 'workflow_pin':
      return t('picked.workflowPin')
    case 'agent':
      return t('picked.agent', { step: stepTitle(view.workflow, pickedBy.stepId) })
    case 'previous': {
      const round = view.rounds.find((r) => r.id === pickedBy.roundId)
      return round ? t('picked.previous', { n: round.n }) : t('picked.previousAny')
    }
    case 'person':
      return t('picked.person')
  }
}

/** The steps whose forward arrows lead to `stepId`. */
function stepsBefore(view: Pick<TaskView, 'workflow'>, stepId: string) {
  const at = stepIndex(view.workflow, stepId)
  return view.workflow.steps.filter(
    (s) => stepIndex(view.workflow, s.id) < at && s.outcomes.some((o) => o.to.includes(stepId)),
  )
}

/**
 * Who will pick a step's agent before it starts: the step whose arrow leads to it, or past a
 * person's step, which picks nothing, the agent's step before that; at a join, the last branch to
 * finish; nobody for the first step, which the tray chose.
 */
export function whoPicksText(view: Pick<TaskView, 'workflow' | 'pins'>, stepId: string): string {
  const step = view.workflow.steps.find((s) => s.id === stepId)
  if (!step) return ''
  if (step.by === 'you') return t('picked.person')
  if (view.pins[stepId]) return t('picked.taskPin')
  let from = stepsBefore(view, stepId)
  const seen = new Set<string>()
  while (from.length === 1 && from[0]!.by === 'you' && !seen.has(from[0]!.id)) {
    seen.add(from[0]!.id)
    from = stepsBefore(view, from[0]!.id)
  }
  if (stepIndex(view.workflow, stepId) === 0 || from.length === 0) return t('picked.first')
  if (from.length > 1) return t('picks.join')
  return t('picks.by', { step: stepTitle(view.workflow, from[0]!.id) })
}

/** What a stuck step ran into, in words. */
export function stuckText(reason: StuckReason, step: string): string {
  return t(`stuck.${reason}`, { step })
}

/** Why a step cannot start, in words. */
export function blockedText(reason: BlockedReason, hostId: string | null, now: number): string {
  switch (reason.kind) {
    case 'limit':
      return reason.resetsAt
        ? t('blocked.limitAt', {
            agent: agentName(reason.agentId, hostId),
            time: new Date(reason.resetsAt).toLocaleTimeString(i18n.language, {
              hour: 'numeric',
              minute: '2-digit',
              ...(reason.resetsAt - now > 20 * 60 * 60 * 1000 ? { weekday: 'short' } : {}),
            }),
          })
        : t('blocked.limit', { agent: agentName(reason.agentId, hostId) })
    case 'unusable':
      return t(`blocked.${reason.why}`, { agent: agentName(reason.agentId, hostId) })
    case 'tools':
      return t('blocked.tools', { tools: reason.missing.join(', ') })
    case 'no_agent':
      return t('blocked.noAgent')
    case 'no_picker':
      return t('blocked.noPicker')
    case 'picking':
      return t('blocked.picking')
  }
}

/** A key for a need, stable while it waits. */
export function needKey(need: TaskNeed): string {
  switch (need.kind) {
    case 'person':
    case 'review':
    case 'asking':
    case 'stuck':
      return `${need.kind}:${need.roundId}`
    case 'blocked':
    case 'end_merge':
      return `${need.kind}:${need.stepId}`
  }
}

/** Where the steps after `stepId` lead, by name, for an Approve button: the next steps or the end. */
export function nextAfter(view: TaskView, round: RoundView): string | null {
  const step = view.workflow.steps.find((s) => s.id === round.stepId)
  const outcome = step?.outcomes.find((o) => o.name === round.outcome) ?? step?.outcomes[0]
  if (!outcome) return null
  if (outcome.end) return null
  return outcome.to.map((id) => stepTitle(view.workflow, id)).join(t('and'))
}

/** A step's state in a word, as a card or a node says it. */
export type Word =
  | 'done'
  | 'running'
  | 'review'
  | 'yourTurn'
  | 'asking'
  | 'blocked'
  | 'needsYou'
  | 'failed'
  | 'waiting'

/** The word for a step's state, from its round when the view is read; null for one not reached. */
export function stepWord(step: TaskStepSummary, view: TaskView | undefined): Word | null {
  switch (step.state) {
    case 'done':
      return 'done'
    case 'running':
      return 'running'
    case 'error':
      return 'failed'
    case 'waiting':
      return 'waiting'
    case 'not_reached':
      return null
    case 'needs_you': {
      const round = latestRound(view, step.id)
      if (!view) return 'needsYou'
      if (round?.state === 'reviewing') return 'review'
      if (round?.state === 'person') return 'yourTurn'
      if (round?.asking) return 'asking'
      if (view.waiting.some((w) => w.stepId === step.id && w.blocked)) return 'blocked'
      return 'needsYou'
    }
  }
}
