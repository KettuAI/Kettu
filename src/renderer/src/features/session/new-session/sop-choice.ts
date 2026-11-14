import { create } from 'zustand'
import type { Pace, StepPick } from '@shared/sop'
import { readJson, writeJson } from '@renderer/lib/storage'

// Whether New session starts a project's next message as a task through an SOP, and which,
// remembered per project in localStorage under `sop-choice` as the worktree choice is; with the
// pace and the steps pinned for the task being written, which last only while it is written.

const KEY = 'sop-choice'

function load(): Record<string, string> {
  const parsed = readJson<unknown>(KEY, {})
  if (typeof parsed !== 'object' || parsed === null) return {}
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}

interface SopChoiceStore {
  /** Each project's SOP by id; a project not listed starts as Chat. */
  chosen: Record<string, string>
  pace: Pace
  /** Who does steps of the task being written, by step id, for the SOP they were set on. */
  pins: { sopId: string; steps: Record<string, StepPick> } | null
}

export const useSopChoice = create<SopChoiceStore>(() => ({
  chosen: load(),
  pace: 'balanced',
  pins: null,
}))

/** Chooses the project's SOP, or Chat with null. */
export function chooseSop(projectPath: string, sopId: string | null): void {
  useSopChoice.setState((s) => {
    const chosen = { ...s.chosen }
    if (sopId === null) delete chosen[projectPath]
    else chosen[projectPath] = sopId
    return { chosen }
  })
  writeJson(KEY, useSopChoice.getState().chosen)
}

export function choosePace(pace: Pace): void {
  useSopChoice.setState({ pace })
}

/** Pins a step for the task being written, or sets it back to Auto with null. */
export function pinStep(sopId: string, stepId: string, pick: StepPick | null): void {
  useSopChoice.setState((s) => {
    const steps = { ...(s.pins?.sopId === sopId ? s.pins.steps : {}) }
    if (pick === null) delete steps[stepId]
    else steps[stepId] = pick
    return { pins: { sopId, steps } }
  })
}

/** The steps pinned for a task through the SOP. */
export function taskPins(s: Pick<SopChoiceStore, 'pins'>, sopId: string): Record<string, StepPick> {
  return s.pins?.sopId === sopId ? s.pins.steps : NO_PINS
}

const NO_PINS: Record<string, StepPick> = {}

/** The task was started: its pace and pins start afresh for the next one. */
export function taskStarted(): void {
  useSopChoice.setState({ pace: 'balanced', pins: null })
}
