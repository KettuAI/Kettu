import { harnessOf } from '@shared/agents'
import type { AgentId } from '@shared/thread'
import type { StageRunView, TaskView } from '@shared/tasks'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage } from '@renderer/lib/host'

/** The name of one of the task's stages, or null for none or one it does not have. */
export function stageName(task: Pick<TaskView, 'stages'>, stageId: string | null): string | null {
  if (stageId === null) return null
  return task.stages.find((stage) => stage.id === stageId)?.name ?? null
}

/** Only the harnesses whose permissions Kettu controls run a task's stages. */
export function runsStages(agentId: AgentId): boolean {
  const harness = harnessOf(agentId)
  return harness === 'claude-code' || harness === 'codex'
}

export type StageMark = 'done' | 'current' | 'skipped' | 'upcoming'

/**
 * Each stage of the task as its track draws it: done when its latest round passed, skipped when
 * that round was skipped, current while the task is on it, upcoming otherwise.
 */
export function stageMarks(task: TaskView, runs: readonly StageRunView[]): StageMark[] {
  const latest = new Map<string, StageRunView>()
  for (const run of runs) {
    const seen = latest.get(run.stageId)
    if (!seen || run.startedAt > seen.startedAt) latest.set(run.stageId, run)
  }
  return task.stages.map((stage) => {
    if (task.stageId === stage.id && task.state !== 'done' && task.state !== 'cancelled') {
      return 'current'
    }
    const run = latest.get(stage.id)
    if (run?.state === 'skipped') return 'skipped'
    if (run?.state === 'passed') return 'done'
    if (task.state === 'done' && run) return 'done'
    return 'upcoming'
  })
}

/** The stages a send-back may offer: any agent stage while blocked, else the human stage's own. */
export function sendBackTargets(task: TaskView): string[] {
  const agents = task.stages.filter((stage) => stage.kind === 'agent')
  if (task.state === 'blocked') return agents.map((stage) => stage.id)
  return task.stages.find((stage) => stage.id === task.stageId)?.sendBack ?? []
}

/** Whether the task waits for the person's decision: on a human stage, or blocked. */
export function awaitsDecision(task: TaskView): boolean {
  if (task.state === 'blocked') return true
  if (task.state !== 'waiting') return false
  return task.stages.find((stage) => stage.id === task.stageId)?.kind === 'human'
}

/** What the person can do to a task in its state. */
export function taskActions(task: TaskView): {
  start: boolean
  pause: boolean
  resume: boolean
  cancel: boolean
} {
  const ended = task.state === 'done' || task.state === 'cancelled'
  return {
    start: task.state === 'backlog',
    pause: task.state === 'queued' || task.state === 'running' || task.state === 'waiting',
    resume: task.state === 'paused',
    cancel: !ended,
  }
}

export function taskMenuHasItems(task: TaskView): boolean {
  return Object.values(taskActions(task)).some(Boolean)
}

/** Runs a task action, saying in a toast why it failed. */
export function runTaskAction(action: () => Promise<void>): void {
  action().catch((error: unknown) => toast(errorMessage(error)))
}
