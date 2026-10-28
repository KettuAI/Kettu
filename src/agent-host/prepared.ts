// What prepared sessions need beside the session manager: the record that outlives a crash, and
// the watch on the agent's settings that replaces a prepared session when they change.

import { watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import type { Platform } from '@shared/platform'
import { AGENT_IDS, type AgentId } from '@shared/thread'
import { configLocations } from './agent-details'
import { pathKey } from './paths'
import { JsonFile, type LogFn } from './storage'

/** An agent's session opened for New session and neither adopted nor removed yet. */
export interface PreparedRecord {
  agentId: AgentId
  acpSessionId: string
  cwd: string
}

export interface PreparedFile {
  version: 1
  sessions: PreparedRecord[]
}

export function parsePreparedFile(data: Record<string, unknown>): PreparedFile | string {
  if (!Array.isArray(data.sessions)) return 'sessions is not an array'
  const sessions = data.sessions.flatMap((item): PreparedRecord[] => {
    if (typeof item !== 'object' || item === null) return []
    const { agentId, acpSessionId, cwd } = item as Record<string, unknown>
    if (typeof agentId !== 'string' || !AGENT_IDS.includes(agentId as AgentId)) return []
    if (typeof acpSessionId !== 'string' || typeof cwd !== 'string') return []
    return [{ agentId: agentId as AgentId, acpSessionId, cwd }]
  })
  return { version: 1, sessions }
}

export function preparedFile(userDataPath: string, log: LogFn): JsonFile<PreparedFile> {
  return new JsonFile<PreparedFile>({
    file: path.join(userDataPath, 'state', 'prepared-sessions.json'),
    version: 1,
    migrations: {},
    parse: parsePreparedFile,
    empty: () => ({ version: 1, sessions: [] }),
    log,
  })
}

/**
 * The prepared sessions an agent holds, written as each opens and goes, so a host that starts
 * after a crash removes those its predecessor left.
 */
export class PreparedRecords {
  private readonly current: PreparedRecord[] = []
  private leftovers: PreparedRecord[] = []
  private readonly taken = new Set<AgentId>()

  constructor(private readonly file: JsonFile<PreparedFile> | null) {}

  async load(): Promise<void> {
    if (!this.file) return
    this.leftovers = (await this.file.load()).sessions
  }

  flush(): Promise<void> {
    return this.file?.flush() ?? Promise.resolve()
  }

  add(record: PreparedRecord): void {
    this.current.push(record)
    this.save()
  }

  remove(agentId: AgentId, acpSessionId: string): void {
    const at = this.current.findIndex(
      (r) => r.agentId === agentId && r.acpSessionId === acpSessionId,
    )
    const left = this.leftovers.findIndex(
      (r) => r.agentId === agentId && r.acpSessionId === acpSessionId,
    )
    if (at >= 0) this.current.splice(at, 1)
    if (left >= 0) this.leftovers.splice(left, 1)
    if (at >= 0 || left >= 0) this.save()
  }

  /** What an earlier host left of the agent's, handed out once; `remove` drops each that went. */
  takeLeftovers(agentId: AgentId): PreparedRecord[] {
    if (this.taken.has(agentId)) return []
    this.taken.add(agentId)
    return this.leftovers.filter((r) => r.agentId === agentId)
  }

  private save(): void {
    this.file?.save({ version: 1, sessions: [...this.leftovers, ...this.current] })
  }
}

/** A folder to watch and the names in it whose change counts; other changes there are ignored. */
export interface WatchTarget {
  dir: string
  names: string[]
}

// The project's own settings, by agent: each folder with the names in it that hold them.
const PROJECT_SETTINGS: Partial<Record<AgentId, { dir: string; names: string[] }[]>> = {
  'claude-code': [
    { dir: '', names: ['.claude'] },
    { dir: '.claude', names: ['settings.json', 'settings.local.json'] },
  ],
  codex: [
    { dir: '', names: ['.codex'] },
    { dir: '.codex', names: ['config.toml'] },
  ],
  opencode: [{ dir: '', names: ['opencode.json', 'opencode.jsonc', '.opencode'] }],
  pi: [
    { dir: '', names: ['.pi'] },
    { dir: '.pi', names: ['settings.json'] },
  ],
  'fake-agent': [{ dir: '', names: ['.fake-agent.json'] }],
}

/**
 * The folders whose change can change what an agent reports for a session in `folder`: the one
 * that holds the agent's own settings file, and the project's. Watching a folder rather than the
 * file catches a file that a tool replaces instead of writing.
 */
export function settingsTargets(
  agentId: AgentId,
  folder: string,
  getEnv: (name: string) => string | undefined,
  home: string,
  platform: Platform,
): WatchTarget[] {
  const p = platform === 'win32' ? path.win32 : path.posix
  const targets = new Map<string, WatchTarget>()
  const add = (dir: string, names: string[]): void => {
    const key = pathKey(dir, platform)
    const known = targets.get(key)
    if (known) known.names = [...new Set([...known.names, ...names])]
    else targets.set(key, { dir, names })
  }
  const settings = configLocations(agentId, getEnv, home, platform).find((l) => l.id === 'settings')
  for (const file of settings?.candidates ?? []) add(p.dirname(file), [p.basename(file)])
  for (const { dir, names } of PROJECT_SETTINGS[agentId] ?? []) add(p.join(folder, dir), names)
  return [...targets.values()]
}

/**
 * Watches the targets and calls `changed` once, `delayMs` after the last change that counts. A
 * folder that does not exist, or cannot be watched, is skipped: its parent's watch sees it made.
 */
export function watchSettings(
  targets: readonly WatchTarget[],
  changed: () => void,
  delayMs: number,
  log: (message: string) => void,
): () => void {
  const watchers: FSWatcher[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let closed = false
  for (const target of targets) {
    try {
      const watcher = watch(target.dir, { persistent: false }, (_event, name) => {
        // Without a name, as some platforms report, any change counts.
        if (closed || (name !== null && !target.names.includes(String(name)))) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = null
          if (!closed) changed()
        }, delayMs)
      })
      watcher.on('error', (error) => log(`Stopped watching ${target.dir}: ${error.message}`))
      watchers.push(watcher)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        log(`Could not watch ${target.dir}: ${(error as Error).message}`)
      }
    }
  }
  return () => {
    closed = true
    if (timer) clearTimeout(timer)
    for (const watcher of watchers) watcher.close()
  }
}
