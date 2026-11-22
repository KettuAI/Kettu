// The cards the workflow tools leave in a session, kept on the host so every window and device shows
// the same answer: a suggestion to run a requirement through a workflow, and a workflow an agent
// wrote for the user to keep. Start is one action: the Marketplace's version goes into the library,
// the tools it names are installed, the version the card drew is approved and the task starts. A
// failed item stops it there, and Retry goes on from that item. Drafts, the workflows an agent
// writes for one requirement, live here too, outside the library.

import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { isAgentId } from '@shared/agents'
import { HANDLE, LISTING_ID, VERSION } from '@shared/market-publish'
import { listingIdOf } from '@shared/market-community'
import type { MarketServer, MarketSkill } from '@shared/marketplace'
import {
  isPace,
  keptTool,
  stepName,
  usableWorkflow,
  type Pace,
  type StartItem,
  type StartProgress,
  type SuggestedSource,
  type SuggestedTool,
  type SuggestionAnswer,
  type SuggestionFacts,
  type TaskStart,
  type TaskView,
  type Workflow,
  type WorkflowEntry,
  type WorkflowProblem,
  type WorkflowSuggestion,
} from '@shared/workflow'
import type { AgentId } from '@shared/thread'
import { HostError, invalidParams, notFound } from '../errors'
import { t } from '../i18n'
import type { WorkflowCatalog } from '../marketplace/community'
import { JsonFile, writeFileAtomic, type LogFn, type Migration } from '../storage'
import { parseWorkflow, problemText, toolProblems, workflowHash } from './format'
import type { ResolvedWorkflow, WorkflowLibrary } from './library'

export const SUGGESTIONS_VERSION = 1
// No older formats exist yet; each future version adds its step here, with a test.
export const SUGGESTIONS_MIGRATIONS: Readonly<Record<number, Migration>> = {}
/** Cards and drafts kept, the newest; older ones go, and their texts at the next start. */
const KEPT = 200
const DRAFT_PREFIX = 'draft:'
const DRAFT_ID = /^draft:[a-z2-7]{12}$/
const CARD_ID = /^wfs-[a-z2-7]{12}$/
const HASH = /^[0-9a-f]{64}$/

type Device = { id: string; name: string }
type First = { agentId?: AgentId; options?: Record<string, string | boolean> }

export interface DraftRecord {
  sessionId: string
  agentId: AgentId
  hash: string
  createdAt: number
}

export interface SuggestionRecord {
  sessionId: string
  purpose: 'start' | 'save'
  source: SuggestedSource
  hash: string
  task: string
  title: string | null
  pace: Pace
  paceReason: string | null
  agentId: AgentId
  tools: SuggestedTool[]
  facts: SuggestionFacts
  answer: SuggestionAnswer
  /** The library workflow a Marketplace one became when Start added it. */
  added: string | null
  /**
   * When a turn started in its session after it was made: the conversation moved on, so it no
   * longer counts as waiting on the session, though it can still be answered.
   */
  passedAt?: number
  device?: Device
  createdAt: number
}

export interface SuggestionsFile {
  version: 1
  drafts: Record<string, DraftRecord>
  suggestions: Record<string, SuggestionRecord>
}

// Reading the file: a record that does not read is dropped alone.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isText = (value: unknown): value is string => typeof value === 'string'
const isNullableText = (value: unknown): value is string | null =>
  value === null || typeof value === 'string'

function sourceOf(value: unknown): SuggestedSource | null {
  if (!isRecord(value)) return null
  if (value.kind === 'library' && isText(value.workflowId)) {
    return { kind: 'library', workflowId: value.workflowId }
  }
  if (value.kind === 'draft' && isText(value.draftId) && DRAFT_ID.test(value.draftId)) {
    return { kind: 'draft', draftId: value.draftId }
  }
  if (
    value.kind === 'marketplace' &&
    isText(value.listingId) &&
    LISTING_ID.test(value.listingId) &&
    isText(value.version) &&
    VERSION.test(value.version) &&
    isText(value.handle) &&
    HANDLE.test(value.handle) &&
    isText(value.slug) &&
    (value.installs === null || typeof value.installs === 'number')
  ) {
    return {
      kind: 'marketplace',
      listingId: value.listingId,
      version: value.version,
      handle: value.handle,
      slug: value.slug,
      official: value.official === true,
      installs: value.installs,
    }
  }
  return null
}

function toolOf(value: unknown): SuggestedTool | null {
  if (!isRecord(value)) return null
  const { kind, ref, title, description, server, skill, setup } = value
  if ((kind !== 'mcp' && kind !== 'skill') || !isText(ref) || !isText(title)) return null
  if (!isNullableText(description)) return null
  if (setup !== 'none' && setup !== 'sign-in' && setup !== 'keys') return null
  const serverOk =
    server === null ||
    (isRecord(server) && isText(server.id) && isText(server.title) && isRecord(server.spec))
  const skillOk =
    skill === null ||
    (isRecord(skill) && (skill.kind === 'catalog' || skill.kind === 'kettu') && isText(skill.id))
  if (!serverOk || !skillOk) return null
  return value as unknown as SuggestedTool
}

