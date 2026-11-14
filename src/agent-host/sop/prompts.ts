// What a step's agent is told: the first message of its session, the messages when it is sent
// back or reminded, and the facts it picks from. Agents read these, so they are English whatever
// the user's language.

import { stepIndex, type SopOutcome, type SopStep } from '@shared/sop'
import { SERVICE_NAME } from '../service-name'
import { stepOf } from './graph'
import type { RoundRecord, TaskRecord } from './model'

export const REPORT_TOOL = 'sop_report'
export const PICK_TOOL = 'sop_pick'

/** What every step session is told about how the flow works, once. */
const HOW =
  `Kettu moves the task along the SOP; you never start, skip or end steps yourself. When your ` +
  `step is done, call \`${REPORT_TOOL}\` of the \`${SERVICE_NAME}\` MCP server with one of the ` +
  `outcomes below and what the step hands in. Kettu checks the report and refuses it with what ` +
  `to fix when something is missing; fix it and report again. Do not end your turn before your ` +
  `report is accepted.`

function arrowText(task: TaskRecord, step: SopStep, outcome: SopOutcome): string {
  if (outcome.end === 'done') return 'ends the task as done'
  if (outcome.end === 'dropped') return 'ends the task without doing it'
  const names = outcome.to.map((id) => `"${stepOf(task.sop, id)?.name ?? id}"`).join(' and ')
  const back = outcome.to.some((id) => stepIndex(task.sop, id) <= stepIndex(task.sop, step.id))
  if (back) return `sends the work back to ${names}; say in the note what must change`
  return outcome.to.length > 1 ? `starts ${names} at once` : `goes on to ${names}`
}

function handInText(step: SopStep): string {
  switch (step.handIn) {
    case 'document':
      return (
        'Write your result as a document artifact with `create_artifact_from_type` (type ' +
        '`document`), or a new version of the one you wrote before, and pass its id as ' +
        '`artifact_id`. Only a document this session wrote during this step counts.'
      )
    case 'note':
      return 'Say in `note` what you did and how you checked it.'
    case 'outcome':
      return 'Your outcome is the conclusion; add a `note` with your reasons.'
  }
}

/** The rounds before `round` that handed something in, latest of each step only. */
function earlier(task: TaskRecord, round: RoundRecord): RoundRecord[] {
  const latest = new Map<string, RoundRecord>()
  for (const other of task.rounds) {
    if (other.id === round.id || other.state !== 'done' || other.outcome === null) continue
    if (other.stepId === round.stepId && other.n >= round.n) continue
    latest.set(other.stepId, other)
  }
  return [...latest.values()].sort(
    (a, b) => stepIndex(task.sop, a.stepId) - stepIndex(task.sop, b.stepId),
  )
}

function earlierText(task: TaskRecord, round: RoundRecord): string | null {
  const rounds = earlier(task, round)
  if (rounds.length === 0) return null
  const lines = rounds.map((r) => {
    const step = stepOf(task.sop, r.stepId)
    const parts = [`- ${step?.name ?? r.stepId}: ${r.outcome}`]
    if (r.document) {
      parts.push(
        `  Document "${r.document.title}" (\`${r.document.artifactId}\`, version ${r.document.version}); read it with \`read_artifact\`.`,
      )
    }
    if (r.note) parts.push(`  Note: ${r.note.replace(/\n/g, '\n  ')}`)
    return parts.join('\n')
  })
  return lines.join('\n')
}

function sentBackText(task: TaskRecord, round: RoundRecord): string | null {
  const back = round.sentBack
  if (!back) return null
  const from = stepOf(task.sop, back.stepId)?.name ?? back.stepId
  const who = back.by === 'person' ? 'The user' : `The step "${from}"`
  const lines = [`${who} sent this step back (${back.count} of ${back.limit} times on this arrow).`]
  if (back.note) lines.push(`What must change:\n${back.note}`)
  if (back.comments.length > 0) {
    lines.push('Open comments on your document:\n' + back.comments.map((c) => `- ${c}`).join('\n'))
  }
  lines.push('Address every point, then report again.')
  return lines.join('\n\n')
}

