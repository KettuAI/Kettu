import { create } from 'zustand'
import type { Pace, StepPick } from '@shared/workflow'
import { readJson, writeJson } from '@renderer/lib/storage'

// Whether New session starts a project's next message as a task through a workflow, and which,
// remembered per project in localStorage under `workflow-choice` as the worktree choice is; with the
// pace and the steps pinned for the task being written, which last only while it is written.

const KEY = 'workflow-choice'

function load(): Record<string, string> {
  const parsed = readJson<unknown>(KEY, {})
  if (typeof parsed !== 'object' || parsed === null) return {}
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}

interface WorkflowChoiceStore {
  /** Each project's workflow by id; a project not listed starts as Chat. */
  chosen: Record<string, string>
  pace: Pace
  /** Who does steps of the task being written, by step id, for the workflow they were set on. */
  pins: { workflowId: string; steps: Record<string, StepPick> } | null
}

export const useWorkflowChoice = create<WorkflowChoiceStore>(() => ({
  chosen: load(),
  pace: 'balanced',
  pins: null,
}))

/** Chooses the project's workflow, or Chat with null. */
export function chooseWorkflow(projectPath: string, workflowId: string | null): void {
  useWorkflowChoice.setState((s) => {
    const chosen = { ...s.chosen }
    if (workflowId === null) delete chosen[projectPath]
    else chosen[projectPath] = workflowId
    return { chosen }
  })
  writeJson(KEY, useWorkflowChoice.getState().chosen)
}

export function choosePace(pace: Pace): void {
  useWorkflowChoice.setState({ pace })
}

/** Pins a step for the task being written, or sets it back to Auto with null. */
export function pinStep(workflowId: string, stepId: string, pick: StepPick | null): void {
  useWorkflowChoice.setState((s) => {
    const steps = { ...(s.pins?.workflowId === workflowId ? s.pins.steps : {}) }
    if (pick === null) delete steps[stepId]
    else steps[stepId] = pick
    return { pins: { workflowId, steps } }
  })
}

/** The steps pinned for a task through the workflow. */
export function taskPins(
  s: Pick<WorkflowChoiceStore, 'pins'>,
  workflowId: string,
): Record<string, StepPick> {
  return s.pins?.workflowId === workflowId ? s.pins.steps : NO_PINS
}

const NO_PINS: Record<string, StepPick> = {}

/** The task was started: its pace and pins start afresh for the next one. */
export function taskStarted(): void {
  useWorkflowChoice.setState({ pace: 'balanced', pins: null })
}