function itemOf(value: unknown): StartItem | null {
  if (!isRecord(value)) return null
  switch (value.kind) {
    case 'connected':
      return isText(value.ref) && isText(value.title)
        ? { kind: 'connected', ref: value.ref, title: value.title }
        : null
    case 'add':
      return isText(value.name) && isText(value.version)
        ? { kind: 'add', name: value.name, version: value.version }
        : null
    case 'install':
      return isText(value.ref) &&
        isText(value.title) &&
        (value.tool === 'mcp' || value.tool === 'skill')
        ? { kind: 'install', ref: value.ref, tool: value.tool, title: value.title }
        : null
    case 'start':
      return isText(value.step) ? { kind: 'start', step: value.step } : null
    default:
      return null
  }
}

const ITEM_STATES: ReadonlySet<unknown> = new Set(['waiting', 'running', 'done', 'failed'])

function progressOf(value: unknown): StartProgress[] | null {
  if (!Array.isArray(value)) return null
  const items: StartProgress[] = []
  for (const raw of value) {
    const item = isRecord(raw) ? itemOf(raw.item) : null
    if (!item || !ITEM_STATES.has(raw.state) || !isNullableText(raw.error)) return null
    // An item that was running when the host stopped did not finish.
    const stopped = raw.state === 'running'
    items.push({
      item,
      state: stopped ? 'failed' : (raw.state as StartProgress['state']),
      error: stopped ? null : raw.error,
    })
  }
  return items
}

function answerOf(value: unknown): SuggestionAnswer | null {
  if (!isRecord(value)) return null
  switch (value.kind) {
    case 'waiting':
    case 'declined':
    case 'not_saved':
      return { kind: value.kind }
    case 'saved':
      return isText(value.workflowId) ? { kind: 'saved', workflowId: value.workflowId } : null
    case 'starting':
    case 'failed': {
      const items = progressOf(value.items)
      // Start was under way when the host stopped: Retry goes on from where it stopped.
      return items ? { kind: 'failed', items } : null
    }
    case 'started': {
      const items = progressOf(value.items)
      return items && isText(value.taskId) ? { kind: 'started', taskId: value.taskId, items } : null
    }
    default:
      return null
  }
}

function suggestionOf(raw: unknown): SuggestionRecord | null {
  if (!isRecord(raw)) return null
  const source = sourceOf(raw.source)
  const answer = answerOf(raw.answer)
  const facts = raw.facts
  if (
    !source ||
    !answer ||
    !isText(raw.sessionId) ||
    (raw.purpose !== 'start' && raw.purpose !== 'save') ||
    !isText(raw.hash) ||
    !HASH.test(raw.hash) ||
    !isText(raw.task) ||
    !isNullableText(raw.title) ||
    !isPace(raw.pace) ||
    !isNullableText(raw.paceReason) ||
    !isAgentId(raw.agentId) ||
    !Array.isArray(raw.tools) ||
    !isRecord(facts) ||
    !(facts.pastMs === null || typeof facts.pastMs === 'number') ||
    typeof facts.runs !== 'number' ||
    !(facts.worktree === null || typeof facts.worktree === 'boolean') ||
    !isNullableText(raw.added) ||
    typeof raw.createdAt !== 'number'
  ) {
    return null
  }
  const tools = raw.tools.map(toolOf)
  if (tools.some((tool) => tool === null)) return null
  const device =
    isRecord(raw.device) && isText(raw.device.id) && isText(raw.device.name)
      ? { device: { id: raw.device.id, name: raw.device.name } }
      : {}
  return {
    sessionId: raw.sessionId,
    purpose: raw.purpose,
    source,
    hash: raw.hash,
    task: raw.task,
    title: raw.title,
    pace: raw.pace,
    paceReason: raw.paceReason,
    agentId: raw.agentId,
    tools: tools as SuggestedTool[],
    facts: { pastMs: facts.pastMs, runs: facts.runs, worktree: facts.worktree },
    answer,
    added: raw.added,
    ...(typeof raw.passedAt === 'number' && Number.isFinite(raw.passedAt)
      ? { passedAt: raw.passedAt }
      : {}),
    ...device,
    createdAt: raw.createdAt,
  }
}

export function parseSuggestionsFile(data: Record<string, unknown>): SuggestionsFile | string {
  if (!isRecord(data.suggestions)) return 'suggestions is not an object'
  const drafts: SuggestionsFile['drafts'] = {}
  if (isRecord(data.drafts)) {
    for (const [id, raw] of Object.entries(data.drafts)) {
      if (
        !DRAFT_ID.test(id) ||
        !isRecord(raw) ||
        !isText(raw.sessionId) ||
        !isAgentId(raw.agentId) ||
        !isText(raw.hash) ||
        !HASH.test(raw.hash) ||
        typeof raw.createdAt !== 'number'
      ) {
        continue
      }
      drafts[id] = {
        sessionId: raw.sessionId,
        agentId: raw.agentId,
        hash: raw.hash,
        createdAt: raw.createdAt,
      }
    }
  }
  const suggestions: SuggestionsFile['suggestions'] = {}
  for (const [id, raw] of Object.entries(data.suggestions)) {
    const record = CARD_ID.test(id) ? suggestionOf(raw) : null
    if (record) suggestions[id] = record
  }
  return { version: 1, drafts, suggestions }
}

