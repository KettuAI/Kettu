// Kettu's memory on the host: global memory about the user and each project's memory, kept as one
// Markdown file per entry under the host's data folder, with a MEMORY.md index per layer, the undo
// records of writes, and the text a session starts with.

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { longer } from '@shared/artifacts'
import type { AgentId } from '@shared/agents'
import {
  MEMORY_BODY_CHARS,
  MEMORY_DESCRIPTION_CHARS,
  MEMORY_ENTRIES_PER_LAYER,
  MEMORY_ID,
  MEMORY_TITLE_CHARS,
  type MemoryDraft,
  type MemoryEntry,
  type MemoryImportResult,
  type MemoryImportScan,
  type MemoryImportSource,
  type MemoryOverview,
  type MemoryScope,
  type MemorySource,
} from '@shared/memory'
import type { Platform } from '@shared/platform'
import { pathKey } from '../paths'
import { writeFileAtomic, type LogFn } from '../storage'
import { claudeMemoryDir, readClaudeMemory, type ClaudeMemory } from './claude-import'
import { formatEntry, newId, normalizeBody, oneLine, parseEntry } from './entry-file'
import { MemoryError } from './errors'
import { indexText } from './index-text'
import { secretKind } from './secrets'

export { MemoryError, type MemoryErrorCode } from './errors'

export interface MemoryServiceDeps {
  /** `<host data folder>/memory` */
  root: string
  log: LogFn
  /** Kettu's projects: path and display name. */
  projects(): { path: string; name: string }[]
  /** Claude Code agents of this host and their config dirs, for import. */
  claudeAgents(): { agentId: AgentId; name: string; configDir: string }[]
  now?(): number
}

const INDEX_FILE = 'MEMORY.md'
const SETTINGS_VERSION = 1
const UNDO_VERSION = 1
const UNDO_KEPT = 500
const UNDO_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
/** `<time in base 36>-<8 hex>`, so names sort by when they were made. */
const UNDO_ID = /^[0-9a-z]{9}-[0-9a-f]{8}$/
const PLATFORM = process.platform as Platform

/** What a write replaced, to put it back while the entry is as the write left it. */
interface UndoRecord {
  version: number
  layer: 'global' | 'project'
  project: string | null
  memoryId: string
  /** The file's text before the write; null when the write made it. */
  before: string | null
  /** The SHA-256 of the text the write left; null when it removed the file. */
  after: string | null
}

/** What an import adds to a layer, beside what the layer holds. */
interface ImportPlan {
  layer: Layer
  entries: MemoryEntry[]
  /** The title and body of every entry held or added, to skip copies. */
  held: Set<string>
  adds: Omit<MemoryEntry, 'id'>[]
}

/** A layer's folder and what its MEMORY.md is headed with. */
interface Layer {
  dir: string
  heading: string
  /** The project as Kettu lists it; null for global memory. */
  project: { path: string; name: string } | null
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function contentKey(entry: { title: string; body: string }): string {
  return `${entry.title}\u0000${entry.body}`
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function newestFirst(a: MemoryEntry, b: MemoryEntry): number {
  return b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)
}

/** `<basename>-<12 hex of the path's SHA-256>`, readable and unique per project. */
export function projectDirName(project: string): string {
  const key = pathKey(project, PLATFORM)
  const base = path
    .basename(project)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 40)
  return `${base || 'project'}-${sha256(key).slice(0, 12)}`
}

export class MemoryService {
  private on = true
  private readonly listeners = new Set<() => void>()
  /** Writes in turn, so counts, ids and undo checks see each other's results. */
  private tail: Promise<unknown> = Promise.resolve()
  /** Files already logged as unreadable, so a read of the layer logs each once. */
  private readonly warned = new Set<string>()

