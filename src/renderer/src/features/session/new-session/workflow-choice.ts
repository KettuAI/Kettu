import { create } from 'zustand'
import type { Pace } from '@shared/workflow'
import { readJson, writeJson } from '@renderer/lib/storage'

// Whether New session starts a project's next message as a task through a workflow, and which,
// remembered per project in localStorage under `workflow-choice` as the worktree choice is; with the
// pace of the task being written, which lasts only while it is written.

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
}

export const useWorkflowChoice = create<WorkflowChoiceStore>(() => ({
  chosen: load(),
  pace: 'balanced',
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

/** The task was started: its pace starts afresh for the next one. */
export function taskStarted(): void {
  useWorkflowChoice.setState({ pace: 'balanced' })
}
