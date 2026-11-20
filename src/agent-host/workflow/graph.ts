// Questions about a workflow's flowchart that the engine asks while a task moves.

import { stepIndex, type Workflow, type WorkflowOutcome, type WorkflowStep } from '@shared/workflow'

export function stepOf(workflow: Workflow, stepId: string): WorkflowStep | undefined {
  return workflow.steps.find((step) => step.id === stepId)
}

/** The step's outcome by name, matched without case, as agents may write it either way. */
export function outcomeOf(step: WorkflowStep, name: string): WorkflowOutcome | undefined {
  const key = name.trim().toLowerCase()
  return step.outcomes.find((outcome) => outcome.name.toLowerCase() === key)
}

/**
 * The steps `from` leads to through forward arrows alone, without itself. Forward arrows go to
 * later steps only, so this never loops; an arrow back starts a step over rather than leading on.
 */
export function forwardReach(workflow: Workflow, from: string): Set<string> {
  const seen = new Set<string>()
  const queue = [from]
  while (queue.length > 0) {
    const id = queue.shift()!
    const at = stepIndex(workflow, id)
    for (const outcome of stepOf(workflow, id)?.outcomes ?? []) {
      for (const to of outcome.to) {
        if (stepIndex(workflow, to) > at && !seen.has(to)) {
          seen.add(to)
          queue.push(to)
        }
      }
    }
  }
  return seen
}

/** The key an arrow's trips are counted under; a review sent back has its own. */
export function arrowKey(stepId: string, outcome: string | null): string {
  return outcome === null ? `${stepId}#review` : `${stepId}/${outcome}`
}

/**
 * Whether two workflows have the same steps and arrows: who does each step, what it hands in, who
 * reviews it and where each outcome goes. Names, prompts and descriptions may differ.
 */
export function sameFlow(a: Workflow, b: Workflow): boolean {
  const shape = (workflow: Workflow) =>
    JSON.stringify(
      workflow.steps.map((step) => [
        step.id,
        step.by,
        step.handIn,
        step.youReview,
        step.reviewOf,
        step.outcomes.map((o) => [o.name, o.to, o.end, o.limit]),
      ]),
    )
  return a.sendBackLimit === b.sendBackLimit && shape(a) === shape(b)
}
