// The checks a stage's submission must pass: its output contract, and the evidence the host found
// in the session's own tool calls. A failure is worded for the agent, which fixes it and submits
// again while its round stays open.

import { NOTE_CHARS, type AgentStage, type ContractField } from '@shared/tasks'
import type { StageEvidence, StageSubmission } from './api'

const LIST_ITEMS = 200
const ITEM_CHARS = 4000

export type CheckResult =
  { ok: true; fields: StageSubmission['fields'] } | { ok: false; error: string }

/** Collapses runs of whitespace, so a reported command matches however it was spaced. */
export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ')
}

/** Whether `reported` ran: some executed command equals it or contains it. */
export function commandRan(reported: string, ran: readonly string[]): boolean {
  const wanted = normalizeCommand(reported)
  if (wanted === '') return false
  return ran.some((command) => normalizeCommand(command).includes(wanted))
}

function fieldError(field: ContractField, value: unknown): string | null {
  switch (field.type) {
    case 'text':
      if (typeof value !== 'string') return `"${field.name}" must be text`
      if (value.length > NOTE_CHARS)
        return `"${field.name}" is longer than ${NOTE_CHARS} characters`
      if (field.required && value.trim() === '') return `"${field.name}" is empty`
      return null
    case 'list':
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
        return `"${field.name}" must be a list of strings`
      }
      if (value.length > LIST_ITEMS) return `"${field.name}" has more than ${LIST_ITEMS} entries`
      if (value.some((item: string) => item.length > ITEM_CHARS)) {
        return `an entry of "${field.name}" is longer than ${ITEM_CHARS} characters`
      }
      if (field.required && value.length === 0) return `"${field.name}" is empty`
      return null
    case 'size':
      return value === 'S' || value === 'M' || value === 'L'
        ? null
        : `"${field.name}" must be one of S, M or L`
    case 'risk':
      return typeof value === 'boolean' ? null : `"${field.name}" must be true or false`
  }
}

function evidenceError(
  stage: AgentStage,
  fields: StageSubmission['fields'],
  evidence: StageEvidence,
): string | null {
  for (const kind of stage.evidence) {
    switch (kind) {
      case 'ran-command':
        if (evidence.commands.length === 0) {
          return 'This stage needs at least one command run in this session, and none ran during the stage. Run the commands the stage asks for, then submit again.'
        }
        break
      case 'reported-commands-ran': {
        const reported = fields.commands
        if (!Array.isArray(reported) || reported.length === 0) {
          return 'List the commands you ran in the "commands" field; each must have run in this session during the stage.'
        }
        const missing = reported.filter((command) => !commandRan(command, evidence.commands))
        if (missing.length > 0) {
          return `These reported commands did not run in this session during the stage: ${missing
            .map((command) => `"${command}"`)
            .join(', ')}. Run them, or report only the commands you ran, then submit again.`
        }
        break
      }
      case 'changed-files':
        if (evidence.changedFiles.length === 0) {
          return 'This stage must change files, and no file changed during the stage. Make the changes, then submit again.'
        }
        break
      case 'no-file-changes':
        if (evidence.changedFiles.length > 0) {
          return `This stage must not change files, and these changed: ${evidence.changedFiles
            .slice(0, 20)
            .join(', ')}. Undo them, then submit again.`
        }
        break
    }
  }
  return null
}

/**
 * Checks a submission against its stage. A `blocked` verdict needs only a summary, since the agent
 * could not do the work; `pass` and `changes` need the whole contract and the evidence.
 */
export function checkSubmission(
  stage: AgentStage,
  submission: StageSubmission,
  evidence: StageEvidence,
): CheckResult {
  if (submission.summary.trim() === '') return { ok: false, error: 'The summary is empty.' }
  if (submission.summary.length > NOTE_CHARS) {
    return { ok: false, error: `The summary is longer than ${NOTE_CHARS} characters.` }
  }
  if (submission.verdict === 'changes' && !stage.rework) {
    return {
      ok: false,
      error: 'This stage cannot send work back. Submit "pass", or "blocked" with the reason.',
    }
  }
  const fields: StageSubmission['fields'] = {}
  const problems: string[] = []
  for (const field of stage.contract) {
    const value = submission.fields[field.name]
    if (value === undefined) {
      if (field.required && submission.verdict !== 'blocked') {
        problems.push(`"${field.name}" is missing (${field.type}: ${field.description})`)
      }
      continue
    }
    const error = fieldError(field, value)
    if (!error) fields[field.name] = value
    else if (submission.verdict !== 'blocked') problems.push(error)
  }
  if (submission.verdict === 'blocked') return { ok: true, fields }
  if (problems.length > 0) {
    return {
      ok: false,
      error: `The result does not meet the stage's contract: ${problems.join('; ')}.`,
    }
  }
  const error = evidenceError(stage, submission.fields, evidence)
  return error ? { ok: false, error } : { ok: true, fields }
}
