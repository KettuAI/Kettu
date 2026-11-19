import type { RunningWork } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { terminalsAtStake } from '@renderer/app/actions'
import { hostAt, sessionHost } from '@renderer/lib/host'
import { sessionTitle } from '@renderer/stores/sessions'

export type WorkKind =
  'turn' | 'waiting' | 'command' | 'task' | 'subagent' | 'scheduled' | 'background' | 'terminal'

/** One thing ending a session's agent or its terminals would stop, as a confirmation lists it. */
export interface WorkItem {
  key: string
  kind: WorkKind
  /** The command or subagent, or for a turn, requests, jobs and unnamed work, the session. */
  name: string
  count: number
  agentId: AgentId | null
  hostId: string | null
  /** The session it belongs to; a subagent's work is its session's. */
  sessionId: string | null
}

/**
 * What ending these sessions and their sub-sessions would stop, asked of each one's host. A host
 * from before the request answers nothing, as nothing was confirmed there before.
 */
export async function runningWorkOf(sessionIds: readonly string[]): Promise<RunningWork[]> {
  const byHost = new Map<string | null, string[]>()
  for (const id of sessionIds) {
    const hostId = sessionHost(id)
    byHost.set(hostId, [...(byHost.get(hostId) ?? []), id])
  }
  const answers = await Promise.all(
    [...byHost].map(([hostId, ids]) =>
      hostAt(hostId, 'sessions.runningWork', { sessionIds: ids }).then(
        ({ sessions }) => sessions,
        () => [],
      ),
    ),
  )
  return answers.flat()
}

/** The rows of one session's running work; `background` leaves out its turn and requests. */
export function workItems(work: RunningWork, background = false): WorkItem[] {
  const hostId = sessionHost(work.sessionId)
  const session = sessionTitle(work)
  const item = (kind: WorkKind, name: string, index = 0, count = 0): WorkItem => ({
    key: `${work.sessionId}:${kind}:${index}`,
    kind,
    name,
    count,
    agentId: work.agentId,
    hostId,
    sessionId: work.sessionId,
  })
  return [
    ...(work.turn && !background ? [item('turn', session)] : []),
    ...(work.waiting > 0 && !background ? [item('waiting', session, 0, work.waiting)] : []),
    ...work.commands.map((name, i) => item('command', name, i)),
    ...work.tasks.map((name, i) => item('task', name, i)),
    ...work.subagents.map((name, i) => item('subagent', name, i)),
    ...(work.scheduled > 0 ? [item('scheduled', session, 0, work.scheduled)] : []),
    ...(work.unnamed ? [item('background', session)] : []),
  ]
}

/**
 * What archiving or deleting these sessions would stop: their agents' running work, then the
 * commands of their terminals, which end with them.
 */
export async function workAtStake(sessionIds: readonly string[]): Promise<WorkItem[]> {
  const [work, terminals] = await Promise.all([
    runningWorkOf(sessionIds),
    terminalsAtStake(sessionIds),
  ])
  return [
    ...work.flatMap((item) => workItems(item)),
    ...terminals.map((terminal): WorkItem => ({
      key: `terminal:${terminal.id}`,
      kind: 'terminal',
      name: terminal.name ?? terminal.title,
      count: 0,
      agentId: null,
      hostId: null,
      sessionId: terminal.sessionId,
    })),
  ]
}