  constructor(private readonly deps: MemoryServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run)
    this.tail = result.catch(() => undefined)
    return result
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        this.deps.log('error', `A memory listener failed: ${(error as Error).message}`)
      }
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // The switch.

  private get settingsFile(): string {
    return path.join(this.deps.root, 'settings.json')
  }

  /** Reads settings.json; memory is on unless the file turns it off. */
  async load(): Promise<void> {
    const text = await readText(this.settingsFile).catch((error: Error) => {
      this.deps.log('warn', `Could not read memory settings: ${error.message}`)
      return null
    })
    if (text === null) return
    try {
      const data = JSON.parse(text) as { enabled?: unknown }
      if (typeof data.enabled !== 'boolean') throw new Error('enabled is not a boolean')
      this.on = data.enabled
    } catch (error) {
      this.deps.log(
        'warn',
        `Memory settings are not valid, so memory stays on: ${(error as Error).message}`,
      )
    }
  }

  get enabled(): boolean {
    return this.on
  }

  setEnabled(on: boolean): Promise<void> {
    return this.exclusive(async () => {
      const settings = { version: SETTINGS_VERSION, enabled: on }
      await writeFileAtomic(this.settingsFile, `${JSON.stringify(settings, null, 2)}\n`)
      this.on = on
      this.changed()
    })
  }

  // Layers.

  private knownProject(project: string): { path: string; name: string } | null {
    const key = pathKey(project, PLATFORM)
    return this.deps.projects().find((known) => pathKey(known.path, PLATFORM) === key) ?? null
  }

  private projectLayer(known: { path: string; name: string }): Layer {
    return {
      dir: path.join(this.deps.root, 'projects', projectDirName(known.path)),
      heading: `Project memory: ${oneLine(known.name)}`,
      project: known,
    }
  }

  private globalLayer(): Layer {
    return { dir: path.join(this.deps.root, 'global'), heading: 'Global memory', project: null }
  }

  /** The scope's layer; a project Kettu does not list has none. */
  private layer(scope: MemoryScope): Layer {
    if (scope.layer === 'global') return this.globalLayer()
    const known = this.knownProject(scope.project)
    if (!known) throw new MemoryError('not_found', `Kettu has no project at ${scope.project}.`)
    return this.projectLayer(known)
  }

  /** The ids of the layer's entry files, without reading them. */
  private async ids(layer: Layer): Promise<string[]> {
    let names: string[]
    try {
      names = await readdir(layer.dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const ids: string[] = []
    for (const name of names) {
      if (name === INDEX_FILE || !name.endsWith('.md')) continue
      const id = name.slice(0, -3)
      if (MEMORY_ID.test(id)) ids.push(id)
      else this.warnOnce(path.join(layer.dir, name), 'its name is no memory id')
    }
    return ids
  }

  private warnOnce(file: string, reason: string): void {
    if (this.warned.has(file)) return
    this.warned.add(file)
    this.deps.log('warn', `Memory passes over ${file}: ${reason}`)
  }

  private async readEntry(layer: Layer, id: string): Promise<MemoryEntry | null> {
    const file = path.join(layer.dir, `${id}.md`)
    const text = await readText(file)
    if (text === null) return null
    const parsed = parseEntry(id, text)
    let { created, updated } = parsed
    if (created === null || updated === null) {
      const modified = (await stat(file)).mtimeMs
      created ??= modified
      updated ??= modified
    }
    return { ...parsed.entry, createdAt: created, updatedAt: updated }
  }

  /** The layer's entries, newest updated first; a file that cannot be read is logged and left out. */
  private async readLayer(layer: Layer): Promise<MemoryEntry[]> {
    const entries: MemoryEntry[] = []
    for (const id of await this.ids(layer)) {
      try {
        const entry = await this.readEntry(layer, id)
        if (entry) entries.push(entry)
      } catch (error) {
        this.warnOnce(path.join(layer.dir, `${id}.md`), (error as Error).message)
      }
    }
    return entries.sort(newestFirst)
  }

  private async writeIndex(layer: Layer, entries: MemoryEntry[]): Promise<void> {
    const lines = [
      `# ${layer.heading}`,
      '',
      'Kettu writes this list from the entry files beside it; change those, not this file.',
      '',
      ...[...entries].sort(newestFirst).map((entry) => {
        const text = entry.description === '' ? entry.title : `${entry.title}: ${entry.description}`
        return `- [${oneLine(text)}](${entry.id}.md)`
      }),
    ]
    await writeFileAtomic(path.join(layer.dir, INDEX_FILE), `${lines.join('\n')}\n`)
  }

  private async prepare(layer: Layer): Promise<void> {
    await mkdir(layer.dir, { recursive: true })
    if (!layer.project) return
    const file = path.join(layer.dir, 'project.json')
    if ((await readText(file)) !== null) return
    const record = { version: 1, path: layer.project.path }
    await writeFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`)
  }

  // Checks.

  /** The draft as it is written: trimmed, on one line where it must be, within the limits. */
  private clean(draft: MemoryDraft): MemoryDraft {
    if (
      typeof draft !== 'object' ||
      draft === null ||
      typeof draft.title !== 'string' ||
      typeof draft.description !== 'string' ||
      typeof draft.body !== 'string'
    ) {
      throw new MemoryError('invalid', 'An entry needs a title, a description and a body.')
    }
    const title = oneLine(draft.title)
    const description = oneLine(draft.description)
    const body = normalizeBody(draft.body)
    if (title === '') throw new MemoryError('invalid', 'title must not be empty.')
    if (longer(title, MEMORY_TITLE_CHARS)) {
      throw new MemoryError('invalid', `title must be at most ${MEMORY_TITLE_CHARS} characters.`)
    }
    if (longer(description, MEMORY_DESCRIPTION_CHARS)) {
      throw new MemoryError(
        'invalid',
        `description must be at most ${MEMORY_DESCRIPTION_CHARS} characters.`,
      )
    }
    if (longer(body, MEMORY_BODY_CHARS)) {
      throw new MemoryError(
        'invalid',
        `body must be at most ${MEMORY_BODY_CHARS} characters. Keep one fact per entry.`,
      )
    }
    const secret = secretKind(`${title}\n${description}\n${body}`)
    if (secret !== null) {
      throw new MemoryError(
        'secret',
        `This seems to hold ${secret}. Memory never keeps secrets; leave it out.`,
      )
    }
    return { title, description, body }
  }

  /** Checks a write as `save` would and gives the draft as it would be written, writing nothing. */
  async check(scope: MemoryScope, id: string | null, draft: MemoryDraft): Promise<MemoryDraft> {
    const layer = this.layer(scope)
    const clean = this.clean(draft)
    return this.exclusive(async () => {
      await this.checked(layer, id, clean)
      return clean
    })
  }

  /** The layer's entries and the one `id` names, once the write is known to be allowed. */
  private async checked(
    layer: Layer,
    id: string | null,
    draft: MemoryDraft,
  ): Promise<{ entries: MemoryEntry[]; existing: MemoryEntry | null }> {
    const entries = await this.readLayer(layer)
    let existing: MemoryEntry | null = null
    if (id === null) {
      if (entries.length >= MEMORY_ENTRIES_PER_LAYER) {
        throw new MemoryError(
          'full',
          `This memory holds ${MEMORY_ENTRIES_PER_LAYER} entries, its limit. Update or forget an entry instead.`,
        )
      }
    } else {
      existing = MEMORY_ID.test(id) ? await this.readEntry(layer, id) : null
      if (!existing) throw this.missing(id)
    }
    const twin = entries.find(
      (entry) => entry.id !== id && entry.title.toLowerCase() === draft.title.toLowerCase(),
    )
    if (twin) {
      throw new MemoryError(
        'conflict',
        `The entry ${twin.id} already has this title. Update that entry instead of adding another.`,
      )
    }
    return { entries, existing }
  }

  private missing(id: string): MemoryError {
    return new MemoryError('not_found', `No memory entry has the id ${id}.`)
  }

  // Reading.

  async overview(): Promise<MemoryOverview> {
    const projects = await Promise.all(
      this.deps.projects().map(async (project) => ({
        path: project.path,
        name: project.name,
        count: (await this.ids(this.projectLayer(project))).length,
      })),
    )
    const [global, scan] = await Promise.all([this.list({ layer: 'global' }), this.importScan()])
    const importable = scan.sources.reduce((sum, source) => sum + source.entries.length, 0)
    return { enabled: this.on, global, projects, importable }
  }

  /** The scope's entries, newest updated first. */
  async list(scope: MemoryScope): Promise<MemoryEntry[]> {
    return this.readLayer(this.layer(scope))
  }

  async get(scope: MemoryScope, id: string): Promise<MemoryEntry | null> {
    const layer = this.layer(scope)
    if (!MEMORY_ID.test(id)) return null
    return this.readEntry(layer, id)
  }

  // Writing.

  /** New entry when id is null. Validates limits, refuses secrets. Returns the undo record id. */
  async save(
    scope: MemoryScope,
    id: string | null,
    draft: MemoryDraft,
    by: MemorySource,
  ): Promise<{ entry: MemoryEntry; undo: string }> {
    const layer = this.layer(scope)
    const clean = this.clean(draft)
    return this.exclusive(async () => {
      const { entries, existing } = await this.checked(layer, id, clean)
      const now = this.now()
      const entry: MemoryEntry = {
        id: existing?.id ?? newId(clean.title, new Set(entries.map((other) => other.id))),
        ...clean,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        source: { agentId: by.agentId, sessionId: by.sessionId },
      }
      const file = path.join(layer.dir, `${entry.id}.md`)
      const before = existing ? await readText(file) : null
      const text = formatEntry(entry)
      await this.prepare(layer)
      await writeFileAtomic(file, text)
      await this.writeIndex(layer, [...entries.filter((other) => other.id !== entry.id), entry])
      const undo = await this.recordUndo(layer, entry.id, before, text)
      this.deps.log(
        'info',
        `Memory ${existing ? 'updated' : 'added'} ${layer.project ? 'project' : 'global'} entry ${entry.id}${by.agentId ? ` for ${by.agentId}` : ''}`,
      )
      this.changed()
      return { entry, undo }
    })
  }

  async remove(
    scope: MemoryScope,
    id: string,
    by: MemorySource,
  ): Promise<{ undo: string; title: string }> {
    const layer = this.layer(scope)
    return this.exclusive(async () => {
      const file = path.join(layer.dir, `${id}.md`)
      const entry = MEMORY_ID.test(id) ? await this.readEntry(layer, id) : null
      const before = entry ? await readText(file) : null
      if (!entry || before === null) throw this.missing(id)
      await rm(file, { force: true })
      const entries = await this.readLayer(layer)
      await this.writeIndex(layer, entries)
      const undo = await this.recordUndo(layer, id, before, null)
      this.deps.log(
        'info',
        `Memory removed ${layer.project ? 'project' : 'global'} entry ${id}${by.agentId ? ` for ${by.agentId}` : ''}`,
      )
      this.changed()
      return { undo, title: entry.title }
    })
  }

  /** Moves a project's entry to global memory, under its id there if that is free. */
  async moveToGlobal(project: string, id: string): Promise<MemoryEntry> {
    const from = this.layer({ layer: 'project', project })
    const to = this.globalLayer()
    return this.exclusive(async () => {
      const entry = MEMORY_ID.test(id) ? await this.readEntry(from, id) : null
      if (!entry) throw this.missing(id)
      const global = await this.readLayer(to)
      if (global.length >= MEMORY_ENTRIES_PER_LAYER) {
        throw new MemoryError(
          'full',
          `Global memory holds ${MEMORY_ENTRIES_PER_LAYER} entries, its limit. Remove one first.`,
        )
      }
      const taken = new Set(global.map((other) => other.id))
      const moved = { ...entry, id: taken.has(id) ? newId(entry.title, taken) : id }
      await this.prepare(to)
      await writeFileAtomic(path.join(to.dir, `${moved.id}.md`), formatEntry(moved))
      await rm(path.join(from.dir, `${id}.md`), { force: true })
      await this.writeIndex(to, [...global, moved])
      await this.writeIndex(from, await this.readLayer(from))
      this.changed()
      return moved
    })
  }

  // Undo.

  private get undoDir(): string {
    return path.join(this.deps.root, 'undo')
  }

  private async recordUndo(
    layer: Layer,
    memoryId: string,
    before: string | null,
    after: string | null,
  ): Promise<string> {
    const now = this.now()
    const id = `${now.toString(36).padStart(9, '0')}-${randomBytes(4).toString('hex')}`
    const record: UndoRecord = {
      version: UNDO_VERSION,
      layer: layer.project ? 'project' : 'global',
      project: layer.project?.path ?? null,
      memoryId,
      before,
      after: after === null ? null : sha256(after),
    }
    await writeFileAtomic(path.join(this.undoDir, `${id}.json`), `${JSON.stringify(record)}\n`)
    await this.pruneUndo(now)
    return id
  }

  /** Drops records older than 30 days and all but the newest 500. */
  private async pruneUndo(now: number): Promise<void> {
    const names = (await readdir(this.undoDir).catch(() => [] as string[]))
      .filter((name) => name.endsWith('.json') && UNDO_ID.test(name.slice(0, -5)))
      .sort()
      .reverse()
    const oldest = now - UNDO_DAYS * DAY_MS
    const stale = names.filter(
      (name, index) => index >= UNDO_KEPT || parseInt(name.slice(0, 9), 36) < oldest,
    )
    await Promise.all(stale.map((name) => rm(path.join(this.undoDir, name), { force: true })))
  }

  private async readUndo(undoId: string): Promise<UndoRecord | null> {
    const text = await readText(path.join(this.undoDir, `${undoId}.json`))
    if (text === null) return null
    try {
      const record = JSON.parse(text) as UndoRecord
      const valid =
        (record.layer === 'global' || record.layer === 'project') &&
        (record.layer === 'global' || typeof record.project === 'string') &&
        typeof record.memoryId === 'string' &&
        MEMORY_ID.test(record.memoryId) &&
        (record.before === null || typeof record.before === 'string') &&
        (record.after === null || typeof record.after === 'string')
      return valid ? record : null
    } catch {
      return null
    }
  }

  /** Restores what the write with this undo record replaced, while the entry is as it left it. */
  undo(undoId: string): Promise<'undone' | 'changed' | 'gone'> {
    return this.exclusive(async () => {
      if (!UNDO_ID.test(undoId)) return 'gone'
      const record = await this.readUndo(undoId)
      if (!record) return 'gone'
      const known = record.project === null ? null : this.knownProject(record.project)
      if (record.layer === 'project' && !known) return 'gone'
      const layer = known ? this.projectLayer(known) : this.globalLayer()
      const file = path.join(layer.dir, `${record.memoryId}.md`)
      const current = await readText(file)
      const asLeft =
        record.after === null
          ? current === null
          : current !== null && sha256(current) === record.after
      if (!asLeft) return 'changed'
      if (record.before === null) await rm(file, { force: true })
      else {
        await this.prepare(layer)
        await writeFileAtomic(file, record.before)
      }
      await this.writeIndex(layer, await this.readLayer(layer))
      await rm(path.join(this.undoDir, `${undoId}.json`), { force: true })
      this.deps.log('info', `Memory undid a write to entry ${record.memoryId}`)
      this.changed()
      return 'undone'
    })
  }

  // What sessions start with.

  /**
   * The text a session starts with; project null for a session without one. tools=false when the
   * agent has no Kettu MCP service, so the text does not point at tools it lacks. It does not look
   * at the switch: a session of memory that is off is given none.
   */
  async index(project: string | null, tools: boolean): Promise<string> {
    const global = await this.list({ layer: 'global' })
    if (project === null) return indexText({ project: null, global, tools })
    const known = this.knownProject(project)
    if (!known) {
      this.deps.log('warn', `Memory has no project at ${project}; the session gets global memory`)
      return indexText({ project: null, global, tools })
    }
    const entries = await this.readLayer(this.projectLayer(known))
    return indexText({ project: { name: known.name, entries }, global, tools })
  }

  // Import from Claude Code's own memory.

  /** Names an entry of a source for `import`, which finds it again by reading the source anew. */
  private importKey(agentId: AgentId, project: string, file: string): string {
    return sha256(`${agentId}\u0000${pathKey(project, PLATFORM)}\u0000${file}`).slice(0, 32)
  }

  /** The title and body of what the project's and global memory hold, to skip copies of them. */
  private async heldContent(project: { path: string; name: string }): Promise<Set<string>> {
    const [own, global] = await Promise.all([
      this.readLayer(this.projectLayer(project)),
      this.readLayer(this.globalLayer()),
    ])
    return new Set([...own, ...global].map(contentKey))
  }

  /** The entry as an import writes it, or null with a log line when it would be refused. */
  private importable(memory: ClaudeMemory): MemoryDraft | null {
    try {
      return this.clean(memory.draft)
    } catch (error) {
      this.deps.log('warn', `Memory import passes over ${memory.file}: ${(error as Error).message}`)
      return null
    }
  }

  async importScan(): Promise<MemoryImportScan> {
    const projects = this.deps.projects()
    const sources: MemoryImportSource[] = []
    const held = new Map<string, Set<string>>()
    // Two agents may share a config folder, whose entries are listed once, under the first.
    const read = new Set<string>()
    for (const agent of this.deps.claudeAgents()) {
      for (const project of projects) {
        const folder = claudeMemoryDir(agent.configDir, project.path)
        const real = await realpath(folder).catch(() => folder)
        if (read.has(real)) continue
        read.add(real)
        const memories = await readClaudeMemory(folder, this.deps.log)
        if (memories.length === 0) continue
        if (!held.has(project.path)) held.set(project.path, await this.heldContent(project))
        const there = held.get(project.path)!
        const entries = memories.flatMap((memory) => {
          const draft = this.importable(memory)
          if (!draft || there.has(contentKey(draft))) return []
          return [
            {
              key: this.importKey(agent.agentId, project.path, memory.file),
              title: draft.title,
              description: draft.description,
              aboutUser: memory.aboutUser,
            },
          ]
        })
        if (entries.length === 0) continue
        sources.push({
          agentId: agent.agentId,
          agentName: agent.name,
          project: project.path,
          projectName: project.name,
          entries,
        })
      }
    }
    return { sources }
  }

  private async importPlan(layer: Layer): Promise<ImportPlan> {
    const entries = await this.readLayer(layer)
    return { layer, entries, held: new Set(entries.map(contentKey)), adds: [] }
  }

  /**
   * Copies the sources' entries into their projects' memory, or global memory for the keys in
   * `global`, skipping what is already there. Refuses the whole import when a layer would overflow.
   */
  import(
    sources: { agentId: AgentId; project: string }[],
    global: string[],
  ): Promise<MemoryImportResult> {
    return this.exclusive(async () => {
      const toGlobal = new Set(global)
      const agents = this.deps.claudeAgents()
      const globalPlan = await this.importPlan(this.globalLayer())
      const plans = new Map<string, ImportPlan>([[globalPlan.layer.dir, globalPlan]])
      const done = new Set<string>()
      const result: MemoryImportResult = { imported: 0, skipped: 0, global: 0 }
      for (const source of sources) {
        const agent = agents.find((candidate) => candidate.agentId === source.agentId)
        const known = this.knownProject(source.project)
        if (!agent || !known) {
          throw new MemoryError('not_found', 'An import source names an unknown agent or project.')
        }
        const layer = this.projectLayer(known)
        if (done.has(`${agent.agentId}\u0000${layer.dir}`)) continue
        done.add(`${agent.agentId}\u0000${layer.dir}`)
        let own = plans.get(layer.dir)
        if (!own) {
          own = await this.importPlan(layer)
          plans.set(layer.dir, own)
        }
        const memories = await readClaudeMemory(
          claudeMemoryDir(agent.configDir, known.path),
          this.deps.log,
        )
        for (const memory of memories) {
          const draft = this.importable(memory)
          if (!draft) continue
          const content = contentKey(draft)
          if (own.held.has(content) || globalPlan.held.has(content)) {
            result.skipped++
            continue
          }
          const into = toGlobal.has(this.importKey(agent.agentId, known.path, memory.file))
            ? globalPlan
            : own
          const at = Math.min(memory.modifiedAt, this.now())
          into.held.add(content)
          into.adds.push({
            ...draft,
            createdAt: at,
            updatedAt: at,
            source: { agentId: agent.agentId, sessionId: null },
          })
          result.imported++
          if (into === globalPlan) result.global++
        }
      }
      for (const { layer, entries, adds } of plans.values()) {
        if (entries.length + adds.length > MEMORY_ENTRIES_PER_LAYER) {
          throw new MemoryError(
            'full',
            `${layer.heading} would go past its limit of ${MEMORY_ENTRIES_PER_LAYER} entries. Remove some first.`,
          )
        }
      }
      for (const { layer, entries, adds } of plans.values()) {
        if (adds.length === 0) continue
        const taken = new Set(entries.map((entry) => entry.id))
        const written: MemoryEntry[] = []
        await this.prepare(layer)
        for (const add of adds) {
          const entry = { id: newId(add.title, taken), ...add }
          taken.add(entry.id)
          await writeFileAtomic(path.join(layer.dir, `${entry.id}.md`), formatEntry(entry))
          written.push(entry)
        }
        await this.writeIndex(layer, [...entries, ...written])
      }
      this.deps.log('info', `Memory imported ${result.imported} entries, skipped ${result.skipped}`)
      if (result.imported > 0) this.changed()
      return result
    })
  }
}
