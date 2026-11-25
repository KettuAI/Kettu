// The workflows a host can run: the user's library, one YAML file per workflow under
// `<userData>/workflows`. A library workflow is usable only while its file's hash is the one the
// user approved, so an agent cannot write itself an unchecked flow. The user's pins and the workflow
// switches in Settings live beside it in `state/workflows.json`, never in the workflow files.

import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { isAgentId } from '@shared/agents'
import { HANDLE, LISTING_ID, VERSION } from '@shared/market-publish'
import { PLUGIN_ID, PLUGIN_ITEM_NAME } from '@shared/plugins'
import {
  isStepPick,
  WORKFLOW_FILE_BYTES,
  WORKFLOW_ID_CHARS,
  usableWorkflow,
  type Workflow,
  type WorkflowAddSource,
  type WorkflowEntry,
  type WorkflowOrigin,
  type WorkflowProblem,
  type WorkflowSource,
  type StepPick,
} from '@shared/workflow'
import type { AgentId } from '@shared/thread'
import { HostError, invalidParams, notFound } from '../errors'
import { t } from '../i18n'
import { JsonFile, writeFileAtomic, type LogFn, type Migration } from '../storage'
import { fileProblem, parseWorkflow, problemText, workflowHash, toolProblems } from './format'

export const WORKFLOWS_VERSION = 1
// No older formats exist yet; each future version adds its step here, with a test.
export const WORKFLOWS_MIGRATIONS: Readonly<Record<number, Migration>> = {}
const FETCH_TIMEOUT_MS = 15_000
const MAX_LIBRARY = 200
const ID = /^[a-z0-9][a-z0-9-]*$/

export interface LibraryRecord {
  source: WorkflowSource
  origin: WorkflowOrigin | null
  addedAt: number
  /** The hash the user approved; null until they do. */
  approved: string | null
}

