// The session calls of the plugin API. A plugin sees a session's summary with its permission and
// reads a conversation only with the high one. It starts sessions and messages the ones it
// started by the same paths an agent's start_session and send_message take, so a session it
// starts is held to Auto at most and one it did not start gets nothing from it.

import type { AgentStatus, SessionSummary } from '@shared/agent-host'
import { START_MODE_CHARS, harnessOf, isAgentId } from '@shared/agents'
import { pluginStarter } from '@shared/plugins'
import type { AgentId } from '@shared/thread'
import { cutStart, historyPage, type RenderedTurn } from '../carried-context'
import {
  DAILY_LIMIT,
  LIST_DEFAULT,
  LIST_LIMIT,
  TEXT_CHARS,
  TITLE_CHARS,
  WORKING_LIMIT,
  startLimit,
  toolAgentStatus,
  type ToolDelivery,
  type ToolSession,
} from '../session-tools'
import { isRanked, startableModes, STARTED_MAX } from '../started-mode'
import type { PluginApiCall } from './call'

const READ_DEFAULT = 5
const READ_LIMIT = 20
/** One turn's side of a conversation, cut at its start beyond this. */
const TURN_BYTES = 24 * 1024

export interface PluginSessionsDeps {
  /** The sessions the sidebar lists, newest first. */
  list(): SessionSummary[]
  /** A session's turns, numbered from its first. */
  turns(sessionId: string): Promise<RenderedTurn[]>
  /** The session as the tools see it; null for one Kettu does not list. */
  info(sessionId: string): ToolSession | null
  /** The summary of a session that exists. */
  summary(sessionId: string): SessionSummary
  /** The sessions started under `startedBy`, for the limits. */
  startedBy(startedBy: string): ToolSession[]
  agents(): AgentStatus[]
  /** The agent new sessions start with; null when there is none. */
  defaultAgent(): AgentId | null
  /** The folder of a project the user has, canonical; throws for any other folder. */
  project(path: string): string
  start(
    pluginId: string,
    params: {
      prompt: string
      projectPath: string | null
      agentId: AgentId
      mode?: string
      title?: string
    },
  ): Promise<string>
  send(pluginId: string, sessionId: string, text: string): Promise<ToolDelivery>
  now(): number
}

/** What a plugin sees of a session: nothing that was said in it. */
export interface PluginSessionInfo {
  id: string
  title: string | null
  /** The project's folder, or the session's scratch folder. */
  project: string
  agent: AgentId
  state: SessionSummary['status']
  /** What its running turn does now, as the turn's phases name it; null between turns. */
  doing: NonNullable<SessionSummary['phase']> | null
  parentId: string | null
  createdAt: number
  updatedAt: number
  archived: boolean
}

export function sessionInfo(summary: SessionSummary): PluginSessionInfo {
  return {
    id: summary.id,
    title: summary.title,
    project: summary.projectPath,
    agent: summary.agentId,
    state: summary.status,
    doing: summary.phase ?? null,
    parentId: summary.parentId,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    archived: summary.archivedAt !== null,
  }
}

type Args = Record<string, unknown>

function options(value: unknown, allowed: readonly string[], what: string): Args {
  const given = value ?? {}
  if (typeof given !== 'object' || Array.isArray(given)) {
    throw new Error(`${what} must be an object`)
  }
  for (const key of Object.keys(given)) {
    if (!allowed.includes(key)) throw new Error(`${what} has no option ${key.slice(0, 100)}`)
  }
  return given as Args
}

function text(o: Args, key: string, max: number): string {
  const value = o[key]
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new Error(`${key} must be non-blank text of at most ${max} characters`)
  }
  return value
}

