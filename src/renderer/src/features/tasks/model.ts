import { harnessOf } from '@shared/agents'
import type { SopEdge, SopGraph } from '@shared/sop-graph'
import type { NodeRunView, SopOutline, SopSummary, TaskView } from '@shared/tasks'
import type { AgentId } from '@shared/thread'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage } from '@renderer/lib/host'
import { taskEnded } from '@renderer/stores/tasks'

export type OutlineNode = SopOutline['nodes'][number]

export function nodeOf(outline: SopOutline, nodeId: string | null): OutlineNode | null {
  if (nodeId === null) return null
  return outline.nodes.find((node) => node.id === nodeId) ?? null
}

/** The name of one of the task's nodes, or null for none or one it does not have. */
export function nodeName(task: Pick<TaskView, 'outline'>, nodeId: string | null): string | null {
  return nodeOf(task.outline, nodeId)?.name ?? null
}

/** The name of a node's outcome, or its id when the node has no such outcome. */
export function outcomeName(node: OutlineNode | null, outcomeId: string): string {
  return node?.outcomes.find((outcome) => outcome.id === outcomeId)?.name ?? outcomeId
}

/** Only the harnesses whose permissions Kettu controls run a task's nodes. */
export function runsNodes(agentId: AgentId): boolean {
  const harness = harnessOf(agentId)
  return harness === 'claude-code' || harness === 'codex'
}

/** An SOP's key in a list: no two sources share one. */
export function sopKey(sop: Pick<SopSummary, 'source' | 'id'>): string {
  return `${sop.source}:${sop.id}`
}

/** Where an SOP is from: shipped with Kettu, the person's own, or made by an agent. */
export function sopOrigin(sop: Pick<SopSummary, 'source' | 'madeBy'>): 'kettu' | 'yours' | 'agent' {
  if (sop.source === 'official') return 'kettu'
  return sop.madeBy === 'agent' ? 'agent' : 'yours'
}

/** Whether a task can start with the SOP: it read and the person approved it as it is. */
export function sopUsable(sop: SopSummary): boolean {
  return sop.status === 'ready' && sop.problem === null && sop.outline !== null
}

export type NodeMark =
  | 'todo' // not started
  | 'queued'
  | 'working'
  | 'needsYou'
  | 'joining' // a branch arrived and it waits for the other branches
  | 'done'
  | 'stopped'
  | 'skipped' // never ran, and nothing open can still lead to it

export interface NodeStatus {
  mark: NodeMark
  /** The node's latest run, null when it never ran. */
  run: NodeRunView | null
}

function open(run: NodeRunView): boolean {
  return run.state === 'queued' || run.state === 'running' || run.state === 'waiting'
}

/** Each node's latest run, by the node's id; `runs` is newest first. */
export function latestRuns(runs: readonly NodeRunView[]): Map<string, NodeRunView> {
  const latest = new Map<string, NodeRunView>()
  for (const run of runs) if (!latest.has(run.nodeId)) latest.set(run.nodeId, run)
  return latest
}

function markOf(run: NodeRunView): NodeMark {
  switch (run.state) {
    case 'queued':
      return 'queued'
    case 'running':
      return 'working'
    case 'waiting':
      return 'needsYou'
    case 'done':
      return 'done'
    case 'stopped':
      return 'stopped'
  }
}

/** Where each node of the task stands, by the node's id; `runs` is newest first. */
export function nodeStatuses(
  task: TaskView,
  runs: readonly NodeRunView[],
  graph: SopGraph,
): Record<string, NodeStatus> {
  const latest = latestRuns(runs)
  const openNodes = task.outline.nodes
    .map((node) => node.id)
    .filter((id) => task.arrived.includes(id) || (latest.has(id) && open(latest.get(id)!)))
  const statuses: Record<string, NodeStatus> = {}
  for (const node of task.outline.nodes) {
    const run = latest.get(node.id) ?? null
    if (run && open(run)) statuses[node.id] = { mark: markOf(run), run }
    else if (task.arrived.includes(node.id)) statuses[node.id] = { mark: 'joining', run }
    else if (run) statuses[node.id] = { mark: markOf(run), run }
    else {
      // A cancelled task stopped short of its other nodes; no outcome passed them by.
      const reachable =
        task.state === 'cancelled' ||
        (!taskEnded(task) &&
          (runs.length === 0 || openNodes.some((id) => graph.reach[id]?.includes(node.id))))
      statuses[node.id] = { mark: reachable ? 'todo' : 'skipped', run: null }
    }
  }
  return statuses
}

/** The arrows some finished run took, as `from/outcome` keys. */
export function takenOutcomes(runs: readonly NodeRunView[]): Set<string> {
  const taken = new Set<string>()
  for (const run of runs) {
    if (run.state === 'done' && run.outcome !== null) taken.add(`${run.nodeId}/${run.outcome}`)
  }
  return taken
}

export function edgeTaken(taken: ReadonlySet<string>, edge: Pick<SopEdge, 'from' | 'outcome'>) {
  return taken.has(`${edge.from}/${edge.outcome}`)
}

/**
 * The node a task's page shows first: the one that needs the person, else the working one, else
 * the last that finished, else the start. `runs` is newest first.
 */
export function defaultNode(task: TaskView, runs: readonly NodeRunView[]): string {
  const waiting = runs.find((run) => run.state === 'waiting')
  if (waiting) return waiting.nodeId
  const working =
    runs.find((run) => run.state === 'running') ?? runs.find((run) => run.state === 'queued')
  if (working) return working.nodeId
  const ended = runs
    .filter((run) => run.endedAt !== null)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0]
  return ended?.nodeId ?? runs[0]?.nodeId ?? task.outline.start
}

/** A task's state as it is shown: needing the person comes before whatever else still works. */
export function taskMark(
  task: Pick<TaskView, 'state' | 'needsYou'>,
): 'running' | 'needsYou' | 'done' | 'dropped' | 'cancelled' {
  if (taskEnded(task)) return task.state as 'done' | 'dropped' | 'cancelled'
  return task.needsYou || task.state === 'waiting' ? 'needsYou' : 'running'
}

/** What the person can do to a task in its state. */
export function taskActions(task: TaskView): { cancel: boolean; remove: boolean } {
  const ended = taskEnded(task)
  return { cancel: !ended, remove: ended }
}

/** Runs a task action, saying in a toast why it failed. */
export function runTaskAction(action: () => Promise<void>): void {
  action().catch((error: unknown) => toast(errorMessage(error)))
}