export function emptySuggestionsFile(): SuggestionsFile {
  return { version: 1, drafts: {}, suggestions: {} }
}

export function suggestionsFile(userDataPath: string, log: LogFn): JsonFile<SuggestionsFile> {
  return new JsonFile<SuggestionsFile>({
    file: path.join(userDataPath, 'state', 'workflow-suggestions.json'),
    version: SUGGESTIONS_VERSION,
    migrations: SUGGESTIONS_MIGRATIONS,
    parse: parseSuggestionsFile,
    empty: emptySuggestionsFile,
    log,
  })
}

// The service.

export type SuggestionsStore = Pick<JsonFile<SuggestionsFile>, 'load' | 'save' | 'flush'>

export interface SuggestionsDeps {
  file: SuggestionsStore
  /** Where the texts the cards drew are kept, one file per hash. */
  dir: string
  library: Pick<WorkflowLibrary, 'list' | 'read' | 'approve' | 'create'>
  market: {
    /** The public workflow catalog, as list_workflows reads it. */
    workflows(): Promise<WorkflowCatalog>
    /** One version's `workflow.yaml`, checked against what the version lists. */
    text(listingId: string, version: string): Promise<string | null>
    /** Adds that version to the library, unapproved, and counts the install. */
    add(
      listing: { id: string; version: string; handle: string; slug: string; official: boolean },
      text: string,
    ): Promise<WorkflowEntry>
  }
  tools: {
    kept(): { mcp: readonly MarketServer[]; skills: readonly MarketSkill[] }
    /** Whether a server Kettu keeps is signed in. */
    connected(serverId: string): boolean
    /** The Marketplace entry a workflow names a tool by; null when there is none Kettu installs. */
    resolve(kind: 'mcp' | 'skill', ref: string): Promise<SuggestedTool | null>
    /** Installs one, or turns on the one Kettu keeps but has off. */
    install(tool: SuggestedTool): Promise<void>
  }
  tasks: {
    start(
      params: TaskStart,
      from: { sessionId: string },
      given?: ResolvedWorkflow,
    ): Promise<TaskView>
    pastRuns(workflowId: string): { runs: number; medianMs: number | null }
    /** The drafts tasks ran on, which are kept with their texts as long as those tasks. */
    draftIds?(): ReadonlySet<string>
  }
  sessions: {
    agentOf(sessionId: string): AgentId | null
    projectOf(sessionId: string): string | null
    /** Tells the session's agent what the user answered on a card, which is no message of theirs. */
    tell(sessionId: string, text: string): Promise<void>
  }
  isRepo(projectPath: string): Promise<boolean>
  changed(view: WorkflowSuggestion): void
  log: LogFn
  now?: () => number
  random?: () => string
}

export interface SuggestInput {
  workflowId: string
  task: string
  title: string | null
  pace: Pace
  paceReason: string | null
}

/** A refusal the tools hand back to the agent as it is, with what to do instead. */
export class SuggestionRefused extends Error {
  constructor(
    readonly code: 'not_found' | 'declined' | 'invalid',
    message: string,
  ) {
    super(message)
    this.name = 'SuggestionRefused'
  }
}

/** Twelve characters of base32, for a draft's or a card's id. */
function randomId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  return [...randomBytes(12)].map((byte) => alphabet[byte % 32]).join('')
}

/** What makes two suggestions the same workflow, for a decline to hold. */
function sourceKey(source: SuggestedSource): string {
  switch (source.kind) {
    case 'library':
      return `library:${source.workflowId}`
    case 'marketplace':
      return `kettu:${source.listingId}`
    case 'draft':
      return source.draftId
  }
}

function waitingStart(record: SuggestionRecord, sessionId: string): boolean {
  return (
    record.sessionId === sessionId &&
    record.purpose === 'start' &&
    record.answer.kind === 'waiting' &&
    record.passedAt === undefined
  )
}

function problemLines(
  problems: WorkflowProblem[],
  say: (p: WorkflowProblem) => string = (p) => p.message,
): string {
  return problems.map((p) => `- ${p.at ? `${p.at}: ` : ''}${say(p)}`).join('\n')
}

export class WorkflowSuggestions {
  private data: SuggestionsFile = emptySuggestionsFile()
  /** Cards whose Start or Save is under way. */
  private readonly running = new Set<string>()
  private readonly now: () => number
  private readonly random: () => string

  constructor(private readonly deps: SuggestionsDeps) {
    this.now = deps.now ?? Date.now
    this.random = deps.random ?? randomId
  }

  /** Reads the cards; `sweep` follows once the tasks that may name their drafts are loaded. */
  async load(): Promise<void> {
    this.data = await this.deps.file.load()
  }

  flush(): Promise<void> {
    return this.deps.file.flush()
  }

  // Writing.

  /**
   * Keeps a workflow the session's agent wrote for this requirement, outside the library, for
   * `suggest` to show; refused with its problems when it does not read or names a tool neither
   * kept here nor in the Marketplace.
   */
  async draft(
    sessionId: string,
    text: string,
  ): Promise<{ draftId: string; name: string; hash: string } | { problems: WorkflowProblem[] }> {
    const agentId = this.deps.sessions.agentOf(sessionId)
    if (!agentId) throw notFound(t('workflow.cardNotFound'))
    const checked = await this.check(text)
    if ('problems' in checked) return checked
    const draftId = await this.keepDraft(sessionId, agentId, checked.hash, text)
    this.trim()
    this.persist()
    return { draftId, name: checked.workflow.name, hash: checked.hash }
  }

