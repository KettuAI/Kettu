// The messages a node's session gets: the first one, the shorter one that starts a later round in
// the same session, and the reminder after a turn that ended without a report.

import { sopGraph } from '@shared/sop-graph'
import type { Sop, SopNode, SopOutcome } from '@shared/tasks'
import { SERVICE_NAME } from '../service-name'
import type { WorktreeRecord } from '../storage'
import type { NodeRunRecord, TaskRecord } from './api'

export const REPORT_TOOL = 'report_sop_node'

/** A node's latest report, as later nodes are told it. */
export interface HandedIn {
  node: SopNode
  run: NodeRunRecord
}

export interface NodeMessage {
  task: TaskRecord
  node: SopNode
  round: number
  /** The latest finished run of each node, in the order they finished. */
  earlier: readonly HandedIn[]
  /** The node that sent the work back here, by its name, and why. */
  sentBack: { from: string; note: string } | null
  /** The node the work came on from, by its name, with the outcome's name and its note. */
  cameFrom: { from: string; outcome: string; note: string } | null
  /** What the person wants the agent told, when they let a stuck node go on. */
  personNote: string | null
  /** Branches the agent must merge into its working folder before it may report. */
  toMerge: readonly WorktreeRecord[]
  /** The run's worktree; null when it works in the project folder. */
  worktree: WorktreeRecord | null
  /** It works in a branch's own worktree, so every report needs the work committed. */
  inBranch: boolean
}

function quoted(names: readonly string[]): string {
  const list = names.map((name) => `"${name}"`)
  return list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : (list[0] ?? '')
}

function leadsTo(sop: Sop, node: SopNode, outcome: SopOutcome): string {
  if (outcome.end === 'done') return 'ends the task as done'
  if (outcome.end === 'dropped') return 'ends the task as dropped, not to be done'
  const name = (id: string): string => sop.nodes.find((n) => n.id === id)?.name ?? id
  if (outcome.to.length > 1) return `starts ${quoted(outcome.to.map(name))} at once`
  const to = outcome.to[0] ?? ''
  const back = sopGraph(sop).edges.some(
    (edge) => edge.from === node.id && edge.outcome === outcome.id && edge.back,
  )
  return back ? `sends the work back to "${name(to)}"` : `goes on to "${name(to)}"`
}

/** How the node reports: the tool, its outcomes and what must be handed in. */
export function reportingText(
  sop: Sop,
  node: SopNode,
  work: Pick<NodeMessage, 'worktree' | 'inBranch'>,
): string {
  const lines = [
    `When this node's work is done, call the \`${REPORT_TOOL}\` tool of the \`${SERVICE_NAME}\` MCP server once, with:`,
    "- outcome: the id of one of this node's outcomes:",
    ...node.outcomes.map(
      (outcome) => `  - \`${outcome.id}\` (${outcome.name}): ${leadsTo(sop, node, outcome)}`,
    ),
    node.handIn === 'verdict'
      ? '- note: the reason for the outcome, for the next nodes and the person'
      : '- note: what you did and found, for the next nodes and the person',
  ]
  if (node.handIn === 'document') {
    lines.push('- document: the document this node hands in, whole, in Markdown')
  }
  const splits = node.outcomes.filter((outcome) => outcome.to.length > 1)
  if (work.inBranch) {
    lines.push(
      `This node works in a branch of its own (\`${work.worktree?.branch ?? ''}\`), which Kettu merges later: commit all your changes before you report.`,
    )
  } else if (work.worktree && splits.length > 0) {
    lines.push(
      `The nodes that start at once each begin from your last commit: commit all your changes before you report ${splits.map((outcome) => `\`${outcome.id}\``).join(' or ')}.`,
    )
  }
  lines.push(
    `Kettu moves the task along the SOP by the outcome you report; nothing else moves it. If \`${REPORT_TOOL}\` refuses the report, fix what it names and call it again. Do not end your turn without reporting, and stop working in this session once the report is taken.`,
  )
  return lines.join('\n')
}

