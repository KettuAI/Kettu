// How long a Claude Code session's prompt cache lasts, from the end of the session's own
// transcript. Claude Code splits each request's cache writes by lifetime, five minutes or an
// hour; only those fields of the main thread's API messages are used.

import { open, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Platform } from '@shared/platform'
import type { AgentId } from '@shared/thread'
import { projectsFolder } from './usage/readers/claude'

const MINUTE = 60_000
/** At most this much of a transcript's end is read for its latest cache write. */
export const TAIL_LIMIT = 1 << 20
const CHUNK = 1 << 16
const NEWLINE = 0x0a
/** Lines without it cannot say how long a cache lasts, so they are never parsed. */
const NEEDLE = 'ephemeral_'
/** Claude Code cuts a project's folder name to this length and adds a hash of the path. */
const FOLDER_LIMIT = 200
// Claude Code's session ids are UUIDs; anything else must not reach a path.
const SESSION_ID = /^[A-Za-z0-9_-]+$/
const REMEMBERED = 1_000

/** How long a session's cache lasts, in ms, when the agent's own records say; else null. */
export type CacheTtlReader = (
  agentId: AgentId,
  projectPath: string,
  acpSessionId: string,
) => Promise<number | null>

interface Line {
  type?: unknown
  isSidechain?: unknown
  message?: {
    usage?: {
      cache_creation?: {
        ephemeral_5m_input_tokens?: unknown
        ephemeral_1h_input_tokens?: unknown
      } | null
    } | null
  } | null
}

const wrote = (value: unknown): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value > 0

/**
 * The lifetime of what one transcript line's message wrote to the cache, the shorter one if it
 * wrote both, since the prefix after the shorter one's breakpoint is lost with it. Null for any
 * other line: one that wrote nothing, a subagent's, or one that does not parse.
 */
export function cacheTtlOfLine(json: string): number | null {
  if (!json.includes(NEEDLE)) return null
  let line: Line | null
  try {
    line = JSON.parse(json) as Line | null
  } catch {
    return null
  }
  if (line?.type !== 'assistant' || line.isSidechain === true) return null
  const split = line.message?.usage?.cache_creation
  if (typeof split !== 'object' || split === null) return null
  if (wrote(split.ephemeral_5m_input_tokens)) return 5 * MINUTE
  if (wrote(split.ephemeral_1h_input_tokens)) return 60 * MINUTE
  return null
}

function ttlOf(line: Buffer): number | null {
  return line.includes(NEEDLE) ? cacheTtlOfLine(line.toString('utf8')) : null
}

/**
 * The lifetime of the latest cache write in a transcript, read backwards from its end, at most
 * `limit` bytes, so a long session costs no more than a short one.
 */
export async function readCacheTtl(
  file: string,
  { limit = TAIL_LIMIT, chunk = CHUNK }: { limit?: number; chunk?: number } = {},
): Promise<number | null> {
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    const floor = Math.max(0, size - limit)
    let end = size
    // The start of a line that began before the bytes read so far.
    let rest = Buffer.alloc(0)
    while (end > floor) {
      const start = Math.max(floor, end - chunk)
      const buffer = Buffer.alloc(end - start)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
      const data = Buffer.concat([buffer.subarray(0, bytesRead), rest])
      let stop = data.length
      while (stop > 0) {
        const newline = data.lastIndexOf(NEWLINE, stop - 1)
        if (newline === -1) break
        const ttl = ttlOf(data.subarray(newline + 1, stop))
        if (ttl !== null) return ttl
        stop = newline
      }
      rest = data.subarray(0, stop)
      end = start
    }
    // Whole only when it is the file's first line; otherwise it was cut at the limit.
    return floor === 0 ? ttlOf(rest) : null
  } finally {
    await handle.close()
  }
}

/** The 32-bit string hash Claude Code names long project folders with. */
function pathHash(value: string): string {
  let hash = 0
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0
  return Math.abs(hash).toString(36)
}

/** The name of a project's folder under Claude Code's `projects`, as Claude Code makes it. */
export function claudeProjectFolder(cwd: string): string {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  return name.length <= FOLDER_LIMIT ? name : `${name.slice(0, FOLDER_LIMIT)}-${pathHash(cwd)}`
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

/**
 * A session's transcript: in its project's folder, named from the real path of its working
 * folder in NFC form, or else in any folder, since a setting can rename the project's.
 */
export async function findClaudeTranscript(
  root: string,
  cwd: string,
  sessionId: string,
): Promise<string | null> {
  if (!SESSION_ID.test(sessionId)) return null
  const name = `${sessionId}.jsonl`
  const real = await realpath(cwd).catch(() => cwd)
  const direct = path.join(root, claudeProjectFolder(real.normalize('NFC')), name)
  if (await isFile(direct)) return direct
  const folders = await readdir(root, { withFileTypes: true }).catch(() => [])
  const found = await Promise.all(
    folders
      .filter((folder) => folder.isDirectory())
      .map(async (folder) => {
        const file = path.join(root, folder.name, name)
        return (await isFile(file)) ? file : null
      }),
  )
  return found.find((file) => file !== null) ?? null
}

export function claudeCacheTtl(deps: {
  platform: Platform
  home: string
  env(): Promise<Record<string, string | undefined>>
  log(level: 'info' | 'warn' | 'error', message: string): void
}): CacheTtlReader {
  const found = new Map<string, string>()
  return async (agentId, projectPath, acpSessionId) => {
    if (agentId !== 'claude-code') return null
    let file = found.get(acpSessionId)
    if (!file || !(await isFile(file))) {
      const root = projectsFolder(await deps.env(), deps.home, deps.platform)
      file = (await findClaudeTranscript(root, projectPath, acpSessionId)) ?? undefined
      if (!file) return null
      found.delete(acpSessionId)
      found.set(acpSessionId, file)
      if (found.size > REMEMBERED) found.delete(found.keys().next().value!)
    }
    try {
      return await readCacheTtl(file)
    } catch (error) {
      deps.log('warn', `Could not read ${file}: ${(error as Error).message}`)
      return null
    }
  }
}
