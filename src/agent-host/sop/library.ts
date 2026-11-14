// The SOPs a host can run: the official ones Kettu ships and the user's library, one YAML file per
// SOP under `<userData>/sops`. A library SOP is usable only while its file's hash is the one the
// user approved, so an agent cannot write itself an unchecked flow. The user's pins and the SOP
// switches in Settings live beside it in `state/sops.json`, never in the SOP files.

import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { isAgentId } from '@shared/agents'
import {
  isStepPick,
  SOP_FILE_BYTES,
  SOP_ID_CHARS,
  usableSop,
  type Sop,
  type SopAddSource,
  type SopEntry,
  type SopOrigin,
  type SopProblem,
  type SopSource,
  type StepPick,
} from '@shared/sop'
import type { AgentId } from '@shared/thread'
import { HostError, invalidParams, notFound } from '../errors'
import { t } from '../i18n'
import { JsonFile, writeFileAtomic, type LogFn, type Migration } from '../storage'
import { parseSop, sopHash, toolProblems } from './format'
import { OFFICIAL_SOPS } from './official'

export const SOPS_VERSION = 1
// No older formats exist yet; each future version adds its step here, with a test.
export const SOPS_MIGRATIONS: Readonly<Record<number, Migration>> = {}
const FETCH_TIMEOUT_MS = 15_000
const MAX_LIBRARY = 200
const ID = /^[a-z0-9][a-z0-9-]*$/

type LibrarySource = Exclude<SopSource, 'official'>

export interface LibraryRecord {
  source: LibrarySource
  origin: SopOrigin | null
  addedAt: number
  /** The hash the user approved; null until they do. */
  approved: string | null
}

export interface SopsFile {
  version: 1
  /** By SOP id; a file in the folder without a record is the user's own, unapproved. */
  entries: Record<string, LibraryRecord>
  pins: Record<string, Record<string, StepPick>>
  suggest: boolean
  autoPick: Partial<Record<AgentId, boolean>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string'

function originOf(value: unknown): SopOrigin | null | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  if (value.kind === 'github' && typeof value.url === 'string') {
    return { kind: 'github', url: value.url }
  }
  if (value.kind === 'file' && typeof value.name === 'string') {
    return { kind: 'file', name: value.name }
  }
  if (value.kind === 'agent' && typeof value.sessionId === 'string' && isAgentId(value.agentId)) {
    return { kind: 'agent', sessionId: value.sessionId, agentId: value.agentId }
  }
  return undefined
}

const SOURCES: ReadonlySet<unknown> = new Set(['github', 'file', 'agent', 'user'])

/** Parses the file; an entry or pin that does not read is dropped alone. */
export function parseSopsFile(data: Record<string, unknown>): SopsFile | string {
  if (!isRecord(data.entries)) return 'entries is not an object'
  const entries: SopsFile['entries'] = {}
  for (const [id, raw] of Object.entries(data.entries)) {
    if (!ID.test(id) || !isRecord(raw)) continue
    const origin = originOf(raw.origin)
    if (
      !SOURCES.has(raw.source) ||
      origin === undefined ||
      typeof raw.addedAt !== 'number' ||
      !isNullableString(raw.approved)
    ) {
      continue
    }
    entries[id] = {
      source: raw.source as LibrarySource,
      origin,
      addedAt: raw.addedAt,
      approved: raw.approved,
    }
  }
  const pins: SopsFile['pins'] = {}
  if (isRecord(data.pins)) {
    for (const [sopId, steps] of Object.entries(data.pins)) {
      if (!isRecord(steps)) continue
      const kept: Record<string, StepPick> = {}
      for (const [stepId, pick] of Object.entries(steps)) {
        if (isStepPick(pick)) kept[stepId] = { ...pick }
      }
      if (Object.keys(kept).length > 0) pins[sopId] = kept
    }
  }
  const autoPick: SopsFile['autoPick'] = {}
  if (isRecord(data.autoPick)) {
    for (const [agentId, allowed] of Object.entries(data.autoPick)) {
      if (isAgentId(agentId) && typeof allowed === 'boolean') autoPick[agentId] = allowed
    }
  }
  return {
    version: 1,
    entries,
    pins,
    suggest: typeof data.suggest === 'boolean' ? data.suggest : true,
    autoPick,
  }
}

export function emptySopsFile(): SopsFile {
  return { version: 1, entries: {}, pins: {}, suggest: true, autoPick: {} }
}

export function sopsFile(userDataPath: string, log: LogFn): JsonFile<SopsFile> {
  return new JsonFile<SopsFile>({
    file: path.join(userDataPath, 'state', 'sops.json'),
    version: SOPS_VERSION,
    migrations: SOPS_MIGRATIONS,
    parse: parseSopsFile,
    empty: emptySopsFile,
    log,
  })
}