function whereText(round: RoundRecord, folder: string, branch: string | null): string {
  const lines = [`You work in \`${folder}\`${branch ? ` on the branch \`${branch}\`` : ''}.`]
  if (branch) {
    lines.push(
      'Commit what you change on this branch before you report; do not switch branches, push or ' +
        'open pull requests unless your step says so.',
    )
  }
  if (round.merge && (round.merge.conflicts.length > 0 || round.merge.lanes.length > 0)) {
    lines.push(
      'Kettu is merging the parallel branches into this folder. These files conflict: ' +
        round.merge.conflicts.map((file) => `\`${file}\``).join(', ') +
        '. Resolve the conflicts, keeping what both branches meant, and commit the merge before ' +
        'anything else; Kettu refuses your report until the merge is committed.',
    )
  }
  return lines.join(' ')
}

/** The first message of a step's session. */
export function stepPrompt(
  task: TaskRecord,
  round: RoundRecord,
  where: { folder: string; branch: string | null },
): string {
  const step = stepOf(task.sop, round.stepId)!
  const n = stepIndex(task.sop, step.id) + 1
  const sections: string[] = [
    `You are doing one step of a task that Kettu runs through the SOP "${task.sop.name}". ${HOW}`,
    `## The task\n\n${task.text}`,
    `## Your step: ${step.name} (step ${n} of ${task.sop.steps.length})\n\n${step.prompt.trim()}`,
    `## What you hand in\n\n${handInText(step)}`,
    '## Outcomes\n\n' +
      step.outcomes.map((o) => `- "${o.name}" ${arrowText(task, step, o)}.`).join('\n') +
      (step.youReview
        ? '\n\nThe user reviews what you hand in before the task goes on, and may send it back.'
        : ''),
  ]
  const before = earlierText(task, round)
  if (before) sections.push(`## Earlier steps\n\n${before}`)
  if (step.reviewOf.length > 0) {
    const names = step.reviewOf.map((id) => `"${stepOf(task.sop, id)?.name ?? id}"`).join(', ')
    sections.push(`## What you review\n\nThe work of ${names}. Do not change it yourself.`)
  }
  if (task.notes.length > 0) {
    sections.push(
      '## Notes from the user\n\n' + task.notes.map((note) => `- ${note.text}`).join('\n'),
    )
  }
  const back = sentBackText(task, round)
  if (back) sections.push(`## Sent back\n\n${back}`)
  if (round.retryNote) sections.push(`## From the user\n\n${round.retryNote}`)
  sections.push(`## Where you work\n\n${whereText(round, where.folder, where.branch)}`)
  return sections.join('\n\n')
}

/** What a session that worked on a step before is sent when the step starts again in it. */
export function againPrompt(
  task: TaskRecord,
  round: RoundRecord,
  where: { folder: string; branch: string | null },
): string {
  const step = stepOf(task.sop, round.stepId)!
  const parts = [
    `The step "${step.name}" starts again (round ${round.n}). ${HOW}`,
    sentBackText(task, round) ?? '',
    round.retryNote ? `From the user:\n\n${round.retryNote}` : '',
    whereText(round, where.folder, where.branch),
  ]
  return parts.filter(Boolean).join('\n\n')
}

/** Sent once when a step's turn ended without the call it owes. */
export function reminderPrompt(picking: boolean): string {
  return picking
    ? `Your report was accepted, but you have not picked who does the next steps. Call \`${PICK_TOOL}\` with a pick for each step the report's result listed.`
    : `Your step is not reported yet. If it is done, call \`${REPORT_TOOL}\` now with an outcome and what the step hands in; if it is not, finish it first. Kettu stops the task for the user if this turn also ends without a report.`
}

/** Sent to a step that was working when the host restarted. */
export const RESUME_PROMPT =
  `Kettu restarted while you worked on this step. Check where you stopped, finish the step and ` +
  `call \`${REPORT_TOOL}\`.`

/** A note the user added for the steps of the task. */
export function notePrompt(text: string): string {
  return `A note from the user for this task, to keep in mind from now on:\n\n${text}`
}