  /** A workflow the agent wrote for the user to keep: the card that saves it on the user's word. */
  async keep(
    sessionId: string,
    text: string,
  ): Promise<WorkflowSuggestion | { problems: WorkflowProblem[] }> {
    const agentId = this.deps.sessions.agentOf(sessionId)
    if (!agentId) throw notFound(t('workflow.cardNotFound'))
    const checked = await this.check(text)
    if ('problems' in checked) return checked
    const draftId = await this.keepDraft(sessionId, agentId, checked.hash, text)
    return this.add({
      sessionId,
      purpose: 'save',
      source: { kind: 'draft', draftId },
      hash: checked.hash,
      task: '',
      title: null,
      pace: 'balanced',
      paceReason: null,
      agentId,
      tools: checked.tools,
      facts: { pastMs: null, runs: 0, worktree: null },
      answer: { kind: 'waiting' },
      added: null,
      createdAt: this.now(),
    })
  }

  private async keepDraft(
    sessionId: string,
    agentId: AgentId,
    hash: string,
    text: string,
  ): Promise<string> {
    await this.keepText(hash, text)
    const draftId = `${DRAFT_PREFIX}${this.random()}`
    this.data.drafts[draftId] = { sessionId, agentId, hash, createdAt: this.now() }
    return draftId
  }

  // Suggesting.

  /**
   * The card for running a requirement through a library workflow, a public Marketplace one or a
   * draft of this session. Refused when the user chose to do it here instead in this session.
   */
  async suggest(sessionId: string, input: SuggestInput): Promise<WorkflowSuggestion> {
    const agentId = this.deps.sessions.agentOf(sessionId)
    if (!agentId) throw notFound(t('workflow.cardNotFound'))
    const { source, text, name, libraryId } = await this.sourceFor(sessionId, input.workflowId)
    const key = sourceKey(source)
    const declined = Object.values(this.data.suggestions).some(
      (s) =>
        s.sessionId === sessionId && s.answer.kind === 'declined' && sourceKey(s.source) === key,
    )
    if (declined) {
      throw new SuggestionRefused(
        'declined',
        `The user chose to do this here instead of running it through "${name}" in this ` +
          'session. Do not suggest it again here unless they ask; go on as they said.',
      )
    }
    const checked = await this.check(text)
    if ('problems' in checked) {
      throw new SuggestionRefused(
        'invalid',
        `"${name}" cannot be used:\n${problemLines(checked.problems)}`,
      )
    }
    const project = this.deps.sessions.projectOf(sessionId)
    const past = libraryId ? this.deps.tasks.pastRuns(libraryId) : { runs: 0, medianMs: null }
    const worktree = project ? await this.deps.isRepo(project).catch(() => false) : false
    await this.keepText(checked.hash, text)
    return this.add({
      sessionId,
      purpose: 'start',
      source,
      hash: checked.hash,
      task: input.task,
      title: input.title,
      pace: input.pace,
      paceReason: input.paceReason,
      agentId,
      tools: checked.tools,
      facts: { pastMs: past.medianMs, runs: past.runs, worktree },
      answer: { kind: 'waiting' },
      added: null,
      createdAt: this.now(),
    })
  }

  private async sourceFor(
    sessionId: string,
    workflowId: string,
  ): Promise<{ source: SuggestedSource; text: string; name: string; libraryId: string | null }> {
    if (workflowId.startsWith(DRAFT_PREFIX)) {
      const draft = this.data.drafts[workflowId]
      if (!draft || draft.sessionId !== sessionId) {
        throw new SuggestionRefused(
          'not_found',
          `No workflow ${workflowId} was written in this session; write it with create_workflow.`,
        )
      }
      const text = await this.text(draft.hash)
      if (text === null) throw new SuggestionRefused('not_found', `${workflowId} is gone.`)
      const name = parseWorkflow(text).workflow?.name ?? workflowId
      return { source: { kind: 'draft', draftId: workflowId }, text, name, libraryId: null }
    }
    const library = await this.deps.library.list()
    const own = library.find((entry) => entry.id === workflowId)
    if (own) {
      const read = await this.deps.library.read(own.id)
      if (read.text === null || !own.workflow) {
        throw new SuggestionRefused('invalid', `"${own.name}" cannot be read.`)
      }
      return {
        source: { kind: 'library', workflowId: own.id },
        text: read.text,
        name: own.name,
        libraryId: own.id,
      }
    }
    const listingId = listingIdOf(workflowId) ?? (LISTING_ID.test(workflowId) ? workflowId : null)
    const catalog: WorkflowCatalog = listingId
      ? await this.deps.market.workflows()
      : { status: 'available', items: [] }
    const item = catalog.items.find((each) => each.id === listingId)
    if (!listingId || !item || !item.version) {
      const why =
        catalog.status === 'signed_out'
          ? ' This host is not signed in to the Kettu Marketplace.'
          : catalog.status === 'unavailable'
            ? ' The Kettu Marketplace is unavailable.'
            : ''
      throw new SuggestionRefused(
        'not_found',
        `No workflow ${workflowId} can be suggested; use an id list_workflows gave.${why}`,
      )
    }
    const text = await this.deps.market.text(item.id, item.version)
    if (text === null) {
      throw new SuggestionRefused('invalid', `"${item.name}" has no workflow file to read.`)
    }
    const installed = library.find(
      (entry) => entry.origin?.kind === 'community' && entry.origin.listingId === item.id,
    )
    // The library has this very version: it is the user's to start, with nothing to add.
    if (installed && installed.hash === workflowHash(text)) {
      return {
        source: { kind: 'library', workflowId: installed.id },
        text,
        name: installed.name,
        libraryId: installed.id,
      }
    }
    return {
      source: {
        kind: 'marketplace',
        listingId: item.id,
        version: item.version,
        handle: item.handle,
        slug: item.slug,
        official: item.official,
        installs: item.installs,
      },
      text,
      name: item.name,
      libraryId: installed?.id ?? null,
    }
  }