/** What the library needs of the file, so tests can hand it one in memory. */
export type SopsStore = Pick<JsonFile<SopsFile>, 'load' | 'save' | 'flush'>

export interface SopLibraryDeps {
  /** `<userData>/sops`. */
  dir: string
  file: SopsStore
  /** The Marketplace's MCP servers and Skills by the names agents know them by. */
  knownTools(): { mcp: ReadonlySet<string>; skills: ReadonlySet<string> }
  log: LogFn
  fetch?: typeof fetch
  now?: () => number
  changed?(): void
}

/** An SOP a task can lock: what it is and the hash of the file it came from. */
export interface ResolvedSop {
  id: string
  source: SopSource
  name: string
  sop: Sop
  hash: string
}

/** The raw file of a GitHub file URL, or null for any other URL. */
export function githubRawUrl(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
  const parts = url.pathname.split('/').filter(Boolean)
  if (url.hostname === 'raw.githubusercontent.com' && parts.length >= 4) {
    return `https://raw.githubusercontent.com/${parts.map(encodeURIComponent).join('/')}`
  }
  if (url.hostname === 'github.com' && parts.length >= 5 && parts[2] === 'blob') {
    const [owner, repo, , ...rest] = parts
    return `https://raw.githubusercontent.com/${[owner!, repo!, ...rest].map(encodeURIComponent).join('/')}`
  }
  return null
}

/** A file name stem for an SOP's name: lowercase ASCII words joined by dashes. */
export function sopSlug(name: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug || 'sop'
}

interface Read {
  id: string
  text: string | null
  problems: SopProblem[]
  sop: Sop | null
  hash: string
}

export class SopLibrary {
  private data: SopsFile = emptySopsFile()
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private readonly official: Read[]

  constructor(private readonly deps: SopLibraryDeps) {
    this.fetch = deps.fetch ?? fetch
    this.now = deps.now ?? Date.now
    this.official = OFFICIAL_SOPS.map(({ id, text }) => {
      const read = parseSop(text)
      return { id, text, problems: read.problems, sop: read.sop, hash: sopHash(text) }
    })
  }

  async load(): Promise<void> {
    this.data = await this.deps.file.load()
  }

  flush(): Promise<void> {
    return this.deps.file.flush()
  }

  // Settings.

  get suggest(): boolean {
    return this.data.suggest
  }

  /** Whether Auto may pick the agent: the user's choice, else subscriptions yes and API keys no. */
  autoPick(agentId: AgentId, apiKey: boolean): { allowed: boolean; byDefault: boolean } {
    const byDefault = !apiKey
    return { allowed: this.data.autoPick[agentId] ?? byDefault, byDefault }
  }

  setSettings(change: { suggest?: boolean; autoPick?: Partial<Record<AgentId, boolean | null>> }) {
    if (change.suggest !== undefined) this.data.suggest = change.suggest
    for (const [agentId, allowed] of Object.entries(change.autoPick ?? {})) {
      if (allowed === null || allowed === undefined) delete this.data.autoPick[agentId as AgentId]
      else this.data.autoPick[agentId as AgentId] = allowed
    }
    this.save()
  }

  // Reading.

  async list(): Promise<SopEntry[]> {
    const library = await this.readLibrary()
    return [
      ...this.official.map((read) => this.entryOf(read, 'official')),
      ...library.map((read) => this.entryOf(read, this.data.entries[read.id]?.source ?? 'user')),
    ]
  }

  async read(sopId: string): Promise<{ entry: SopEntry; text: string | null }> {
    const official = this.official.find((read) => read.id === sopId)
    if (official) return { entry: this.entryOf(official, 'official'), text: official.text }
    const read = await this.readOne(sopId)
    const source = this.data.entries[sopId]?.source ?? 'user'
    return { entry: this.entryOf(read, source), text: read.text }
  }

  /** The SOP a new task locks; refused when it does not read, has problems or is not approved. */
  async resolve(sopId: string): Promise<ResolvedSop> {
    const { entry } = await this.read(sopId)
    if (!entry.sop || entry.problems.length > 0) {
      const problem = entry.problems[0]
      throw invalidParams(
        t('sop.unusable', {
          name: entry.name,
          problem: problem ? `${problem.at} ${problem.message}`.trim() : '',
        }),
      )
    }
    if (!usableSop(entry))
      throw new HostError('restricted', t('sop.notApproved', { name: entry.name }))
    return {
      id: entry.id,
      source: entry.source,
      name: entry.name,
      sop: entry.sop,
      hash: entry.hash,
    }
  }

  pins(sopId: string): Record<string, StepPick> {
    return { ...(this.data.pins[sopId] ?? {}) }
  }

  // Changes.

