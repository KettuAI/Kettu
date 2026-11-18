// What Kettu reads about a Claude Code session another program had, such as a terminal: how its
// last request was made, from the end of its own transcript, who wrote its last message, and
// whether a Claude Code process outside an SDK host still has it open. Only settings, usage and
// that writer are read, never what was said.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Platform } from '@shared/platform'
import { canonicalClaudeModel } from '@shared/agents'
import { harnessOf, type AgentId } from '@shared/thread'
import { cacheTtlOfLine, findClaudeTranscript, scanBackwards } from './prompt-cache'
import { projectsFolder } from './usage/readers/claude'

/** The last request of a session's main thread, as its transcript records it. */
export interface LastRequest {
  /** When its last reply came, in ms. */
  at: number
  /** How long the latest cache write lasts, in ms; null when the end of the transcript has none. */
  ttl: number | null
  /** The model id, with Claude Code's context suffix such as `[1m]` when it runs with one. */
  model: string | null
  effort: string | null
  fast: boolean | null
  /** The permission mode it last ran in. */
  mode: string | null
  /** The tokens the last request read in all, which a change of model or effort writes again. */
  context: number | null
}

/** A Claude Code process outside any SDK host that has a session open. */
export interface SessionHolder {
  pid: number
  /** Where it runs, such as `cli` for a terminal. */
  entrypoint: string | null
  busy: boolean
}

/** The last message of a transcript's main thread. */
export interface TranscriptTail {
  uuid: string
  /** A program outside an SDK host wrote it, such as a terminal. */
  outside: boolean
}

/** `configDir`: the configuration folder the session belongs to, null for the default. */
export interface OutsideReader {
  lastRequest(
    agentId: AgentId,
    projectPath: string,
    acpSessionId: string,
    configDir: string | null,
  ): Promise<LastRequest | null>
  holder(
    agentId: AgentId,
    acpSessionId: string,
    configDir: string | null,
  ): Promise<SessionHolder | null>
  tail(
    agentId: AgentId,
    projectPath: string,
    acpSessionId: string,
    configDir: string | null,
  ): Promise<TranscriptTail | null>
}

// Requests of the main thread; titles, summaries and subagents have sources of their own.
const MAIN_SOURCES = (source: unknown): boolean =>
  typeof source === 'string' && (source === 'sdk' || source.startsWith('repl_main_thread'))
const NEEDLES = ['"assistant"', '"api-request"', '"permission-mode"', '"model"']