  /** Reads the workflow and finds each tool it names, kept here or in the Marketplace. */
  private async check(
    text: string,
  ): Promise<
    { workflow: Workflow; hash: string; tools: SuggestedTool[] } | { problems: WorkflowProblem[] }
  > {
    const read = parseWorkflow(text)
    if (!read.workflow) return { problems: read.problems }
    const kept = this.deps.tools.kept()
    const known = {
      mcp: new Set(kept.mcp.flatMap((s) => [s.name, s.id])),
      skills: new Set(kept.skills.flatMap((s) => [s.name, s.id])),
    }
    const shape = toolProblems(read.workflow, known)
    if (shape.length > 0) return { problems: shape }
    const named: { kind: 'mcp' | 'skill'; ref: string }[] = []
    for (const step of read.workflow.steps) {
      for (const ref of step.tools.skills) {
        if (!named.some((n) => n.kind === 'skill' && n.ref === ref)) {
          named.push({ kind: 'skill', ref })
        }
      }
      for (const ref of step.tools.mcp) {
        if (!named.some((n) => n.kind === 'mcp' && n.ref === ref)) named.push({ kind: 'mcp', ref })
      }
    }
    const tools: SuggestedTool[] = []
    const problems: WorkflowProblem[] = []
    for (const { kind, ref } of named) {
      const tool = await this.toolFor(kind, ref)
      if (tool) tools.push(tool)
      else {
        problems.push({
          at: 'tools',
          message: `${kind === 'mcp' ? 'MCP server' : 'Skill'} "${ref}" is neither installed in Kettu nor one the Kettu Marketplace installs`,
        })
      }
    }
    if (problems.length > 0) return { problems }
    return { workflow: read.workflow, hash: workflowHash(text), tools }
  }

  private async toolFor(kind: 'mcp' | 'skill', ref: string): Promise<SuggestedTool | null> {
    const kept = this.deps.tools.kept()
    if (kind === 'mcp') {
      const server = keptTool(kept.mcp, ref)
      if (server) {
        return {
          kind,
          ref,
          title: server.title,
          description: null,
          server: null,
          skill: null,
          setup: server.spec.type === 'http' && server.spec.oauth ? 'sign-in' : 'none',
        }
      }
    } else {
      const skill = keptTool(kept.skills, ref)
      if (skill) {
        return {
          kind,
          ref,
          title: skill.name,
          description: skill.description || null,
          server: null,
          skill: null,
          setup: 'none',
        }
      }
    }
    try {
      return await this.deps.tools.resolve(kind, ref)
    } catch (error) {
      this.deps.log('warn', `Could not find ${ref} in the Marketplace: ${(error as Error).message}`)
      return null
    }
  }

  private add(record: SuggestionRecord): Promise<WorkflowSuggestion> {
    const id = `wfs-${this.random()}`
    this.data.suggestions[id] = record
    this.trim()
    this.persist()
    return this.publish(id)
  }

  // Reading.

  async view(id: string): Promise<WorkflowSuggestion> {
    const record = this.record(id)
    const workflow = await this.workflowOf(record)
    return {
      id,
      sessionId: record.sessionId,
      purpose: record.purpose,
      source: record.source,
      workflow,
      hash: record.hash,
      approves: await this.approves(record),
      task: record.task,
      title: record.title,
      pace: record.pace,
      paceReason: record.paceReason,
      agentId: record.agentId,
      tools: record.tools,
      facts: record.facts,
      answer: record.answer,
      ...(record.device ? { device: record.device } : {}),
      createdAt: record.createdAt,
    }
  }

  /** The cards of a session, oldest first; one whose text is gone is left out. */
  async forSession(sessionId: string): Promise<WorkflowSuggestion[]> {
    const ids = Object.entries(this.data.suggestions)
      .filter(([, record]) => record.sessionId === sessionId)
      .sort(([, a], [, b]) => a.createdAt - b.createdAt)
      .map(([id]) => id)
    const views = await Promise.all(ids.map((id) => this.view(id).catch(() => null)))
    return views.filter((view): view is WorkflowSuggestion => view !== null)
  }