function whole(o: Args, key: string, min: number, max: number, fallback: number): number {
  const value = o[key]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be a whole number from ${min} to ${max}`)
  }
  return value
}

/** A plugin's own sessions run out at the same limits as an agent's. */
function refuseOverLimit(pluginId: string, deps: PluginSessionsDeps): void {
  const starter = pluginStarter(pluginId)
  const limit = startLimit(starter, deps.startedBy(starter), deps.now())
  if (limit?.kind === 'working') {
    throw new Error(
      `This plugin has ${WORKING_LIMIT} sessions working, the most at once. ` +
        'It can start another when one of them ends.',
    )
  }
  if (limit?.kind === 'day') {
    throw new Error(
      `This plugin started ${DAILY_LIMIT} sessions today, the most in a local day. ` +
        'It can start another after midnight.',
    )
  }
}

/** The agent to start with: the one named, else the user's default; it must be able to start. */
function startAgent(o: Args, deps: PluginSessionsDeps): AgentId {
  const named = o.agent
  if (named !== undefined && !isAgentId(named)) throw new Error('agent must be an agent id')
  const agentId = named ?? deps.defaultAgent()
  if (agentId === null) throw new Error('There is no default agent; name one with agent')
  const status = deps.agents().find((item) => item.id === agentId)
  const state = status ? toolAgentStatus(status) : null
  if (!status || !state) throw new Error(`No agent ${agentId} can be started here`)
  if (state === 'not_installed') {
    throw new Error(`${status.name} is not installed on this computer`)
  }
  return agentId
}

/** A mode a session started for a plugin may have, which is never wider than Auto. */
function startMode(o: Args, agentId: AgentId): string | undefined {
  const mode = o.mode
  if (mode === undefined) return undefined
  if (typeof mode !== 'string' || mode === '' || mode.length > START_MODE_CHARS) {
    throw new Error('mode must be a mode id')
  }
  const harness = harnessOf(agentId)
  if (!isRanked(harness) || !startableModes(harness, STARTED_MAX).includes(mode)) {
    throw new Error(`${agentId} has no mode ${mode} that a plugin can start a session in`)
  }
  return mode
}

export function sessionCalls(deps: PluginSessionsDeps): Record<string, PluginApiCall> {
  return {
    'sessions.list': {
      permission: 'sessions.summary',
      run: (_, [input]) => {
        const o = options(input, ['project', 'includeArchived', 'limit'], 'The options')
        const project = o.project
        if (project !== undefined && typeof project !== 'string') {
          throw new Error('project must be a folder path')
        }
        const archived = o.includeArchived === true
        if (o.includeArchived !== undefined && typeof o.includeArchived !== 'boolean') {
          throw new Error('includeArchived must be true or false')
        }
        const limit = whole(o, 'limit', 1, LIST_LIMIT, LIST_DEFAULT)
        const sessions = deps
          .list()
          .filter(
            (session) =>
              session.origin === 'user' &&
              (project === undefined || session.projectPath === project) &&
              (archived || session.archivedAt === null),
          )
          .slice(0, limit)
        return { sessions: sessions.map(sessionInfo) }
      },
    },
    'sessions.read': {
      permission: 'sessions.content',
      run: async (_, [input]) => {
        const o = options(input, ['id', 'before', 'limit'], 'The options')
        const id = text(o, 'id', 200)
        const before = o.before === undefined ? undefined : whole(o, 'before', 1, 1e9, 1)
        const limit = whole(o, 'limit', 1, READ_LIMIT, READ_DEFAULT)
        if (!deps.info(id)) throw new Error(`No session ${id}`)
        const all = await deps.turns(id)
        const page = historyPage(all, before, limit)
        const first = page[0]?.number ?? null
        return {
          total: all.length,
          turns: page.map((turn) => ({
            number: turn.number,
            agent: turn.agentId,
            user: cutStart(turn.user, TURN_BYTES),
            assistant: cutStart(turn.assistant, TURN_BYTES),
          })),
          moreBefore: first !== null && first > 1 ? first : null,
        }
      },
    },
    'sessions.start': {
      permission: 'sessions.start',
      run: async ({ pluginId }, [input]) => {
        const o = options(input, ['prompt', 'project', 'agent', 'mode', 'title'], 'The options')
        const prompt = text(o, 'prompt', TEXT_CHARS)
        const title = o.title === undefined ? undefined : text(o, 'title', TITLE_CHARS)
        if (o.project !== undefined && typeof o.project !== 'string') {
          throw new Error('project must be a folder path')
        }
        refuseOverLimit(pluginId, deps)
        const agentId = startAgent(o, deps)
        const mode = startMode(o, agentId)
        // Only a project the user has: a session reads and edits the folder it starts in.
        const projectPath = o.project === undefined ? null : deps.project(o.project as string)
        const id = await deps.start(pluginId, {
          prompt,
          projectPath,
          agentId,
          ...(mode === undefined ? {} : { mode }),
          ...(title === undefined ? {} : { title }),
        })
        return sessionInfo(deps.summary(id))
      },
    },
    'sessions.send': {
      permission: 'sessions.start',
      run: async ({ pluginId }, [input]) => {
        const o = options(input, ['id', 'text'], 'The options')
        const id = text(o, 'id', 200)
        const delivery = await deps.send(pluginId, id, text(o, 'text', TEXT_CHARS))
        return { id, delivered: delivery.delivered }
      },
    },
  }
}
