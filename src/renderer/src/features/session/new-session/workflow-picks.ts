// Who does a workflow's step, as option values the agent menu shows and as the pick a task stores.

import { FlowIcon } from '@hugeicons/core-free-icons'
import type { AgentOptions } from '@shared/agent-host'
import {
  stepName,
  usableWorkflow,
  type Workflow,
  type WireWorkflowEntry,
  type WorkflowStep,
  type StepPick,
} from '@shared/workflow'
import type { ConfigOption } from '@shared/thread'
import { shownChoice } from '@renderer/features/session/composer/model-list'
import { i18n } from '@renderer/lib/i18n'

/** The mark of a workflow wherever one is chosen or named. */
export const WORKFLOW_ICON = FlowIcon

/** Only Claude Code and Codex agents work on a workflow's steps. */
const STEP_HARNESSES: ReadonlySet<string> = new Set(['claude-code', 'codex'])

export function runsSteps(status: { harnessId: string }): boolean {
  return STEP_HARNESSES.has(status.harnessId)
}

const isSelect = (option: ConfigOption | undefined): option is ConfigOption =>
  !!option && option.type === 'select' && !!option.choices?.length

function modelOption(entry: AgentOptions | undefined): ConfigOption | undefined {
  const option = entry?.config.find((o) => o.category === 'model')
  return isSelect(option) ? option : undefined
}

function levelOption(
  entry: AgentOptions | undefined,
  model: string | null,
): ConfigOption | undefined {
  const own = model === null ? undefined : entry?.levels[model]
  const option = own ?? entry?.config.find((o) => o.category === 'thought_level')
  return isSelect(option) ? option : undefined
}

/** The names a pick shows: its model's and its effort's, as the agent lists them. */
export function pickNames(
  entry: AgentOptions | undefined,
  pick: StepPick,
): { model: string | null; effort: string | null } {
  const model = modelOption(entry)
  const modelName =
    pick.model === null
      ? null
      : model?.choices
        ? (shownChoice(model.choices, pick.model)?.name ?? pick.model)
        : pick.model
  const level = levelOption(entry, pick.model)
  const effortName =
    pick.effort === null
      ? null
      : (level?.choices?.find((c) => c.value === pick.effort)?.name ?? pick.effort)
  return { model: modelName, effort: effortName }
}

/** A workflow's name in the interface's language. */
export function workflowName(entry: WireWorkflowEntry): string {
  return entry.workflow?.locales[i18n.language]?.name ?? entry.name
}

/** A step's name in the interface's language. */
export function localStepName(workflow: Workflow, stepId: string): string {
  return stepName(workflow, stepId, i18n.language)
}

/** Names as one phrase in the interface's language, "Design and Plan". */
export function listOf(names: string[]): string {
  return new Intl.ListFormat(i18n.language, { type: 'conjunction' }).format(names)
}

/** The steps in order as one line, "Research → Design → Build". */
export function stepChain(workflow: Workflow): string {
  return workflow.steps.map((step) => localStepName(workflow, step.id)).join(' → ')
}

/** Why a workflow cannot start a task, or null for one that can. */
export function workflowBlocked(
  entry: WireWorkflowEntry,
): 'approval' | 'changed' | 'unreadable' | null {
  if (entry.workflow === null || entry.problems.length > 0) return 'unreadable'
  if (usableWorkflow(entry)) return null
  return entry.approval === 'changed' ? 'changed' : 'approval'
}

/** How a step's agent is chosen, as its row says it. */
export type StepSource = 'first' | 'pinned' | 'task' | 'auto' | 'you'

export function stepSource(
  step: WorkflowStep,
  index: number,
  workflowPins: Record<string, StepPick>,
  taskPins: Record<string, StepPick>,
): StepSource {
  if (step.by === 'you') return 'you'
  if (index === 0) return 'first'
  if (taskPins[step.id]) return 'task'
  if (workflowPins[step.id]) return 'pinned'
  return 'auto'
}