  /**
   * How many of a session's cards wait for Start or Do it here. A card to keep a workflow is left
   * out, as is one whose Start failed and one a later turn passed: none asks before the session
   * can go on.
   */
  waitingCount(sessionId: string): number {
    let count = 0
    for (const record of Object.values(this.data.suggestions)) {
      if (waitingStart(record, sessionId)) count++
    }
    return count
  }

  /** A turn started in the session: the cards that waited no longer wait on it. True if any did. */
  turnStarted(sessionId: string): boolean {
    let passed = false
    for (const record of Object.values(this.data.suggestions)) {
      if (!waitingStart(record, sessionId)) continue
      record.passedAt = this.now()
      passed = true
    }
    if (passed) this.persist()
    return passed
  }

  /** The cards `waitingCount` counts, oldest first. */
  async waitingFor(sessionId: string): Promise<WorkflowSuggestion[]> {
    const ids = Object.entries(this.data.suggestions)
      .filter(([, record]) => waitingStart(record, sessionId))
      .sort(([, a], [, b]) => a.createdAt - b.createdAt)
      .map(([id]) => id)
    const views = await Promise.all(ids.map((id) => this.view(id).catch(() => null)))
    return views.filter((view): view is WorkflowSuggestion => view !== null)
  }

  /** The file a card drew, for View file. */
  async file(id: string): Promise<string> {
    const text = await this.text(this.record(id).hash)
    if (text === null) throw notFound(t('workflow.cardNotFound'))
    return text
  }

  private async workflowOf(record: SuggestionRecord): Promise<Workflow> {
    const text = await this.text(record.hash)
    const workflow = text === null ? null : parseWorkflow(text).workflow
    if (!workflow) throw notFound(t('workflow.cardNotFound'))
    return workflow
  }

  /** Whether Start or Save approves a version the library does not hold approved. */
  private async approves(record: SuggestionRecord): Promise<boolean> {
    const source = record.source
    if (source.kind !== 'library') return true
    const entry = (await this.deps.library.list()).find((e) => e.id === source.workflowId)
    return !entry || entry.hash !== record.hash || !usableWorkflow(entry)
  }

  // Answers.

  /**
   * Do it here, or Another way: the card folds, the agent is told to go on or to find another way,
   * and the same workflow is refused.
   */
  async decline(id: string, device?: Device, another = false): Promise<WorkflowSuggestion> {
    const record = this.record(id)
    if (record.purpose !== 'start' || record.answer.kind !== 'waiting') {
      throw new HostError('conflict', t('workflow.cardAnswered'))
    }
    record.answer = { kind: 'declined' }
    this.answered(record, device)
    const view = await this.publish(id)
    await this.deps.sessions
      .tell(
        record.sessionId,
        another
          ? `The user wants another way than running this through "${view.workflow.name}". ` +
              `Suggest a different workflow, write one for this with create_workflow, ` +
              'or ask them what they have in mind.'
          : `The user chose to do this here instead of running it through "${view.workflow.name}". ` +
              'Go on with the work yourself in this session.',
      )
      .catch((error: unknown) =>
        this.deps.log('warn', `Could not tell the agent: ${(error as Error).message}`),
      )
    return view
  }

  /** Use it instead: a card folded by Do it here waits again. */
  async reconsider(id: string): Promise<WorkflowSuggestion> {
    const record = this.record(id)
    if (record.answer.kind !== 'declined') {
      throw new HostError('conflict', t('workflow.cardAnswered'))
    }
    record.answer = { kind: 'waiting' }
    // Asked for again, it waits on the session again.
    delete record.passedAt
    this.answered(record)
    return this.publish(id)
  }

  /** Not now on a workflow to keep. */
  async notSave(id: string, device?: Device): Promise<WorkflowSuggestion> {
    const record = this.record(id)
    if (record.purpose !== 'save' || record.answer.kind !== 'waiting') {
      throw new HostError('conflict', t('workflow.cardAnswered'))
    }
    record.answer = { kind: 'not_saved' }
    this.answered(record, device)
    return this.publish(id)
  }

  /** Save: the workflow goes into the library, approved as the card drew it. */
  async save(id: string, device?: Device): Promise<WorkflowSuggestion> {
    const record = this.record(id)
    if (record.purpose !== 'save' || record.answer.kind !== 'waiting') {
      throw new HostError('conflict', t('workflow.cardAnswered'))
    }
    if (this.running.has(id)) throw new HostError('conflict', t('workflow.cardBusy'))
    this.running.add(id)
    try {
      const text = await this.text(record.hash)
      if (text === null) throw notFound(t('workflow.cardNotFound'))
      const saved = await this.deps.library.create(text, {
        sessionId: record.sessionId,
        agentId: record.agentId,
      })
      if (!('id' in saved)) throw invalidParams(problemLines(saved.problems, problemText))
      await this.deps.library.approve(saved.id, record.hash)
      record.answer = { kind: 'saved', workflowId: saved.id }
      this.answered(record, device)
      return await this.publish(id)
    } finally {
      this.running.delete(id)
    }
  }

