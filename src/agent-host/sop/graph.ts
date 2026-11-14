// Questions about an SOP's flowchart that the engine asks while a task moves.

import { stepIndex, type Sop, type SopOutcome, type SopStep } from '@shared/sop'

export function stepOf(sop: Sop, stepId: string): SopStep | undefined {
  return sop.steps.find((step) => step.id === stepId)
}

/** The step's outcome by name, matched without case, as agents may write it either way. */
export function outcomeOf(step: SopStep, name: string): SopOutcome | undefined {
  const key = name.trim().toLowerCase()
  return step.outcomes.find((outcome) => outcome.name.toLowerCase() === key)
}

/**
 * The steps `from` leads to through forward arrows alone, without itself. Forward arrows go to
 * later steps only, so this never loops; an arrow back starts a step over rather than leading on.
 */
export function forwardReach(sop: Sop, from: string): Set<string> {
  const seen = new Set<string>()
  const queue = [from]
  while (queue.length > 0) {
    const id = queue.shift()!
    const at = stepIndex(sop, id)
    for (const outcome of stepOf(sop, id)?.outcomes ?? []) {
      for (const to of outcome.to) {
        if (stepIndex(sop, to) > at && !seen.has(to)) {
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
