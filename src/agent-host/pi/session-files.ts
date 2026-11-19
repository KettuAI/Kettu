// Pi's session files, which Kettu finds by a session's id, lists for a folder and deletes. A file
// is `<time>_<session id>.jsonl`, its first line the session's header, in a folder pi names after
// the working directory. `pi --session` opens another folder's session only by its file, so a
// session is resumed by the file found here.

import { open, readdir, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getEnv, type Env } from '../find-command'
import type { Platform } from '@shared/platform'
import type { ListedSession } from '../connection'

const HEAD_BYTES = 64 * 1024
const TAIL_BYTES = 256 * 1024
const TITLE_CHARS = 80
/** The pi-acp adapter's own record of each session's file, which it kept in the user's home. */
const ADAPTER_MAP = ['.pi', 'pi-acp', 'session-map.json']
const ADAPTER_MAP_BYTES = 8 * 1024 * 1024

export interface PiFolders {
  /** Where pi keeps its sessions, each working directory's in a folder of its own. */
  sessions: string
  /** The adapter's session map, read only for sessions made through it. */
  adapterMap: string
}

/** Pi's folders as its own environment and settings place them. */
export async function piFolders(env: Env, platform: Platform): Promise<PiFolders> {
  const home = getEnv(env, platform === 'win32' ? 'USERPROFILE' : 'HOME', platform) ?? os.homedir()
  const named = getEnv(env, 'PI_CODING_AGENT_DIR', platform)?.trim()
  const agentDir = named ? path.resolve(named) : path.join(home, '.pi', 'agent')
  const adapterMap = path.join(home, ...ADAPTER_MAP)
  const fromEnv = getEnv(env, 'PI_CODING_AGENT_SESSION_DIR', platform)?.trim()
  if (fromEnv) return { sessions: path.resolve(fromEnv), adapterMap }
  const fromSettings = await sessionDirSetting(agentDir)
  return { sessions: fromSettings ?? path.join(agentDir, 'sessions'), adapterMap }
}

async function sessionDirSetting(agentDir: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(agentDir, 'settings.json'), 'utf8'))
    const dir =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { sessionDir?: unknown }).sessionDir
        : null
    if (typeof dir !== 'string' || !dir.trim()) return null
    return path.isAbsolute(dir) ? dir : path.resolve(agentDir, dir)
  } catch {
    return null
  }
}

/** The folder name pi gives a working directory: its separators and colons as dashes. */
export function folderName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
}

interface Header {
  id: string
  cwd: string
}

async function readHead(file: string): Promise<string | null> {
  let handle
  try {
    handle = await open(file, 'r')
    const buffer = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
    const text = buffer.toString('utf8', 0, bytesRead)
    const end = text.indexOf('\n')
    return end === -1 ? text : text.slice(0, end)
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function readTail(file: string, size: number): Promise<string> {
  const start = Math.max(0, size - TAIL_BYTES)
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(size - start)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
    return buffer.toString('utf8', 0, bytesRead)
  } finally {
    await handle.close().catch(() => {})
  }
}

export function parseHeader(line: string | null): Header | null {
  if (!line) return null
  try {
    const value = JSON.parse(line) as { type?: unknown; id?: unknown; cwd?: unknown }
    return value.type === 'session' && typeof value.id === 'string' && typeof value.cwd === 'string'
      ? { id: value.id, cwd: value.cwd }
      : null
  } catch {
    return null
  }
}

/** The id a session file's name ends in. */
function idInName(name: string): string | null {
  if (!name.endsWith('.jsonl')) return null
  const base = name.slice(0, -'.jsonl'.length)
  const at = base.indexOf('_')
  return at === -1 ? base : base.slice(at + 1)
}

async function jsonlFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => path.join(dir, entry.name))
  } catch {
    return []
  }
}

async function subfolders(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(dir, entry.name))
  } catch {
    return []
  }
}

/** The file in `dir` whose name and header both name the session. */
async function findIn(dir: string, sessionId: string): Promise<string | null> {
  for (const file of await jsonlFiles(dir)) {
    if (idInName(path.basename(file)) !== sessionId) continue
    if (parseHeader(await readHead(file))?.id === sessionId) return file
  }
  return null
}