  /**
   * Start, or Retry after a failed item: each item in order, those already done skipped, stopping
   * at the first that fails. `first` is the first step's agent and option values; the session's
   * own agent with its defaults when none is given. Resolves once Start is under way, with `done`
   * for its end, which the card follows through the host's events.
   */
  async start(
    id: string,
    first: First,
    device?: Device,
  ): Promise<{ view: WorkflowSuggestion; done: Promise<WorkflowSuggestion> }> {
    const record = this.record(id)
    if (record.purpose !== 'start') throw invalidParams(t('workflow.cardNotFound'))
    if (this.running.has(id)) throw new HostError('conflict', t('workflow.cardBusy'))
    const answer = record.answer
    if (answer.kind !== 'waiting' && answer.kind !== 'failed') {
      throw new HostError('conflict', t('workflow.cardAnswered'))
    }
    this.running.add(id)
    let items: StartProgress[]
    try {
      items =
        answer.kind === 'failed'
          ? answer.items.map((p) =>
              p.state === 'done' ? p : { ...p, state: 'waiting' as const, error: null },
            )
          : (await this.plan(record)).map((item) => ({
              item,
              state: 'waiting' as const,
              error: null,
            }))
    } catch (error) {
      this.running.delete(id)
      throw error
    }
    record.answer = { kind: 'starting', items }
    this.answered(record, device)
    const view = await this.publish(id)
    const done = this.runItems(id, record, items, first).finally(() => this.running.delete(id))
    return { view, done }
  }

  private async runItems(
    id: string,
    record: SuggestionRecord,
    items: StartProgress[],
    first: First,
  ): Promise<WorkflowSuggestion> {
    let taskId: string | null = null
    for (const progress of items) {
      if (progress.state === 'done') continue
      progress.state = 'running'
      this.persist()
      await this.publish(id).catch(() => undefined)
      try {
        taskId = await this.run(id, record, progress.item, first)
        progress.state = 'done'
      } catch (error) {
        progress.state = 'failed'
        progress.error = (error as Error).message
        record.answer = { kind: 'failed', items }
        this.persist()
        return this.publish(id)
      }
    }
    record.answer = taskId ? { kind: 'started', taskId, items } : { kind: 'failed', items }
    this.persist()
    return this.publish(id)
  }

  /** What Start does for this card, as the user sees it ticked off. */
  private async plan(record: SuggestionRecord): Promise<StartItem[]> {
    const workflow = await this.workflowOf(record)
    const kept = this.deps.tools.kept()
    const items: StartItem[] = record.tools
      .filter((tool) => tool.setup !== 'none')
      .map((tool) => ({ kind: 'connected', ref: tool.ref, title: tool.title }))
    if (record.source.kind === 'marketplace') {
      items.push({ kind: 'add', name: workflow.name, version: record.source.version })
    }
    for (const tool of record.tools) {
      if (tool.setup !== 'none') continue
      const own =
        tool.kind === 'mcp' ? keptTool(kept.mcp, tool.ref) : keptTool(kept.skills, tool.ref)
      if (own?.on) continue
      items.push({ kind: 'install', ref: tool.ref, tool: tool.kind, title: tool.title })
    }
    items.push({ kind: 'start', step: stepName(workflow, workflow.steps[0]!.id) })
    return items
  }

  /** Does one item; resolves to the task's id once the last one started it. */
  private async run(
    id: string,
    record: SuggestionRecord,
    item: StartItem,
    first: First,
  ): Promise<string | null> {
    switch (item.kind) {
      case 'connected': {
        const tool = record.tools.find((each) => each.ref === item.ref)
        const server = keptTool(this.deps.tools.kept().mcp, item.ref)
        const ready =
          server !== undefined &&
          server.on &&
          (tool?.setup !== 'sign-in' || this.deps.tools.connected(server.id))
        if (!ready) {
          throw new HostError('restricted', t('workflow.connectFirst', { name: item.title }))
        }
        return null
      }
      case 'add': {
        const source = record.source
        if (source.kind !== 'marketplace') return null
        const text = await this.deps.market.text(source.listingId, source.version)
        if (text === null) throw notFound(t('workflow.noWorkflowFile'))
        // What goes into the library is what the card drew, or nothing.
        if (workflowHash(text) !== record.hash) {
          throw new HostError('conflict', t('workflow.listingChanged'))
        }
        const entry = await this.deps.market.add(
          {
            id: source.listingId,
            version: source.version,
            handle: source.handle,
            slug: source.slug,
            official: source.official,
          },
          text,
        )
        record.added = entry.id
        this.persist()
        return null
      }
      case 'install': {
        const tool = record.tools.find((each) => each.ref === item.ref && each.kind === item.tool)
        if (!tool) throw notFound(t('workflow.cardNotFound'))
        await this.deps.tools.install(tool)
        return null
      }
      case 'start':
        return this.startTask(id, record, first)
    }
  }