interface Found {
  at?: number
  usage?: { context: number | null; fast: boolean | null }
  ttl?: number | null
  request?: { model: string | null; effort: string | null }
  mode?: string | null
  modelId?: string | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const stringOr = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null
const count = (value: unknown): number => (typeof value === 'number' && value > 0 ? value : 0)

/** Takes what one transcript line says; true once nothing more is wanted. */
function take(found: Found, json: string): boolean {
  if (!NEEDLES.some((needle) => json.includes(needle))) return false
  let line: unknown
  try {
    line = JSON.parse(json)
  } catch {
    return false
  }
  if (!isRecord(line) || line.isSidechain === true) return false
  if (line.type === 'assistant' && isRecord(line.message) && isRecord(line.message.usage)) {
    if (found.at === undefined) {
      const at = Date.parse(String(line.timestamp))
      if (Number.isFinite(at)) {
        const usage = line.message.usage
        found.at = at
        found.usage = {
          context:
            count(usage.input_tokens) +
              count(usage.cache_read_input_tokens) +
              count(usage.cache_creation_input_tokens) || null,
          fast: usage.speed === 'fast' ? true : usage.speed === 'standard' ? false : null,
        }
      }
    }
    if (found.ttl === undefined) {
      const ttl = cacheTtlOfLine(json)
      if (ttl !== null) found.ttl = ttl
    }
  } else if (line.type === 'api-request' && MAIN_SOURCES(line.querySource)) {
    if (found.request === undefined && isRecord(line.params)) {
      const config = isRecord(line.params.output_config) ? line.params.output_config : {}
      found.request = { model: stringOr(line.params.model), effort: stringOr(config.effort) }
    }
  } else if (line.type === 'permission-mode') {
    if (found.mode === undefined) found.mode = stringOr(line.permissionMode)
  } else if (line.type === 'attachment' && isRecord(line.attachment)) {
    const attachment = line.attachment
    if (attachment.type === 'model' && found.modelId === undefined) {
      found.modelId = isRecord(attachment.identity) ? stringOr(attachment.identity.modelId) : null
    }
  }
  return (
    found.at !== undefined &&
    found.ttl !== undefined &&
    found.request !== undefined &&
    found.mode !== undefined &&
    found.modelId !== undefined
  )
}

/**
 * The model a request named, with the context suffix of the model the session was told it runs on
 * when that is the same model, since a request names the model without it.
 */
function modelOf(found: Found): string | null {
  const requested = found.request?.model ?? null
  const told = found.modelId ?? null
  if (!requested) return told
  return told && canonicalClaudeModel(told) === canonicalClaudeModel(requested) ? told : requested
}

/** The last request of a transcript, read backwards from its end; null with no reply in it. */
export async function readLastRequest(
  file: string,
  options: { limit?: number; chunk?: number } = {},
): Promise<LastRequest | null> {
  const found: Found = {}
  await scanBackwards(file, (line) => take(found, line.toString('utf8')), options)
  if (found.at === undefined) return null
  return {
    at: found.at,
    ttl: found.ttl ?? null,
    model: modelOf(found),
    effort: found.request?.effort ?? null,
    fast: found.usage?.fast ?? null,
    mode: found.mode ?? null,
    context: found.usage?.context ?? null,
  }
}

const MESSAGE_NEEDLES = ['"type":"user"', '"type":"assistant"']

/**
 * The last message of a transcript's main thread, read backwards from its end. `own` is the entry
 * point Kettu's own Claude Code runs under when it is not an SDK one; null when the transcript has
 * no message or its writer is not recorded.
 */
export async function readTail(
  file: string,
  own: string | null = null,
  options: { limit?: number; chunk?: number } = {},
): Promise<TranscriptTail | null> {
  let found: TranscriptTail | null = null
  await scanBackwards(
    file,
    (line) => {
      if (!MESSAGE_NEEDLES.some((needle) => line.includes(needle))) return false
      let json: unknown
      try {
        json = JSON.parse(line.toString('utf8'))
      } catch {
        return false
      }
      if (!isRecord(json) || json.isSidechain === true) return false
      if (json.type !== 'user' && json.type !== 'assistant') return false
      const uuid = stringOr(json.uuid)
      if (!uuid) return false
      const entrypoint = stringOr(json.entrypoint)
      found = {
        uuid,
        outside: entrypoint !== null && !entrypoint.startsWith('sdk') && entrypoint !== own,
      }
      return true
    },
    options,
  )
  return found
}

/** Whether a process runs, as far as signal 0 can tell; one of another user's runs too. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * The process outside any SDK host that has the session open, from the files Claude Code's running
 * processes keep in its `sessions` folder, each named for its process id. An SDK host's own, such
 * as Kettu's, is left out: Kettu attaches its own sessions itself.
 */
export async function findHolder(
  folder: string,
  acpSessionId: string,
  isAlive: (pid: number) => boolean = alive,
): Promise<SessionHolder | null> {
  const names = await readdir(folder).catch(() => [])
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue
    let entry: unknown
    try {
      entry = JSON.parse(await readFile(path.join(folder, name), 'utf8'))
    } catch {
      continue
    }
    if (!isRecord(entry) || entry.sessionId !== acpSessionId) continue
    const pid = entry.pid
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) continue
    const entrypoint = stringOr(entry.entrypoint)
    if (entrypoint?.startsWith('sdk')) continue
    if (!isAlive(pid)) continue
    return { pid, entrypoint, busy: entry.status === 'busy' }
  }
  return null
}

export function claudeOutside(deps: {
  platform: Platform
  home: string
  env(): Promise<Record<string, string | undefined>>
  log(level: 'info' | 'warn' | 'error', message: string): void
}): OutsideReader {
  const root = async (configDir: string | null): Promise<string> =>
    projectsFolder(await deps.env(), deps.home, deps.platform, configDir)
  return {
    async lastRequest(agentId, projectPath, acpSessionId, configDir) {
      if (harnessOf(agentId) !== 'claude-code') return null
      const file = await findClaudeTranscript(await root(configDir), projectPath, acpSessionId)
      if (!file) return null
      try {
        return await readLastRequest(file)
      } catch (error) {
        deps.log('warn', `Could not read ${file}: ${(error as Error).message}`)
        return null
      }
    },
    async holder(agentId, acpSessionId, configDir) {
      if (harnessOf(agentId) !== 'claude-code') return null
      const folder = path.join(path.dirname(await root(configDir)), 'sessions')
      return findHolder(folder, acpSessionId)
    },
    async tail(agentId, projectPath, acpSessionId, configDir) {
      if (harnessOf(agentId) !== 'claude-code') return null
      const file = await findClaudeTranscript(await root(configDir), projectPath, acpSessionId)
      if (!file) return null
      try {
        const own = (await deps.env()).CLAUDE_CODE_ENTRYPOINT ?? null
        return await readTail(file, own)
      } catch (error) {
        deps.log('warn', `Could not read ${file}: ${(error as Error).message}`)
        return null
      }
    },
  }
}