async function fromAdapterMap(map: string, sessionId: string): Promise<string | null> {
  try {
    if ((await stat(map)).size > ADAPTER_MAP_BYTES) return null
    const parsed = JSON.parse(await readFile(map, 'utf8')) as { sessions?: unknown }
    const sessions =
      typeof parsed.sessions === 'object' && parsed.sessions !== null
        ? (parsed.sessions as Record<string, unknown>)
        : {}
    const entry = sessions[sessionId] as { sessionFile?: unknown } | undefined
    const file = typeof entry?.sessionFile === 'string' ? entry.sessionFile : null
    if (!file || !path.isAbsolute(file)) return null
    return parseHeader(await readHead(file))?.id === sessionId ? file : null
  } catch {
    return null
  }
}

/**
 * The file of a session: in `known`, a folder pi named for a session of the directory it runs in,
 * in that directory's own folder when `cwd` names it, in any other folder of pi's sessions, as
 * after the directory moved, then where the adapter's map says. Null when pi has no file for it,
 * as for a session that was never prompted.
 */
export async function findSessionFile(
  folders: PiFolders,
  cwd: string | null,
  sessionId: string,
  known: string | null = null,
): Promise<string | null> {
  const own = cwd === null ? [] : [path.join(folders.sessions, folderName(cwd))]
  const first = [...new Set([...(known ? [known] : []), ...own, folders.sessions])]
  for (const dir of first) {
    const file = await findIn(dir, sessionId)
    if (file) return file
  }
  for (const dir of await subfolders(folders.sessions)) {
    if (first.includes(dir)) continue
    const file = await findIn(dir, sessionId)
    if (file) return file
  }
  return fromAdapterMap(folders.adapterMap, sessionId)
}

function titleIn(lines: readonly string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.includes('"session_info"')) continue
    try {
      const entry = JSON.parse(line) as { type?: unknown; name?: unknown }
      if (entry.type === 'session_info' && typeof entry.name === 'string' && entry.name.trim()) {
        return entry.name.trim()
      }
    } catch {
      // A line the tail cut.
    }
  }
  return null
}

function firstPrompt(lines: readonly string[]): string | null {
  for (const line of lines) {
    if (!line.includes('"user"')) continue
    try {
      const entry = JSON.parse(line) as {
        type?: unknown
        message?: { role?: unknown; content?: unknown }
      }
      if (entry.type !== 'message' || entry.message?.role !== 'user') continue
      const content = entry.message.content
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? ((content as { type?: unknown; text?: unknown }[]).find(
                (block) => block.type === 'text' && typeof block.text === 'string',
              )?.text as string | undefined)
            : undefined
      if (text?.trim()) return [...text.trim()].slice(0, TITLE_CHARS).join('')
    } catch {
      // A line the read cut.
    }
  }
  return null
}

function lastTime(lines: readonly string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]!) as { timestamp?: unknown }
      if (typeof entry.timestamp !== 'string') continue
      const time = Date.parse(entry.timestamp)
      if (Number.isFinite(time)) return new Date(time).toISOString()
    } catch {
      // A line the tail cut.
    }
  }
  return null
}

async function describe(file: string, cwd: string): Promise<ListedSession | null> {
  const header = parseHeader(await readHead(file))
  if (!header || header.cwd !== cwd) return null
  let title: string | null = null
  let updatedAt: string | null = null
  try {
    const info = await stat(file)
    const tail = (await readTail(file, info.size)).split(/\r?\n/)
    title = titleIn(tail)
    updatedAt = lastTime(tail) ?? info.mtime.toISOString()
    // A session's name is its title; without one, the start of its first prompt stands for it.
    if (!title) {
      const head =
        info.size <= TAIL_BYTES ? tail : (await readFile(file, 'utf8')).split(/\r?\n/, 4_000)
      title = firstPrompt(head)
    }
  } catch {
    // Listed without what could not be read.
  }
  return { sessionId: header.id, title, updatedAt, cwd: header.cwd }
}

/**
 * The saved sessions of a working directory, the latest first: those in its own folder, in
 * `known`, and directly in pi's sessions folder, as a session folder the user set holds them.
 */
export async function listSessionFiles(
  folders: PiFolders,
  cwd: string,
  known: string | null = null,
): Promise<ListedSession[]> {
  const dirs = [
    ...new Set([
      ...(known ? [known] : []),
      path.join(folders.sessions, folderName(cwd)),
      folders.sessions,
    ]),
  ]
  const files = (await Promise.all(dirs.map(jsonlFiles))).flat()
  const listed = new Map<string, ListedSession>()
  for (const file of files) {
    const session = await describe(file, cwd)
    if (session && !listed.has(session.sessionId)) listed.set(session.sessionId, session)
  }
  return [...listed.values()].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
}

/** Deletes a session's file; one that is gone already is no failure. */
export async function removeSessionFile(file: string): Promise<void> {
  await rm(file, { force: true })
}