  async approve(sopId: string, hash: string): Promise<SopEntry> {
    if (this.official.some((read) => read.id === sopId)) return (await this.read(sopId)).entry
    const read = await this.readOne(sopId)
    if (read.text === null) throw notFound(t('sop.notFound'))
    // The user approves what they saw: a file changed since then must be looked at again.
    if (read.hash !== hash) throw new HostError('conflict', t('sop.changedSinceShown'))
    if (!read.sop) throw invalidParams(t('sop.invalid'))
    const record = this.data.entries[sopId] ?? {
      source: 'user' as const,
      origin: null,
      addedAt: this.now(),
      approved: null,
    }
    record.approved = hash
    this.data.entries[sopId] = record
    this.save()
    this.deps.changed?.()
    return this.entryOf(read, record.source)
  }

  async remove(sopId: string): Promise<void> {
    if (this.official.some((read) => read.id === sopId)) {
      throw new HostError('restricted', t('sop.officialKept'))
    }
    if (!ID.test(sopId)) throw notFound(t('sop.notFound'))
    await rm(this.fileOf(sopId), { force: true })
    delete this.data.entries[sopId]
    delete this.data.pins[sopId]
    this.save()
    this.deps.changed?.()
  }

  async setPin(sopId: string, stepId: string, pick: StepPick | null): Promise<SopEntry> {
    const { entry } = await this.read(sopId)
    if (!entry.sop?.steps.some((step) => step.id === stepId && step.by === 'agent')) {
      throw invalidParams(t('sop.noSuchStep'))
    }
    const pins = { ...(this.data.pins[sopId] ?? {}) }
    if (pick === null) delete pins[stepId]
    else pins[stepId] = { ...pick }
    if (Object.keys(pins).length === 0) delete this.data.pins[sopId]
    else this.data.pins[sopId] = pins
    this.save()
    this.deps.changed?.()
    return { ...entry, pins }
  }

  /** Adds a file from GitHub or the user's computer, unapproved. */
  async add(source: SopAddSource): Promise<SopEntry> {
    if (source.kind === 'url') {
      const raw = githubRawUrl(source.url)
      if (raw === null) throw invalidParams(t('sop.notGithub'))
      const text = await this.download(raw)
      return this.write(text, 'github', { kind: 'github', url: source.url })
    }
    return this.write(source.text, 'file', { kind: 'file', name: source.name })
  }

  /**
   * Reads a GitHub SOP again; a changed file replaces it and waits for approval again. Resolves
   * to whether it changed.
   */
  async update(sopId: string): Promise<{ entry: SopEntry; changed: boolean }> {
    const record = this.data.entries[sopId]
    if (record?.origin?.kind !== 'github') throw invalidParams(t('sop.notFromGithub'))
    const raw = githubRawUrl(record.origin.url)
    if (raw === null) throw invalidParams(t('sop.notGithub'))
    const text = await this.download(raw)
    const current = await this.readOne(sopId)
    if (current.text === text)
      return { entry: this.entryOf(current, record.source), changed: false }
    if (Buffer.byteLength(text, 'utf8') > SOP_FILE_BYTES) throw invalidParams(t('sop.tooLarge'))
    await writeFileAtomic(this.fileOf(sopId), text)
    this.deps.changed?.()
    return { entry: (await this.read(sopId)).entry, changed: true }
  }

  /**
   * An SOP an agent wrote, saved for the user to approve. One that does not read is refused with
   * its problems, so the agent can fix it.
   */
  async create(
    text: string,
    by: { sessionId: string; agentId: AgentId },
  ): Promise<SopEntry | { problems: SopProblem[] }> {
    const read = parseSop(text)
    if (!read.sop) return { problems: read.problems }
    const tools = toolProblems(read.sop, this.deps.knownTools())
    if (tools.length > 0) return { problems: tools }
    const clash = this.officialClash(read.sop.name)
    if (clash) return { problems: [clash] }
    return this.write(text, 'agent', { kind: 'agent', ...by })
  }