export interface WorkflowsFile {
  version: 1
  /** By workflow id; a file in the folder without a record is the user's own, unapproved. */
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

function originOf(value: unknown): WorkflowOrigin | null | undefined {
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
  if (
    value.kind === 'community' &&
    typeof value.listingId === 'string' &&
    LISTING_ID.test(value.listingId) &&
    typeof value.version === 'string' &&
    VERSION.test(value.version) &&
    typeof value.handle === 'string' &&
    HANDLE.test(value.handle) &&
    typeof value.slug === 'string' &&
    HANDLE.test(value.slug)
  ) {
    const { listingId, version, handle, slug } = value
    return {
      kind: 'community',
      listingId,
      version,
      handle,
      slug,
      official: value.official === true,
    }
  }
  if (
    value.kind === 'plugin' &&
    typeof value.pluginId === 'string' &&
    PLUGIN_ID.test(value.pluginId) &&
    typeof value.name === 'string' &&
    PLUGIN_ITEM_NAME.test(value.name) &&
    typeof value.plugin === 'string'
  ) {
    const { pluginId, name, plugin } = value
    return { kind: 'plugin', pluginId, name, plugin }
  }
  return undefined
}

const SOURCES: ReadonlySet<unknown> = new Set([
  'github',
  'file',
  'agent',
  'user',
  'community',
  'plugin',
])

/** Where a workflow a plugin brought came from. */
export type PluginOrigin = Extract<WorkflowOrigin, { kind: 'plugin' }>

/** Where a workflow from the Kettu Marketplace came from. */
export type CommunityOrigin = Extract<WorkflowOrigin, { kind: 'community' }>

/** Parses the file; an entry or pin that does not read is dropped alone. */
export function parseWorkflowsFile(data: Record<string, unknown>): WorkflowsFile | string {
  if (!isRecord(data.entries)) return 'entries is not an object'
  const entries: WorkflowsFile['entries'] = {}
  for (const [id, raw] of Object.entries(data.entries)) {
    if (!ID.test(id) || !isRecord(raw)) continue
    const origin = originOf(raw.origin)
    if (
      !SOURCES.has(raw.source) ||
      origin === undefined ||
      // Only a listing's install is the Kettu Marketplace's, and it always names its listing.
      (raw.source === 'community') !== (origin?.kind === 'community') ||
      (raw.source === 'plugin') !== (origin?.kind === 'plugin') ||
      typeof raw.addedAt !== 'number' ||
      !isNullableString(raw.approved)
    ) {
      continue
    }
    entries[id] = {
      source: raw.source as WorkflowSource,
      origin,
      addedAt: raw.addedAt,
      approved: raw.approved,
    }
  }
  const pins: WorkflowsFile['pins'] = {}
  if (isRecord(data.pins)) {
    for (const [workflowId, steps] of Object.entries(data.pins)) {
      if (!isRecord(steps)) continue
      const kept: Record<string, StepPick> = {}
      for (const [stepId, pick] of Object.entries(steps)) {
        if (isStepPick(pick)) kept[stepId] = { ...pick }
      }
      if (Object.keys(kept).length > 0) pins[workflowId] = kept
    }
  }
  const autoPick: WorkflowsFile['autoPick'] = {}
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

export function emptyWorkflowsFile(): WorkflowsFile {
  return { version: 1, entries: {}, pins: {}, suggest: true, autoPick: {} }
}

export function workflowsFile(userDataPath: string, log: LogFn): JsonFile<WorkflowsFile> {
  return new JsonFile<WorkflowsFile>({
    file: path.join(userDataPath, 'state', 'workflows.json'),
    version: WORKFLOWS_VERSION,
    migrations: WORKFLOWS_MIGRATIONS,
    parse: parseWorkflowsFile,
    empty: emptyWorkflowsFile,
    log,
  })
}

/** What the library needs of the file, so tests can hand it one in memory. */
export type WorkflowsStore = Pick<JsonFile<WorkflowsFile>, 'load' | 'save' | 'flush'>

export interface WorkflowLibraryDeps {
  /** `<userData>/workflows`. */
  dir: string
  file: WorkflowsStore
  /** The Marketplace's MCP servers and Skills by the names agents know them by. */
  knownTools(): { mcp: ReadonlySet<string>; skills: ReadonlySet<string> }
  log: LogFn
  fetch?: typeof fetch
  now?: () => number
  changed?(): void
  /** Whether a plugin is on; a workflow of one that is off is not listed and cannot start a task. */
  pluginOn?(pluginId: string): boolean
}

/** A workflow a task can lock: what it is and the hash of the file it came from. */
export interface ResolvedWorkflow {
  id: string
  source: WorkflowSource
  name: string
  workflow: Workflow
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

/** A file name stem for a workflow's name: lowercase ASCII words joined by dashes. */
export function workflowSlug(name: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug || 'workflow'
}

interface Read {
  id: string
  text: string | null
  problems: WorkflowProblem[]
  workflow: Workflow | null
  hash: string
}

export class WorkflowLibrary {
  private data: WorkflowsFile = emptyWorkflowsFile()
  private readonly fetch: typeof fetch
  private readonly now: () => number

  constructor(private readonly deps: WorkflowLibraryDeps) {
    this.fetch = deps.fetch ?? fetch
    this.now = deps.now ?? Date.now
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

  /** The library but the workflows of plugins that are off, which come back when they are on. */
  async list(): Promise<WorkflowEntry[]> {
    const library = await this.readLibrary()
    return library
      .filter((read) => !this.pluginOff(read.id))
      .map((read) => this.entryOf(read, this.data.entries[read.id]?.source ?? 'user'))
  }

  async read(workflowId: string): Promise<{ entry: WorkflowEntry; text: string | null }> {
    const read = await this.readOne(workflowId)
    const source = this.data.entries[workflowId]?.source ?? 'user'
    return { entry: this.entryOf(read, source), text: read.text }
  }

  /** The workflow a new task locks; refused when it does not read, has problems or is not approved. */
  async resolve(workflowId: string): Promise<ResolvedWorkflow> {
    const { entry } = await this.read(workflowId)
    if (!entry.workflow || entry.problems.length > 0) {
      const problem = entry.problems[0]
      throw invalidParams(
        t('workflow.unusable', {
          name: entry.name,
          problem: problem ? `${problem.at} ${problemText(problem)}`.trim() : '',
        }),
      )
    }
    if (!usableWorkflow(entry))
      throw new HostError('restricted', t('workflow.notApproved', { name: entry.name }))
    return {
      id: entry.id,
      source: entry.source,
      name: entry.name,
      workflow: entry.workflow,
      hash: entry.hash,
    }
  }

  pins(workflowId: string): Record<string, StepPick> {
    return { ...(this.data.pins[workflowId] ?? {}) }
  }

  // Changes.

  async approve(workflowId: string, hash: string): Promise<WorkflowEntry> {
    const read = await this.readOne(workflowId)
    if (read.text === null) throw notFound(t('workflow.notFound'))
    // The user approves what they saw: a file changed since then must be looked at again.
    if (read.hash !== hash) throw new HostError('conflict', t('workflow.changedSinceShown'))
    if (!read.workflow) throw invalidParams(t('workflow.invalid'))
    const record = this.data.entries[workflowId] ?? {
      source: 'user' as const,
      origin: null,
      addedAt: this.now(),
      approved: null,
    }
    record.approved = hash
    this.data.entries[workflowId] = record
    this.save()
    this.deps.changed?.()
    return this.entryOf(read, record.source)
  }

  async remove(workflowId: string): Promise<void> {
    if (!ID.test(workflowId)) throw notFound(t('workflow.notFound'))
    const origin = this.data.entries[workflowId]?.origin
    if (origin?.kind === 'plugin') {
      throw new HostError('restricted', t('plugins.fromPlugin', { plugin: origin.plugin }))
    }
    await rm(this.fileOf(workflowId), { force: true })
    delete this.data.entries[workflowId]
    delete this.data.pins[workflowId]
    this.save()
    this.deps.changed?.()
  }

  async setPin(workflowId: string, stepId: string, pick: StepPick | null): Promise<WorkflowEntry> {
    const { entry } = await this.read(workflowId)
    if (!entry.workflow?.steps.some((step) => step.id === stepId && step.by === 'agent')) {
      throw invalidParams(t('workflow.noSuchStep'))
    }
    const pins = { ...(this.data.pins[workflowId] ?? {}) }
    if (pick === null) delete pins[stepId]
    else pins[stepId] = { ...pick }
    if (Object.keys(pins).length === 0) delete this.data.pins[workflowId]
    else this.data.pins[workflowId] = pins
    this.save()
    this.deps.changed?.()
    return { ...entry, pins }
  }

  /** Adds a file from GitHub or the user's computer, unapproved. */
  async add(source: WorkflowAddSource): Promise<WorkflowEntry> {
    if (source.kind === 'url') {
      const raw = githubRawUrl(source.url)
      if (raw === null) throw invalidParams(t('workflow.notGithub'))
      const text = await this.download(raw)
      return this.write(text, 'github', { kind: 'github', url: source.url })
    }
    return this.write(source.text, 'file', { kind: 'file', name: source.name })
  }

  /** The Kettu Marketplace's listings the library has a workflow of. */
  listingIds(): string[] {
    return Object.values(this.data.entries).flatMap((record) =>
      record.origin?.kind === 'community' ? [record.origin.listingId] : [],
    )
  }

  /**
   * Writes a listing's workflow, unapproved: in place of the version of it the library has, which
   * stays approved only if the text is the same, or as a new workflow. One that does not read is
   * refused with why and nothing is written.
   */
  async installListing(
    text: string,
    origin: CommunityOrigin,
  ): Promise<{ entry: WorkflowEntry; updated: boolean }> {
    if (Buffer.byteLength(text, 'utf8') > WORKFLOW_FILE_BYTES)
      throw invalidParams(t('workflow.tooLarge'))
    const read = parseWorkflow(text)
    if (!read.workflow) {
      const problem = read.problems[0]
      throw invalidParams(
        t('workflow.listingProblem', {
          problem: problem ? `${problem.at} ${problemText(problem)}`.trim() : '',
        }),
      )
    }
    const id = Object.entries(this.data.entries).find(
      ([, record]) =>
        record.origin?.kind === 'community' && record.origin.listingId === origin.listingId,
    )?.[0]
    if (id === undefined)
      return { entry: await this.write(text, 'community', origin), updated: false }
    await mkdir(this.deps.dir, { recursive: true })
    await writeFileAtomic(this.fileOf(id), text)
    this.data.entries[id]!.origin = { ...origin }
    this.save()
    this.deps.changed?.()
    return { entry: (await this.read(id)).entry, updated: true }
  }

  /**
   * Writes a plugin's workflow: in place of the one it has by that name, which stays approved only
   * if the text is the same, or as a new workflow, unapproved. Resolves to its id.
   */
  async installPlugin(text: string, origin: PluginOrigin): Promise<string> {
    if (Buffer.byteLength(text, 'utf8') > WORKFLOW_FILE_BYTES)
      throw invalidParams(t('workflow.tooLarge'))
    const id = Object.entries(this.data.entries).find(
      ([, record]) =>
        record.origin?.kind === 'plugin' &&
        record.origin.pluginId === origin.pluginId &&
        record.origin.name === origin.name,
    )?.[0]
    if (id === undefined) return (await this.write(text, 'plugin', origin)).id
    await mkdir(this.deps.dir, { recursive: true })
    await writeFileAtomic(this.fileOf(id), text)
    this.data.entries[id]!.origin = { ...origin }
    this.save()
    this.deps.changed?.()
    return id
  }

  /** Removes a plugin's workflows, but for those it names in `keep`. */
  async removePlugin(pluginId: string, keep: readonly string[] = []): Promise<void> {
    let removed = false
    for (const [id, record] of Object.entries(this.data.entries)) {
      const { origin } = record
      if (origin?.kind !== 'plugin' || origin.pluginId !== pluginId) continue
      if (keep.includes(origin.name)) continue
      await rm(this.fileOf(id), { force: true })
      delete this.data.entries[id]
      delete this.data.pins[id]
      removed = true
    }
    if (!removed) return
    this.save()
    this.deps.changed?.()
  }

  /** A plugin was turned on or off, which changes whether its workflows can be used. */
  pluginChanged(): void {
    this.deps.changed?.()
  }

  /**
   * Reads a GitHub workflow again; a changed file replaces it and waits for approval again. Resolves
   * to whether it changed.
   */
  async update(workflowId: string): Promise<{ entry: WorkflowEntry; changed: boolean }> {
    const record = this.data.entries[workflowId]
    if (record?.origin?.kind !== 'github') throw invalidParams(t('workflow.notFromGithub'))
    const raw = githubRawUrl(record.origin.url)
    if (raw === null) throw invalidParams(t('workflow.notGithub'))
    const text = await this.download(raw)
    const current = await this.readOne(workflowId)
    if (current.text === text)
      return { entry: this.entryOf(current, record.source), changed: false }
    if (Buffer.byteLength(text, 'utf8') > WORKFLOW_FILE_BYTES)
      throw invalidParams(t('workflow.tooLarge'))
    await writeFileAtomic(this.fileOf(workflowId), text)
    this.deps.changed?.()
    return { entry: (await this.read(workflowId)).entry, changed: true }
  }

  /**
   * A workflow an agent wrote, saved for the user to approve. One that does not read is refused with
   * its problems, so the agent can fix it.
   */
  async create(
    text: string,
    by: { sessionId: string; agentId: AgentId },
  ): Promise<WorkflowEntry | { problems: WorkflowProblem[] }> {
    const read = parseWorkflow(text)
    if (!read.workflow) return { problems: read.problems }
    const tools = toolProblems(read.workflow, this.deps.knownTools())
    if (tools.length > 0) return { problems: tools }
    return this.write(text, 'agent', { kind: 'agent', ...by })
  }

  private async write(
    text: string,
    source: WorkflowSource,
    origin: WorkflowOrigin,
  ): Promise<WorkflowEntry> {
    if (Buffer.byteLength(text, 'utf8') > WORKFLOW_FILE_BYTES)
      throw invalidParams(t('workflow.tooLarge'))
    const read = parseWorkflow(text)
    const existing = await this.readLibrary()
    if (existing.length >= MAX_LIBRARY) throw new HostError('restricted', t('workflow.libraryFull'))
    const taken = new Set(existing.map((r) => r.id))
    const base = workflowSlug(
      read.workflow?.name ?? path.parse(origin.kind === 'file' ? origin.name : '').name,
    )
    let id = base
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`.slice(0, WORKFLOW_ID_CHARS)
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
        t('workflow.downloadFailed', { error: (error as Error).message }),
      )
    }
    if (!response.ok) {
      throw new HostError('not_found', t('workflow.downloadStatus', { status: response.status }))
    }
    const length = Number(response.headers.get('content-length') ?? 0)
    if (length > WORKFLOW_FILE_BYTES) throw invalidParams(t('workflow.tooLarge'))
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > WORKFLOW_FILE_BYTES)
      throw invalidParams(t('workflow.tooLarge'))
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
      .filter((id) => ID.test(id) && id.length <= WORKFLOW_ID_CHARS)
      .sort()
      .slice(0, MAX_LIBRARY)
    return Promise.all(ids.map((id) => this.readOne(id)))
  }

  private async readOne(id: string): Promise<Read> {
    if (!ID.test(id)) return { id, text: null, problems: [], workflow: null, hash: '' }
    for (const ext of ['yaml', 'yml']) {
      const file = path.join(this.deps.dir, `${id}.${ext}`)
      let text: string
      try {
        if ((await stat(file)).size > WORKFLOW_FILE_BYTES) {
          return {
            id,
            text: null,
            workflow: null,
            hash: '',
            problems: [
              fileProblem('', 'workflowFile.fileTooLarge', { kb: WORKFLOW_FILE_BYTES / 1024 }),
            ],
          }
        }
        text = await readFile(file, 'utf8')
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') continue
        return {
          id,
          text: null,
          workflow: null,
          hash: '',
          problems: [
            fileProblem('', 'workflowFile.unreadable', { reason: (error as Error).message }),
          ],
        }
      }
      const read = parseWorkflow(text)
      return {
        id,
        text,
        workflow: read.workflow,
        problems: read.problems,
        hash: workflowHash(text),
      }
    }
    return { id, text: null, workflow: null, hash: '', problems: [] }
  }

  private entryOf(read: Read, source: WorkflowSource): WorkflowEntry {
    const record = this.data.entries[read.id]
    const problems = [...read.problems]
    if (read.text === null && problems.length === 0) {
      problems.push(fileProblem('', 'workflowFile.fileGone'))
    }
    if (read.workflow) problems.push(...toolProblems(read.workflow, this.deps.knownTools()))
    const from = record?.origin
    if (from?.kind === 'plugin' && this.pluginOff(read.id)) {
      problems.push(fileProblem('', 'workflowFile.pluginOff', { plugin: from.plugin }))
    }
    const approval: WorkflowEntry['approval'] =
      record?.approved == null ? 'pending' : record.approved === read.hash ? 'approved' : 'changed'
    return {
      id: read.id,
      source,
      workflow: read.workflow,
      name: read.workflow?.name ?? read.id,
      problems: problems.map((problem) => ({ at: problem.at, message: problemText(problem) })),
      approval,
      hash: read.hash,
      origin: record?.origin ?? null,
      file: this.fileOf(read.id),
      addedAt: record?.addedAt ?? null,
      pins: this.livePins(read.id, read.workflow),
    }
  }

  private pluginOff(workflowId: string): boolean {
    const from = this.data.entries[workflowId]?.origin
    return from?.kind === 'plugin' && this.deps.pluginOn?.(from.pluginId) === false
  }

  /** The workflow's pins of steps it still has: a step a new version removed loses its pin. */
  private livePins(workflowId: string, workflow: Workflow | null): Record<string, StepPick> {
    const pins = this.data.pins[workflowId]
    if (!pins || !workflow) return { ...(pins ?? {}) }
    const kept: Record<string, StepPick> = {}
    let dropped = false
    for (const [stepId, pick] of Object.entries(pins)) {
      if (workflow.steps.some((step) => step.id === stepId && step.by === 'agent'))
        kept[stepId] = pick
      else dropped = true
    }
    if (dropped) {
      if (Object.keys(kept).length === 0) delete this.data.pins[workflowId]
      else this.data.pins[workflowId] = kept
      this.save()
    }
    return { ...kept }
  }

  private save(): void {
    this.deps.file.save(this.data)
  }
}
