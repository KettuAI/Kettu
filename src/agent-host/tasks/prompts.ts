// The messages a stage session gets: the first one of a round, a rework round's, the reminder after
// a turn that ended without a result, and the one after a restart. The summary the pull request
// carries is written here too.

import type { AgentStage, Evidence, WorkflowStage } from '@shared/tasks'
import type { StageRunRecord, TaskRecord } from './api'

export const SUBMIT_TOOL = 'submit_stage'

/** An earlier stage's accepted result, as the next stages are told it. */
export interface EarlierResult {
  stage: WorkflowStage
  run: StageRunRecord
}

const EVIDENCE_TEXT: Record<Evidence, string> = {
  'ran-command': 'at least one command ran in this session during the stage',
  'reported-commands-ran':
    'every command you list in "commands" ran in this session during the stage',
  'changed-files': 'files changed during the stage',
  'no-file-changes': 'no file changed during the stage',
}

const SCOPE_TEXT: Record<AgentStage['scope']['level'], string> = {
  read: 'This stage only reads: do not change files.',
  edit: 'This stage may read and change files in the working folder.',
  commands: 'This stage may read and change files and run commands in the working folder.',
}

function fieldValue(value: string | string[] | boolean): string {
  if (Array.isArray(value)) return value.length === 0 ? '(none)' : value.join('; ')
  return String(value)
}

function fieldsText(fields: StageRunRecord['fields']): string {
  return Object.entries(fields)
    .map(([name, value]) => `- ${name}: ${fieldValue(value)}`)
    .join('\n')
}

function earlierText(earlier: readonly EarlierResult[]): string {
  return earlier
    .map(({ stage, run }) => {
      const fields = fieldsText(run.fields)
      return [`### ${stage.name}`, run.summary ?? '', fields].filter(Boolean).join('\n')
    })
    .join('\n\n')
}

/** What the stage must submit, and how. */
export function contractText(stage: AgentStage): string {
  const verdicts = stage.rework
    ? '"pass" when the stage is done, "changes" to send the work back with what must change, or "blocked" when you cannot go on and a person must decide'
    : '"pass" when the stage is done, or "blocked" when you cannot go on and a person must decide'
  const lines = [
    `When the stage is done, finish by calling the \`${SUBMIT_TOOL}\` tool once, with:`,
    `- verdict: ${verdicts}`,
    '- summary: what you did and found, for the next stages and the person',
  ]
  if (stage.contract.length > 0) {
    lines.push('- fields:')
    for (const field of stage.contract) {
      const type =
        field.type === 'list'
          ? 'list of strings'
          : field.type === 'size'
            ? 'S, M or L'
            : field.type === 'risk'
              ? 'true or false'
              : 'text'
      lines.push(
        `  - ${field.name} (${type}${field.required ? ', required' : ''}): ${field.description}`,
      )
    }
  }
  if (stage.evidence.length > 0) {
    lines.push(
      `Kettu checks your session's own tool calls, not your words: ${stage.evidence
        .map((kind) => EVIDENCE_TEXT[kind])
        .join('; ')}.`,
    )
  }
  lines.push(
    `If \`${SUBMIT_TOOL}\` refuses the result, fix what it names and call it again. Do not end your turn without calling it.`,
  )
  return lines.join('\n')
}

/** The first message of a round in a new session. */
export function stageMessage(params: {
  task: TaskRecord
  stage: AgentStage
  earlier: readonly EarlierResult[]
  notes: string | null
  round: number
}): string {
  const { task, stage, earlier, notes, round } = params
  const parts = [
    `You are working on the "${stage.name}" stage of a task Kettu runs through the "${task.workflow.name}" workflow${round > 1 ? ` (round ${round})` : ''}. Kettu moves the task between stages; your part is this stage only.`,
    stage.prompt.trim(),
    `## Requirement\n\n# ${task.title}\n\n${task.requirement.trim()}`,
  ]
  if (earlier.length > 0) parts.push(`## Earlier stages\n\n${earlierText(earlier)}`)
  if (notes)
    parts.push(`## Sent back\n\nThe work came back to this stage with these notes:\n\n${notes}`)
  parts.push(`## Scope\n\n${SCOPE_TEXT[stage.scope.level]}`)
  parts.push(`## Result\n\n${contractText(stage)}`)
  return parts.join('\n\n')
}

/** The message that starts a later round in the stage's own session. */
export function reworkMessage(stage: AgentStage, notes: string | null, round: number): string {
  const parts = [
    `The task came back to the "${stage.name}" stage (round ${round}).`,
    notes ? `Notes:\n\n${notes}` : 'No notes were given; check the work again.',
    `Address them, then submit this stage's whole result again.\n\n${contractText(stage)}`,
  ]
  return parts.join('\n\n')
}

/** Sent once when a turn ended without a result. */
export function reminderMessage(stage: AgentStage): string {
  return `Your turn ended without a result for the "${stage.name}" stage. If the work is done, call \`${SUBMIT_TOOL}\` now; if not, finish it first. If you cannot go on, submit "blocked" with the reason.`
}

/** Sent to the stage's session when its round was cut off, by a restart or a pause. */
export function recoveryMessage(stage: AgentStage): string {
  return `The "${stage.name}" stage was interrupted. Check where the work stands, carry on, and call \`${SUBMIT_TOOL}\` when it is done.\n\n${contractText(stage)}`
}

/** The notes a `changes` result sends to the stage it goes back to. */
export function notesFromResult(stage: WorkflowStage, run: StageRunRecord): string {
  const fields = fieldsText(run.fields)
  return [`From "${stage.name}": ${run.summary ?? ''}`.trim(), fields].filter(Boolean).join('\n')
}

/** The pull request's summary: the task and what each stage did. */
export function handoverSummary(task: TaskRecord, earlier: readonly EarlierResult[]): string {
  const stages = earlier
    .map(({ stage, run }) => `- ${stage.name}: ${(run.summary ?? '').trim()}`)
    .join('\n')
  return [task.requirement.trim(), stages && `Stages:\n${stages}`].filter(Boolean).join('\n\n')
}