  private async write(text: string, source: LibrarySource, origin: SopOrigin): Promise<SopEntry> {
    if (Buffer.byteLength(text, 'utf8') > SOP_FILE_BYTES) throw invalidParams(t('sop.tooLarge'))
    const read = parseSop(text)
    const existing = await this.readLibrary()
    if (existing.length >= MAX_LIBRARY) throw new HostError('restricted', t('sop.libraryFull'))
    const taken = new Set([...this.official.map((r) => r.id), ...existing.map((r) => r.id)])
    const base = sopSlug(
      read.sop?.name ?? path.parse(origin.kind === 'file' ? origin.name : '').name,
    )
    let id = base
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`.slice(0, SOP_ID_CHARS)
    await mkdir(this.deps.dir, { recursive: true })
    await writeFileAtomic(this.fileOf(id), text)
    this.data.entries[id] = { source, origin, addedAt: this.now(), approved: null }
    this.save()
    this.deps.changed?.()
    return (await this.read(id)).entry
  }

  private async download(url: string): Promise<string> {
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
    let response: Response
    try {
      response = await this.fetch(url, { signal, headers: { accept: 'text/plain' } })
    } catch (error) {
      throw new HostError(
        'unavailable',
        t('sop.downloadFailed', { error: (error as Error).message }),
      )
    }
    if (!response.ok) {
      throw new HostError('not_found', t('sop.downloadStatus', { status: response.status }))
    }
    const length = Number(response.headers.get('content-length') ?? 0)
    if (length > SOP_FILE_BYTES) throw invalidParams(t('sop.tooLarge'))
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > SOP_FILE_BYTES) throw invalidParams(t('sop.tooLarge'))
    return text
  }

  // The files.

  private fileOf(id: string): string {
    return path.join(this.deps.dir, `${id}.yaml`)
  }

  private async readLibrary(): Promise<Read[]> {
    let names: string[]
    try {
      names = (await readdir(this.deps.dir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
        .map((entry) => entry.name)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return []
      throw error
    }
    const ids = [...new Set(names.map((name) => name.replace(/\.ya?ml$/i, '').toLowerCase()))]
      .filter((id) => ID.test(id) && id.length <= SOP_ID_CHARS)
      .sort()
      .slice(0, MAX_LIBRARY)
    return Promise.all(ids.map((id) => this.readOne(id)))
  }

  private async readOne(id: string): Promise<Read> {
    if (!ID.test(id)) return { id, text: null, problems: [], sop: null, hash: '' }
    for (const ext of ['yaml', 'yml']) {
      const file = path.join(this.deps.dir, `${id}.${ext}`)
      let text: string
      try {
        if ((await stat(file)).size > SOP_FILE_BYTES) {
          return {
            id,
            text: null,
            sop: null,
            hash: '',
            problems: [{ at: '', message: `the file is larger than ${SOP_FILE_BYTES / 1024} KB` }],
          }
        }
        text = await readFile(file, 'utf8')
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') continue
        return {
          id,
          text: null,
          sop: null,
          hash: '',
          problems: [{ at: '', message: `could not be read: ${(error as Error).message}` }],
        }
      }
      const read = parseSop(text)
      return { id, text, sop: read.sop, problems: read.problems, hash: sopHash(text) }
    }
    return { id, text: null, sop: null, hash: '', problems: [] }
  }

  private officialClash(name: string): SopProblem | null {
    const key = name.trim().toLowerCase()
    const official = this.official.find((read) => read.sop?.name.toLowerCase() === key)
    return official
      ? { at: 'name', message: `an official SOP is named "${official.sop!.name}"` }
      : null
  }

  private entryOf(read: Read, source: SopSource): SopEntry {
    const record = source === 'official' ? null : this.data.entries[read.id]
    const problems = [...read.problems]
    if (read.text === null && problems.length === 0 && source !== 'official') {
      problems.push({ at: '', message: 'the file is gone' })
    }
    if (read.sop) {
      problems.push(...toolProblems(read.sop, this.deps.knownTools()))
      if (source !== 'official') {
        const clash = this.officialClash(read.sop.name)
        if (clash) problems.push(clash)
      }
    }
    let approval: SopEntry['approval'] = 'official'
    if (source !== 'official') {
      approval =
        record?.approved == null
          ? 'pending'
          : record.approved === read.hash
            ? 'approved'
            : 'changed'
    }
    return {
      id: read.id,
      source,
      sop: read.sop,
      name: read.sop?.name ?? read.id,
      problems,
      approval,
      hash: read.hash,
      origin: record?.origin ?? null,
      file: source === 'official' ? null : this.fileOf(read.id),
      addedAt: record?.addedAt ?? null,
      pins: this.livePins(read.id, read.sop),
    }
  }

  /** The SOP's pins of steps it still has: a step a new version removed loses its pin. */
  private livePins(sopId: string, sop: Sop | null): Record<string, StepPick> {
    const pins = this.data.pins[sopId]
    if (!pins || !sop) return { ...(pins ?? {}) }
    const kept: Record<string, StepPick> = {}
    let dropped = false
    for (const [stepId, pick] of Object.entries(pins)) {
      if (sop.steps.some((step) => step.id === stepId && step.by === 'agent')) kept[stepId] = pick
      else dropped = true
    }
    if (dropped) {
      if (Object.keys(kept).length === 0) delete this.data.pins[sopId]
      else this.data.pins[sopId] = kept
      this.save()
    }
    return { ...kept }
  }

  private save(): void {
    this.deps.file.save(this.data)
  }
}