  private async startTask(id: string, record: SuggestionRecord, first: First): Promise<string> {
    const projectPath = this.deps.sessions.projectOf(record.sessionId)
    if (!projectPath) throw notFound(t('workflow.noProject'))
    const agentId = first.agentId ?? this.deps.sessions.agentOf(record.sessionId) ?? record.agentId
    const params = {
      projectPath,
      text: record.task,
      ...(record.title ? { title: record.title } : {}),
      pace: record.pace,
      ...(record.paceReason ? { paceReason: record.paceReason } : {}),
      agentId,
      options: { ...(first.options ?? {}) },
    }
    const from = { sessionId: record.sessionId }
    const source = record.source
    let view: TaskView
    if (source.kind === 'draft') {
      const workflow = await this.workflowOf(record)
      view = await this.deps.tasks.start({ ...params, workflowId: source.draftId }, from, {
        id: source.draftId,
        source: 'agent',
        name: workflow.name,
        workflow,
        hash: record.hash,
      })
    } else {
      const workflowId = source.kind === 'library' ? source.workflowId : record.added
      if (!workflowId) throw notFound(t('workflow.notFound'))
      // Start approves what the card drew: a file changed since then is refused here.
      await this.deps.library.approve(workflowId, record.hash)
      view = await this.deps.tasks.start({ ...params, workflowId }, from)
    }
    this.deps.log('info', `Workflow card ${id} started task ${view.id}`)
    return view.id
  }

  // A draft a task ran on.

  /** The text of a draft a task ran on, as the user approved it on its card. */
  async draftText(draftId: string): Promise<string> {
    const draft = DRAFT_ID.test(draftId) ? this.data.drafts[draftId] : undefined
    const text = draft ? await this.text(draft.hash) : null
    if (text === null) throw notFound(t('workflow.notFound'))
    return text
  }

  /**
   * Save as my workflow, once a task that ran on a draft ended done: the draft goes into the
   * library approved, as its card drew it. Saved again, it gives the entry it already became.
   */
  async saveDraft(draftId: string): Promise<WorkflowEntry> {
    const draft = this.data.drafts[draftId]
    const text = await this.draftText(draftId)
    const entries = await this.deps.library.list()
    let entry = entries.find((e) => e.hash === draft!.hash)
    if (!entry) {
      const created = await this.deps.library.create(text, {
        sessionId: draft!.sessionId,
        agentId: draft!.agentId,
      })
      if (!('id' in created)) throw invalidParams(problemLines(created.problems, problemText))
      entry = created
    }
    if (!usableWorkflow(entry)) {
      await this.deps.library.approve(entry.id, draft!.hash)
      entry = (await this.deps.library.list()).find((e) => e.id === entry!.id) ?? entry
    }
    return entry
  }

  /** Who wrote a draft, for the task's delivery to name. */
  draftAgent(draftId: string): AgentId | null {
    return this.data.drafts[draftId]?.agentId ?? null
  }

  // Keeping.

  private record(id: string): SuggestionRecord {
    const record = CARD_ID.test(id) ? this.data.suggestions[id] : undefined
    if (!record) throw notFound(t('workflow.cardNotFound'))
    return record
  }

  private answered(record: SuggestionRecord, device?: Device): void {
    if (device) record.device = { id: device.id, name: device.name }
    else delete record.device
    this.persist()
  }

  private async publish(id: string): Promise<WorkflowSuggestion> {
    const view = await this.view(id)
    this.deps.changed(view)
    return view
  }

  private textFile(hash: string): string {
    return path.join(this.deps.dir, `${hash}.yaml`)
  }

  private async keepText(hash: string, text: string): Promise<void> {
    await mkdir(this.deps.dir, { recursive: true })
    await writeFileAtomic(this.textFile(hash), text)
  }

  private async text(hash: string): Promise<string | null> {
    if (!HASH.test(hash)) return null
    try {
      const text = await readFile(this.textFile(hash), 'utf8')
      return workflowHash(text) === hash ? text : null
    } catch {
      return null
    }
  }

  /** Keeps the newest cards, and the newest drafts with those the kept cards name. */
  private trim(): void {
    const newest = <T extends { createdAt: number }>(records: Record<string, T>) =>
      Object.entries(records)
        .sort(([, a], [, b]) => b.createdAt - a.createdAt)
        .slice(0, KEPT)
    const suggestions = newest(this.data.suggestions)
    const named = new Set([
      ...suggestions.flatMap(([, s]) => (s.source.kind === 'draft' ? [s.source.draftId] : [])),
      ...(this.deps.tasks.draftIds?.() ?? []),
    ])
    const recent = new Set(newest(this.data.drafts).map(([id]) => id))
    this.data.suggestions = Object.fromEntries(suggestions)
    this.data.drafts = Object.fromEntries(
      Object.entries(this.data.drafts).filter(([id]) => named.has(id) || recent.has(id)),
    )
  }

  /**
   * Removes the texts no card or draft names any more; only as the host starts, after the tasks,
   * so no text goes while a card that names it is being made or a task runs on it.
   */
  async sweep(): Promise<void> {
    const before = Object.keys(this.data.drafts).length + Object.keys(this.data.suggestions).length
    this.trim()
    if (Object.keys(this.data.drafts).length + Object.keys(this.data.suggestions).length !== before)
      this.persist()
    let names: string[]
    try {
      names = await readdir(this.deps.dir)
    } catch {
      return
    }
    const used = new Set([
      ...Object.values(this.data.suggestions).map((s) => s.hash),
      ...Object.values(this.data.drafts).map((d) => d.hash),
    ])
    await Promise.all(
      names
        .filter((name) => name.endsWith('.yaml') && !used.has(name.slice(0, -5)))
        .map((name) => rm(path.join(this.deps.dir, name), { force: true }).catch(() => undefined)),
    )
  }

  private persist(): void {
    this.deps.file.save(this.data)
  }
}