function handedInText(earlier: readonly HandedIn[]): string {
  return earlier
    .map(({ node, run }) => {
      const outcome = node.outcomes.find((o) => o.id === run.outcome)
      const by = run.by === 'person' ? ', by the person' : ''
      return [
        `### ${node.name}: ${outcome?.name ?? run.outcome ?? ''}${by}`,
        run.note?.trim() ?? '',
        run.document?.trim() ?? '',
      ]
        .filter(Boolean)
        .join('\n\n')
    })
    .join('\n\n')
}

function mergeText(toMerge: readonly WorktreeRecord[]): string {
  return [
    'The branches that join at this node did not merge without conflicts. Before anything else, in your working folder:',
    '1. If a merge is under way (`git status` says so), resolve its conflicts and commit it.',
    '2. Run `git merge <branch>` for each branch below that is not merged yet, resolve the conflicts and commit.',
    ...toMerge.map((worktree) => `   - \`${worktree.branch}\``),
    'The report is refused until every one of them is merged.',
  ].join('\n')
}

/** The first message of a node's session. */
export function firstMessage(message: NodeMessage): string {
  const { task, node, round } = message
  const parts = [
    `You are doing the "${node.name}" node of the SOP "${task.sop.name}" for a task in Kettu${round > 1 ? ` (round ${round})` : ''}. An SOP is a flow of nodes, each done by its own agent, and Kettu moves the task along it. Do this node only, then report.`,
    `## What to do\n\n${node.prompt.trim()}`,
    `## Requirement\n\n# ${task.title}\n\n${task.requirement.trim()}`,
  ]
  if (message.earlier.length > 0) {
    parts.push(`## Handed in so far\n\n${handedInText(message.earlier)}`)
  }
  if (message.sentBack) {
    parts.push(
      `## Sent back\n\n"${message.sentBack.from}" sent the work back to this node:\n\n${message.sentBack.note.trim()}`,
    )
  }
  if (message.personNote) parts.push(`## From the person\n\n${message.personNote.trim()}`)
  if (message.toMerge.length > 0) {
    parts.push(`## Branches to merge\n\n${mergeText(message.toMerge)}`)
  }
  parts.push(`## Reporting\n\n${reportingText(task.snapshot, node, message)}`)
  return parts.join('\n\n')
}

/** The message that starts a later round in the node's own session. */
export function laterMessage(message: NodeMessage): string {
  const { task, node, round } = message
  const parts: string[] = []
  if (message.sentBack) {
    parts.push(
      `The task came back to the "${node.name}" node (round ${round}). "${message.sentBack.from}" sent the work back:\n\n${message.sentBack.note.trim()}`,
    )
  } else if (message.personNote) {
    parts.push(`The person asks you to go on with the "${node.name}" node.`)
  } else if (message.cameFrom) {
    const { from, outcome, note } = message.cameFrom
    parts.push(
      `The task reached the "${node.name}" node again (round ${round}). "${from}" reported "${outcome}":\n\n${note.trim()}`,
    )
  } else {
    parts.push(
      `The "${node.name}" node is yours again (round ${round}). Check where its work stands and carry on.`,
    )
  }
  if (message.personNote) parts.push(`From the person:\n\n${message.personNote.trim()}`)
  if (message.toMerge.length > 0) parts.push(mergeText(message.toMerge))
  parts.push(`Then report again.\n\n${reportingText(task.snapshot, node, message)}`)
  return parts.join('\n\n')
}

/** Sent once when a turn ended without a report. */
export function reminderMessage(node: SopNode): string {
  const outcomes = node.outcomes.map((outcome) => `\`${outcome.id}\``).join(', ')
  return `Your turn ended without a report for the "${node.name}" node. If its work is done, call the \`${REPORT_TOOL}\` tool of the \`${SERVICE_NAME}\` MCP server now, with one of the outcomes ${outcomes} and a note${node.handIn === 'document' ? ' and the document' : ''}; if it is not, finish it first. Do not end your turn without reporting.`
}
