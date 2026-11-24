// The Marketplace tools of Kettu's MCP service: an agent checks a folder, publishes it to the Kettu
// Marketplace as a new listing or a new version, lists what the user published and unlists one.
// Every publish and unlisting waits for the user's answer in a card of the session, and nothing is
// uploaded before Publish; what was put off is kept as a draft.

import path from 'node:path'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import type { PublishPlan } from '@shared/agent-host'
import { CONTROL_WAIT_MS } from '@shared/control'
import {
  LISTING_NOTES_CHARS,
  VERSION,
  nextPatch,
  reviewVersions,
  suggestHandle,
  type ListingChange,
  type MarketAccount,
  type MarketCall,
  type MarketFailure,
  type MarketMine,
  type MarketProblem,
  type MarketPublished,
  type MarketPublisher,
  type MarketResults,
  type MarketVersionFiles,
  type MineListing,
  type PublishAdds,
  type PublishDraft,
  type PublishKind,
  type PublishManifest,
  type PublishOrigin,
  type PublishResult,
  type PublishVisibility,
} from '@shared/market-publish'
import type { Platform } from '@shared/platform'
import type { PluginConverted } from '@shared/plugin-convert'
import { WORKFLOW_FILE_BYTES } from '@shared/workflow'
import type { MarketPublishAsk, MarketPublishChange, MarketPublishOutcome } from '@shared/thread'
import type { Caller } from '../artifacts/tools'
import { HostError } from '../errors'
import { t } from '../i18n'
import { pathKey } from '../paths'
import { writeFileAtomic } from '../storage'
import { parseWorkflow } from '../workflow/format'
import { sameFlow } from '../workflow/graph'
import { forAgent, problem, problemOf, problemWith } from './localized-error'
import type { PluginConverter } from './plugin-conversions'
import { checkFolder, type CheckedFile, type FolderCheck } from './publish-check'
import type { NewDraft, PublishedVersion } from './publish-drafts'

export const MARKET_CHECK = 'marketplace_check'
export const MARKET_CONVERT = 'marketplace_convert'
export const MARKET_PUBLISH = 'marketplace_publish'
export const MARKET_MINE = 'marketplace_mine'
export const MARKET_UNLIST = 'marketplace_unlist'
/**
 * They run without the agent's own permission prompt: check and mine only read, and publish and
 * unlist wait for the user in Kettu's card, so the card is the only ask. Convert writes a folder,
 * so it keeps the agent's own prompt.
 */
export const MARKET_AUTO_ALLOW = [MARKET_CHECK, MARKET_MINE, MARKET_PUBLISH, MARKET_UNLIST]

const OFFICIAL_HANDLE = 'kettu-labs'
const PATH_CHARS = 4096
const LISTING_REF_CHARS = 80
const TASK_ID_CHARS = 64
const TASK_ID = /^[A-Za-z0-9_-]+$/
const CHANGES_CHARS = 300
// A new version's changed files are compared line by line up to these bounds.
const COMPARE_FILES = 40
const COMPARE_BYTES = 256 * 1024

const PATH_FIELD = {
  type: 'string',
  minLength: 1,
  maxLength: PATH_CHARS,
  description: 'The folder or .mcpb file, absolute or from the session’s folder.',
} as const

const WORKFLOW_FIELD = {
  type: 'string',
  minLength: 1,
  maxLength: WORKFLOW_FILE_BYTES,
  description:
    'Instead of path, the whole workflow.yaml of a task’s workflow Kettu asked you to publish, ' +
    'with from_task: Kettu keeps it in that task’s folder, so write no file of your own.',
} as const

const FROM_TASK_FIELD = {
  type: 'string',
  maxLength: TASK_ID_CHARS,
  description:
    'For a workflow made general from the one a task ran on, that task’s id, as Kettu gave it ' +
    'when it asked you to publish: the card compares the two.',
} as const

export const MARKET_TOOLS: Tool[] = [
  {
    name: MARKET_CHECK,
    title: 'Check a folder for the Kettu Marketplace',
    description:
      'Checks a folder before it is published to the Kettu Marketplace, uploading nothing. It ' +
      'tells what the folder is (a skill with SKILL.md, a workflow with workflow.yaml and an ' +
      'optional README.md, an MCP server with server.json, an MCP bundle .mcpb file, or a ' +
      'plugin with plugin.json), its name, description and version, the files that would ' +
      'upload and their size, what an install adds and runs (for a workflow, its steps, those ' +
      'that wait for the user and the MCP servers and Skills they name; for a plugin, its ' +
      'skills, servers, commands, roles and workflows, and the permissions of its script, which ' +
      'only Kettu’s own publisher may publish), whether the user published it before, and ' +
      'every problem that keeps it from being published, such as a missing field, a ' +
      'workflow.yaml the workflow format refuses, too many files or a secret in a file. A ' +
      'Claude Code or Codex plugin is not published as it is: convert it with ' +
      'marketplace_convert. Fix the problems, then check again. Pass path, or for a task’s ' +
      'workflow Kettu asked you to publish, workflow and from_task.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_FIELD,
        workflow: WORKFLOW_FIELD,
        from_task: FROM_TASK_FIELD,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: MARKET_CONVERT,
    title: 'Convert a Claude Code or Codex plugin to a Kettu plugin',
    description:
      'Turns the Claude Code or Codex plugin in a folder into a Kettu plugin and writes it to a ' +
      'new folder next to it, leaving the original as it is. Skills are copied as they are, MCP ' +
      'servers are written in the standard form, commands become Kettu commands and agents ' +
      'become roles. Hooks do not come over: the result names each one left out and why, and ' +
      'so it does anything else it could not carry. Then check the new folder with ' +
      'marketplace_check and publish it; the user reviews what was converted in the publish ' +
      'card. Publish it only when the user asked.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          minLength: 1,
          maxLength: PATH_CHARS,
          description: 'The plugin’s folder, absolute or from the session’s folder.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: MARKET_PUBLISH,
    title: 'Publish to the Kettu Marketplace',
    description:
      'Publishes a folder to the Kettu Marketplace, as a new listing or as a new version of one ' +
      'the user published. Check it with marketplace_check first. The user confirms every ' +
      'publish in a card in this session, which waits up to 10 minutes; nothing is uploaded ' +
      'until they press Publish. This call returns within a minute: if it says the user has not ' +
      'answered yet, call it again with the same arguments, which shows no second card and returns ' +
      'what became of this one, even when they answered between calls. If they choose Not now or ' +
      'do not answer, nothing is uploaded and it is kept as a draft they can publish later: do ' +
      'not publish it again unless they ask. A version can be held for review: the answer then ' +
      'says it is stored but not listed yet and the previous version stays listed; tell the ' +
      'user it waits for review, and do not publish it again. An MCP server takes the version ' +
      'in its manifest; a skill or a workflow gets 1.0.0 first, then the next patch version ' +
      'unless you pass one. For a new version, write short notes on what changed. Pass path, or ' +
      'for a task’s workflow Kettu asked you to publish, workflow and from_task.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_FIELD,
        workflow: WORKFLOW_FIELD,
        visibility: {
          type: 'string',
          enum: ['public', 'private'],
          description:
            'For a new listing: public lists it for everyone, private only for the user’s own ' +
            'computers. The user can change it in the card. A new version keeps its listing’s.',
        },
        version: {
          type: 'string',
          maxLength: 64,
          description:
            'A skill’s or workflow’s version, such as 1.2.0, when the next patch is not right.',
        },
        notes: {
          type: 'string',
          maxLength: LISTING_NOTES_CHARS,
          description:
            'What changed in this version, in a sentence or two. The user can edit them.',
        },
        from_task: FROM_TASK_FIELD,
        changes: {
          type: 'string',
          maxLength: CHANGES_CHARS,
          description:
            'With from_task, one sentence on what you changed to make it general, such as the ' +
            'project names and request text you took out.',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: MARKET_MINE,
    title: 'List what the user published',
    description:
      'Lists what the user published to the Kettu Marketplace: each listing’s name, kind, who ' +
      'can see it, versions, installs and whether it was taken down, and the drafts waiting to ' +
      'be published. A version is live, withdrawn, held for review (stored, not listed until it ' +
      'is reviewed) or not approved, with the reason it gave.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: MARKET_UNLIST,
    title: 'Unlist from the Kettu Marketplace',
    description:
      'Takes a listing the user published out of the Kettu Marketplace: it is no longer listed ' +
      'and gets no new installs, while people who have it keep it and its updates. The user ' +
      'confirms it in a card in this session, which waits up to 10 minutes. This call returns ' +
      'within a minute: if it says the user has not answered yet, call it again with the same ' +
      'listing, which shows no second card and returns what became of this one, even when they ' +
      'answered between calls.',
    inputSchema: {
      type: 'object',
      properties: {
        listing: {
          type: 'string',
          minLength: 1,
          maxLength: LISTING_REF_CHARS,
          description: 'The listing’s id, or its name as @publisher/slug, from marketplace_mine.',
        },
      },
      required: ['listing'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
]

const NAMES = new Set(MARKET_TOOLS.map((tool) => tool.name))

export function isMarketToolName(name: string): boolean {
  return NAMES.has(name)
}

/** What a card shows, as the host adds it to the thread. */
export type MarketAsk = MarketPublishAsk

/** The user's answer to a card, or how it ended without one. */
export type MarketAnswer =
  | { decision: 'confirm'; visibility: PublishVisibility | null; notes: string | null }
  | { decision: 'later' | 'expired' | 'ended' }

/** A call the main process or the daemon refused, with the service's reason. */
export class MarketCallError extends Error {
  constructor(readonly failure: MarketFailure) {
    super(failure.message)
    this.name = 'MarketCallError'
  }
}

export interface MarketToolsDeps {
  /** The host's Kettu account, while it is signed in with Kettu's services on. */
  account(): MarketAccount | null
  /** Makes an API call through main or the daemon; throws `MarketCallError`. */
  call<K extends MarketCall['kind']>(
    call: Extract<MarketCall, { kind: K }>,
  ): Promise<MarketResults[K]>
  /** Adds the card to the session's thread; null for a session Kettu holds no thread for. */
  ask(sessionId: string, ask: MarketAsk): { entryId: string; answer: Promise<MarketAnswer> } | null
  /** What became of a card the user answered. */
  settle(sessionId: string, entryId: string, outcome: MarketPublishOutcome): void
  /**
   * Tells the session what became of a card no call of its is left to take, as the answer on a
   * card it showed: sent now when it is idle, else queued.
   */
  tell(sessionId: string, text: string): void
  drafts: {
    put(draft: NewDraft): Promise<PublishDraft>
    published(folder: string, version?: PublishedVersion): Promise<void>
    list(): PublishDraft[]
    origins(): Record<string, PublishOrigin>
    forget(listingId: string): Promise<void>
  }
  /** What Marketplace › Published shows changed: the listings, the drafts or the publisher. */
  changed(): void
  agentOf(sessionId: string): string | null
  sessionTitle(sessionId: string): string | null | undefined
  /** The workflow file a task ran on and the task's title, for the card to compare with. */
  taskWorkflow?(taskId: string): Promise<{ title: string; text: string } | null>
  /**
   * The folder Kettu keeps a task's workflow in for publishing, for a task whose agent wrote its
   * workflow and that ended done; null for any other.
   */
  taskWorkflowFolder?(taskId: string): string | null
  /** Converts harness plugins into Kettu plugins and remembers what each conversion left out. */
  converter: Pick<PluginConverter, 'folder' | 'conversionOf'>
  /** The Kettu version, which a plugin's own range of versions is checked against. */
  appVersion: string
  home: string
}

/**
 * A card a call opened and what follows its answer. It outlives the call and the turn, so the
 * agent's next call for the same folder or listing picks it up; what comes of it once no call is
 * left to take it is told to the session.
 */
interface CardJob {
  action: 'publish' | 'unlist'
  /** What a call names it by: a publish's folder key, an unlisting's listing id and names. */
  refs: string[]
  /** The item's name, as a call that returns before the answer says it. */
  name: string
  confirmed: boolean
  /** It ended with its session, which no one is told. */
  ended: boolean
  result: Promise<CallToolResult>
  /** Counts the session's turn ends since it opened; a call takes it only within its own turn. */
  turn: number
  /** Calls of the current turn waiting on it. */
  waiting: number
  /** What came of it while no call waited, as the session is told. */
  came: string | null
  told: boolean
}

type Code = 'invalid' | 'signed_out' | 'not_found' | 'not_ready' | 'refused'

class Refusal extends Error {
  constructor(
    readonly code: Code,
    message: string,
    readonly problems: MarketProblem[] = [],
  ) {
    super(message)
    this.name = 'Refusal'
  }
}

function invalid(message: string): Refusal {
  return new Refusal('invalid', message)
}

function fields(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalid('The arguments must be an object.')
  }
  const o = input as Record<string, unknown>
  const unknown = Object.keys(o).find((key) => !allowed.includes(key))
  if (unknown !== undefined) throw invalid(`Unknown argument ${unknown}.`)
  return o
}

function text(
  o: Record<string, unknown>,
  key: string,
  max: number,
  required: boolean,
): string | null {
  const value = o[key]
  if (value === undefined && !required) return null
  if (typeof value !== 'string' || value.trim() === '') {
    if (!required && value === '') return null
    throw invalid(`${key} must be a non-empty string.`)
  }
  if (value.length > max) throw invalid(`${key} must be at most ${max} characters.`)
  return value.trim()
}

/** A call's folder: a path, or a task's workflow as text for the folder Kettu keeps it in. */
interface Target {
  path: string | null
  workflow: string | null
  fromTask: string | null
}

function targetOf(o: Record<string, unknown>): Target {
  const given = text(o, 'path', PATH_CHARS, false)
  const fromTask = text(o, 'from_task', TASK_ID_CHARS, false)
  if (fromTask !== null && !TASK_ID.test(fromTask)) {
    throw invalid('from_task must be a task id as Kettu gave it.')
  }
  const workflow = o.workflow
  if (workflow === undefined) {
    if (given === null) throw invalid('Pass path, or workflow with from_task.')
    return { path: given, workflow: null, fromTask }
  }
  if (given !== null) throw invalid('Pass either path or workflow, not both.')
  if (typeof workflow !== 'string' || workflow.trim() === '') {
    throw invalid('workflow must be the text of a workflow.yaml.')
  }
  if (Buffer.byteLength(workflow, 'utf8') > WORKFLOW_FILE_BYTES) {
    throw invalid(`workflow must be at most ${WORKFLOW_FILE_BYTES / 1024} KB.`)
  }
  if (fromTask === null) throw invalid('workflow needs from_task, the task Kettu asked about.')
  return { path: null, workflow, fromTask }
}

export function parsePublishInput(input: unknown): Target & {
  visibility: PublishVisibility | null
  version: string | null
  notes: string | null
  changes: string | null
} {
  const o = fields(input, [
    'path',
    'workflow',
    'visibility',
    'version',
    'notes',
    'from_task',
    'changes',
  ])
  const target = targetOf(o)
  const visibility = o.visibility ?? null
  if (visibility !== null && visibility !== 'public' && visibility !== 'private') {
    throw invalid('visibility must be public or private.')
  }
  const version = text(o, 'version', 64, false)
  if (version !== null && !VERSION.test(version)) {
    throw invalid(`version must be a version such as 1.2.0, not "${version}".`)
  }
  return {
    ...target,
    visibility,
    version,
    notes: text(o, 'notes', LISTING_NOTES_CHARS, false),
    changes: text(o, 'changes', CHANGES_CHARS, false),
  }
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function lineList(text: string): string[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** Lines added and removed between two texts, counting a line moved as neither. */
export function lineChanges(before: string, after: string): { added: number; removed: number } {
  const left = new Map<string, number>()
  for (const line of lineList(before)) left.set(line, (left.get(line) ?? 0) + 1)
  let added = 0
  for (const line of lineList(after)) {
    const count = left.get(line) ?? 0
    if (count > 0) left.set(line, count - 1)
    else added++
  }
  let removed = 0
  for (const count of left.values()) removed += count
  return { added, removed }
}

/** Keys in a fixed order, so two equal objects read the same. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const o = value as Record<string, unknown>
    return `{${Object.keys(o)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(o[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** What a folder is ready to publish as, or why not, with the user's listing it would update. */
interface Plan {
  check: FolderCheck
  /** The folder as it was given, resolved but not through links, as the user's projects name it. */
  target: string
  folder: string
  mine: MarketMine | null
  /** Why the user's listings could not be read, for a check that goes on without them. */
  mineError: string | null
  /** The same in the user's language. */
  mineText: string | null
  listing: MineListing | null
  version: string | null
  problems: MarketProblem[]
}

function listingName(listing: Pick<MineListing, 'handle' | 'slug'>): string {
  return `@${listing.handle}/${listing.slug}`
}

/**
 * Whether the account publishes as Kettu's own publisher, which a plugin's script needs: one of its
 * listings is official, or its name is the one Kettu's workflows are published under.
 */
function officialPublisher(mine: MarketMine): boolean {
  return mine.publisher?.handle === OFFICIAL_HANDLE || mine.listings.some((l) => l.official)
}

const KIND_NAMES = {
  skill: 'skill',
  workflow: 'workflow',
  plugin: 'plugin',
  'mcp-server': 'MCP server',
  'agent-plugin': 'plugin',
} as const

/** A skill and a workflow have no version of their own: Kettu numbers them. */
function numbered(kind: PublishKind | null | undefined): boolean {
  return kind === 'skill' || kind === 'workflow'
}

export class MarketTools {
  /** The cards calls opened, by session. */
  private readonly jobs = new Map<string, CardJob[]>()

  constructor(private readonly deps: MarketToolsDeps) {}

  /** Whether the host is signed in to a Kettu account with Kettu's services on, which lists them. */
  get on(): boolean {
    return this.deps.account() !== null
  }

  /**
   * The session's turn ended: its cards wait on for their own time, and what comes of one no call
   * took is told to the session. A card already told is done once the turn after it ends.
   */
  turnEnded(sessionId: string): void {
    for (const job of this.jobs.get(sessionId) ?? []) {
      if (job.told) {
        this.done(sessionId, job)
        continue
      }
      job.turn++
      job.waiting = 0
      if (job.came !== null) this.tell(sessionId, job)
    }
  }

  /** Serves a call; a refusal becomes a tool error whose text says why. */
  async call(caller: Caller, name: string, input: unknown): Promise<CallToolResult> {
    // Before the harness's own limit for one tool call, from when the call came in.
    const deadline = Date.now() + CONTROL_WAIT_MS
    try {
      if (!this.deps.account()) {
        throw new Refusal(
          'signed_out',
          'The Kettu Marketplace needs this computer signed in to a Kettu account with Kettu’s ' +
            'cloud services on. Ask the user to sign in in Settings › Account.',
        )
      }
      switch (name) {
        case MARKET_CHECK:
          return await this.check(caller, input)
        case MARKET_CONVERT:
          return await this.convert(caller, input)
        case MARKET_PUBLISH:
          return await this.publish(caller, input, deadline)
        case MARKET_MINE:
          fields(input ?? {}, [])
          return await this.mine()
        case MARKET_UNLIST:
          return await this.unlist(caller, input, deadline)
        default:
          throw new Error(`Unknown tool ${name}`)
      }
    } catch (error) {
      if (error instanceof MarketCallError) {
        return failed(error.failure.code, serviceText(error.failure), error.failure.problems ?? [])
      }
      if (error instanceof Refusal) return failed(error.code, error.message, error.problems)
      throw error
    }
  }

  /** Sets the account's publisher name, from the card of a first publish. */
  async setPublisher(handle: string): Promise<MarketPublisher> {
    const publisher = await this.deps.call({ kind: 'set-publisher', handle })
    this.deps.changed()
    return publisher
  }

  /** Marketplace › Published: what the account published, the drafts and where each came from. */
  async published(): Promise<MarketPublished> {
    const account = this.deps.account()
    const drafts = this.deps.drafts.list()
    const origins = this.deps.drafts.origins()
    if (!account) return { account: null, mine: null, error: null, drafts, origins }
    try {
      const mine = await this.deps.call({ kind: 'mine' })
      return { account, mine, error: null, drafts, origins }
    } catch (error) {
      if (!(error instanceof MarketCallError)) throw error
      return { account, mine: null, error: userText(error.failure), drafts, origins }
    }
  }

  /** From a folder: the same check and what to confirm as a session's card, uploading nothing. */
  async checkFolder(target: string, draftId: string | null): Promise<PublishPlan> {
    this.signedIn()
    const draft = this.draftFor(draftId, target)
    const plan = await this.plan(target, null, draftVersion(draft), true)
    const problems = [...plan.problems]
    if (plan.check.slug && !plan.mine && plan.mineError) {
      problems.push(problemOf(plan.mineError, plan.mineText ?? plan.mineError))
    }
    const ask = await this.askOf(
      plan,
      draft?.manifest.visibility ?? null,
      draft?.manifest.notes ?? null,
    )
    return {
      ask,
      problems,
      ...(plan.check.convertible ? { convertible: plan.check.convertible } : {}),
    }
  }

  /** Publishes a folder the user confirmed in the dialog; a refusal is kept as a draft. */
  async publishFolder(
    target: string,
    answer: { draftId: string | null; visibility: PublishVisibility | null; notes: string | null },
  ): Promise<PublishResult> {
    this.signedIn()
    const draft = this.draftFor(answer.draftId, target)
    const plan = await this.plan(target, null, draftVersion(draft), true)
    if (plan.problems.length > 0 || !plan.check.kind || !plan.version) {
      throw new HostError('invalid_params', t('marketPublish.notReady'), {
        problems: plan.problems,
      })
    }
    if (!plan.mine) {
      throw new HostError('unavailable', plan.mineText ?? t('marketPublish.failure.unreadable'))
    }
    const from = draft
      ? {
          ...(draft.manifest.agent ? { agent: draft.manifest.agent } : {}),
          ...(draft.manifest.session ? { session: draft.manifest.session } : {}),
        }
      : {}
    const notes = answer.notes?.trim() ? answer.notes : null
    const manifest = this.manifestOf(
      plan,
      answer.visibility ?? draft?.manifest.visibility ?? null,
      plan.listing ? notes : null,
      from,
    )
    try {
      return await this.upload(plan, manifest, draft?.sessionId ?? null)
    } catch (error) {
      if (!(error instanceof MarketCallError)) throw error
      await this.keepDraft(plan, manifest, {
        sessionId: draft?.sessionId ?? null,
        sessionTitle: draft?.sessionTitle ?? null,
        agentId: draft?.agentId ?? null,
        error: userText(error.failure),
        problems: error.failure.problems ?? [],
      })
      throw hostFailure(error.failure)
    }
  }

  async updateListing(id: string, change: ListingChange): Promise<MineListing> {
    return this.change(() => this.deps.call({ kind: 'update', id, change }))
  }

  async withdrawVersion(id: string, version: string): Promise<MineListing> {
    return this.change(() => this.deps.call({ kind: 'withdraw', id, version }))
  }

  async deleteListing(id: string): Promise<void> {
    await this.change(() => this.deps.call({ kind: 'delete', id }))
    await this.deps.drafts.forget(id)
  }

  async versionFiles(id: string, version: string): Promise<MarketVersionFiles> {
    this.signedIn()
    try {
      return await this.deps.call({ kind: 'version', id, version })
    } catch (error) {
      if (error instanceof MarketCallError) throw hostFailure(error.failure)
      throw error
    }
  }

  /** Sets the publisher name from Edit profile, with the reason the service refused one. */
  async renamePublisher(handle: string): Promise<MarketPublisher> {
    return this.change(() => this.deps.call({ kind: 'set-publisher', handle }))
  }

  private async change<T>(call: () => Promise<T>): Promise<T> {
    this.signedIn()
    try {
      const result = await call()
      this.deps.changed()
      return result
    } catch (error) {
      if (error instanceof MarketCallError) throw hostFailure(error.failure)
      throw error
    }
  }

  private signedIn(): void {
    if (!this.deps.account()) {
      throw new HostError('auth_required', t('marketPublish.failure.signed_out'))
    }
  }

  /**
   * The draft a dialog publishes, when it is of the folder it names; one kept of that folder since,
   * as a refused publish keeps, stands in for it.
   */
  private draftFor(draftId: string | null, target: string): PublishDraft | null {
    if (draftId === null) return null
    const folder = path.resolve(target)
    const drafts = this.deps.drafts.list().filter((d) => path.resolve(d.path) === folder)
    return drafts.find((d) => d.id === draftId) ?? drafts[0] ?? null
  }

  private where(caller: Caller): string {
    return caller.folder ?? caller.project
  }

  /** The absolute folder a call names: its path, or the folder Kettu keeps its task's workflow in. */
  private folderOf(target: Target, base: string): string {
    if (target.path !== null) return path.resolve(base, target.path)
    const folder = this.deps.taskWorkflowFolder?.(target.fromTask!) ?? null
    if (!folder) {
      throw new Refusal(
        'not_found',
        `Kettu has no workflow of task ${target.fromTask} to publish. Pass the task id Kettu gave ` +
          'when it asked you to publish.',
      )
    }
    return folder
  }

  /** The path as the card shows it: from the session's folder, or with `~` for the home folder. */
  private shown(target: string, base: string): string {
    const relative = path.relative(base, target)
    if (relative === '') return '.'
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      return relative.split(path.sep).join('/')
    }
    return this.homeShown(target)
  }

  private homeShown(target: string): string {
    const home = this.deps.home
    return target === home || target.startsWith(home + path.sep)
      ? `~${target.slice(home.length)}`
      : target
  }

  /**
   * `target` is absolute; the card shows it from `base`, or from the home folder without one. A
   * `soft` version is dropped for the next patch when it is published already, as a draft's.
   */
  private async plan(
    target: string,
    base: string | null,
    wanted: string | null,
    soft = false,
  ): Promise<Plan> {
    const check = await checkFolder(target, this.deps.appVersion)
    const problems = [...check.problems]
    let mine: MarketMine | null = null
    let mineError: string | null = null
    let mineText: string | null = null
    if (check.slug) {
      try {
        mine = await this.deps.call({ kind: 'mine' })
      } catch (error) {
        if (!(error instanceof MarketCallError)) throw error
        mineError = serviceText(error.failure)
        mineText = userText(error.failure)
      }
    }
    const same = mine?.listings.find((listing) => listing.slug === check.slug) ?? null
    let listing: MineListing | null = null
    if (same && same.kind !== check.kind) {
      const key = same.kind === 'plugin' ? 'closedPlugin' : 'otherKind'
      problems.push(
        problemWith(undefined, (say) =>
          say(`marketPublish.check.${key}`, { listing: listingName(same) }),
        ),
      )
    } else if (same) {
      listing = same
      if (same.takenDown) {
        const { reason } = same.takenDown
        problems.push(
          problemWith(undefined, (say) =>
            say('marketPublish.check.takenDown', { listing: listingName(same), reason }),
          ),
        )
      }
    }
    if (check.plugin?.script && mine && !officialPublisher(mine)) {
      problems.push(problem(check.manifest ?? undefined, 'marketPublish.check.scriptNotAllowed'))
    }
    const taken = listing?.versions.map((v) => v.version) ?? []
    if (soft && wanted !== null && taken.includes(wanted)) wanted = null
    let version: string | null = check.version
    if (numbered(check.kind)) {
      version = wanted ?? (listing ? nextPatch(taken) : '1.0.0')
    } else if (wanted !== null && check.version !== null && wanted !== check.version) {
      const passed = { version: check.version, wanted }
      problems.push(
        problemWith(check.manifest ?? undefined, (say) =>
          say('marketPublish.check.versionInManifest', passed),
        ),
      )
    }
    if (version !== null && taken.includes(version)) {
      const name = listingName(listing!)
      problems.push(
        problemWith(numbered(check.kind) ? undefined : (check.manifest ?? undefined), (say) =>
          numbered(check.kind)
            ? say('marketPublish.check.versionTakenNumbered', { version, listing: name })
            : say('marketPublish.check.versionTaken', {
                version,
                listing: name,
                manifest: check.manifest ?? '',
              }),
        ),
      )
    }
    return {
      check,
      target,
      folder: base === null ? this.homeShown(target) : this.shown(target, base),
      mine,
      mineError,
      mineText,
      listing,
      version,
      problems,
    }
  }

  private async check(caller: Caller, input: unknown): Promise<CallToolResult> {
    const given = targetOf(fields(input, ['path', 'workflow', 'from_task']))
    const base = this.where(caller)
    const target = this.folderOf(given, base)
    if (given.workflow !== null) {
      const ref = pathKey(target, process.platform as Platform)
      if (this.jobOf(caller.sessionId, 'publish', ref)) {
        throw new Refusal(
          'refused',
          'Its publish waits for the user’s answer in a card, so the workflow was left as the ' +
            'card shows it. Call marketplace_publish again with the same arguments for what ' +
            'became of it.',
        )
      }
      await writeFileAtomic(path.join(target, 'workflow.yaml'), given.workflow)
    }
    const plan = await this.plan(target, base, null)
    const { check, listing, problems } = plan
    const lines: string[] = []
    if (check.kind && check.name) {
      const kind = KIND_NAMES[check.kind]
      lines.push(
        `${problems.length === 0 ? 'Ready to publish' : 'Not ready to publish'}: the ${kind} ` +
          `"${check.name}" (${check.slug}) ${plan.version ?? ''}, ${check.files.length} files, ` +
          `${sizeText(check.bytes)}, from ${plan.folder}.`.replace(' ,', ','),
      )
      if (check.kind === 'workflow') lines.push(...workflowLines(check.adds))
      if (check.plugin) lines.push(...pluginLines(check.plugin))
      if (listing) {
        lines.push(
          `It would be a new version of ${listingName(listing)}, now at ${listing.current ?? 'no live version'}.`,
        )
      } else if (plan.mine) {
        lines.push('It would be a new listing.')
      } else if (plan.mineError) {
        lines.push(`Kettu could not read the user’s listings: ${plan.mineError}`)
      }
    }
    if (problems.length > 0) {
      lines.push('Problems to fix:', ...problems.map(problemLine))
    }
    if (check.convertible) {
      lines.push(
        'Call marketplace_convert with this path for a Kettu plugin made from it, written to a ' +
          'new folder next to this one, which stays as it is. Then check that folder.',
      )
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        ready: problems.length === 0,
        ...(check.convertible ? { convertible: check.convertible } : {}),
        kind: check.kind,
        name: check.name,
        slug: check.slug,
        description: check.description,
        version: plan.version,
        listing: listing ? listingName(listing) : null,
        current: listing?.current ?? null,
        files: check.files.length,
        bytes: check.bytes,
        adds: check.adds,
        runs: check.runs,
        ...(check.plugin
          ? {
              script: check.plugin.script,
              permissions: check.plugin.permissions,
              leftOut: check.plugin.warnings,
            }
          : {}),
        problems: forAgent(problems),
      },
    }
  }

  /** Writes a Kettu plugin made from the harness plugin in a folder, next to it. */
  private async convert(caller: Caller, input: unknown): Promise<CallToolResult> {
    const o = fields(input, ['path'])
    const given = text(o, 'path', PATH_CHARS, true)!
    let converted: PluginConverted
    try {
      converted = await this.deps.converter.folder(path.resolve(this.where(caller), given))
    } catch (error) {
      if (error instanceof HostError) throw new Refusal('refused', error.message)
      throw error
    }
    return {
      content: [{ type: 'text', text: convertedLines(converted).join('\n') }],
      structuredContent: {
        path: converted.path,
        name: converted.name,
        from: converted.conversion.from,
        carried: converted.conversion.carried,
        leftOut: converted.conversion.leftOut.map(({ kind, name, message }) => ({
          kind,
          name,
          reason: message,
        })),
        notes: converted.conversion.notes.map(({ name, message }) => ({ name, note: message })),
      },
    }
  }

  private async publish(caller: Caller, input: unknown, deadline: number): Promise<CallToolResult> {
    const args = parsePublishInput(input)
    const base = this.where(caller)
    const target = this.folderOf(args, base)
    const ref = pathKey(target, process.platform as Platform)
    const waiting = this.jobOf(caller.sessionId, 'publish', ref)
    if (waiting) return this.follow(caller.sessionId, waiting, deadline)
    // Written only once no card waits on the folder, so what the user confirms is what uploads.
    if (args.workflow !== null) {
      await writeFileAtomic(path.join(target, 'workflow.yaml'), args.workflow)
    }
    const plan = await this.plan(target, base, args.version)
    const { check } = plan
    if (plan.problems.length > 0 || !check.kind || !check.slug || !check.name || !plan.version) {
      throw new Refusal(
        'not_ready',
        ['Nothing was uploaded. Fix these first:', ...plan.problems.map(problemLine)].join('\n'),
        plan.problems,
      )
    }
    if (!plan.mine) {
      throw new Refusal(
        'refused',
        `Nothing was uploaded: ${plan.mineError ?? 'Kettu could not read the user’s listings.'}`,
      )
    }
    const ask = await this.askOf(plan, args.visibility, args.notes, args)
    // Another call for the same folder may have opened its card while this one checked it.
    const opened = this.jobOf(caller.sessionId, 'publish', ref)
    if (opened) return this.follow(caller.sessionId, opened, deadline)
    const asked = ask ? this.deps.ask(caller.sessionId, ask) : null
    if (!asked) throw new Refusal('not_found', 'This session is not open, so it shows no card.')
    const job = this.open(caller.sessionId, 'publish', [ref], check.name, asked.answer, (answer) =>
      this.answered(caller, plan, args, asked.entryId, answer),
    )
    return this.follow(caller.sessionId, job, deadline)
  }

  /** Uploads what the user confirmed, or keeps it as a draft. */
  private async answered(
    caller: Caller,
    plan: Plan,
    args: ReturnType<typeof parsePublishInput>,
    entryId: string,
    answer: MarketAnswer,
  ): Promise<CallToolResult> {
    const { listing } = plan
    const manifest = this.manifestOf(plan, args.visibility, args.notes, this.from(caller.sessionId))
    const draft = (error: string | null, problems: MarketProblem[] = []) =>
      this.keepDraft(plan, manifest, {
        sessionId: caller.sessionId,
        sessionTitle: this.deps.sessionTitle(caller.sessionId) ?? null,
        agentId: this.deps.agentOf(caller.sessionId),
        error,
        problems,
      })
    if (answer.decision !== 'confirm') {
      await draft(null)
      return {
        content: [
          {
            type: 'text',
            text:
              answer.decision === 'later'
                ? 'The user chose Not now. Nothing was uploaded; it is kept as a draft in Marketplace › Published. Do not publish it again unless they ask.'
                : answer.decision === 'expired'
                  ? 'The user did not answer within 10 minutes. Nothing was uploaded; it is kept as a draft in Marketplace › Published.'
                  : 'The session closed before the user answered. Nothing was uploaded; it is kept as a draft in Marketplace › Published.',
          },
        ],
        structuredContent: { published: false, draft: true },
      }
    }
    if (answer.notes !== null) manifest.notes = answer.notes
    else delete manifest.notes
    if (!listing && answer.visibility) manifest.visibility = answer.visibility
    let published: PublishResult
    try {
      published = await this.upload(plan, manifest, caller.sessionId)
    } catch (error) {
      if (!(error instanceof MarketCallError)) throw error
      const message = serviceText(error.failure)
      const shown = userText(error.failure)
      const problems = error.failure.problems ?? []
      this.deps.settle(caller.sessionId, entryId, { kind: 'failed', message: shown, problems })
      await draft(shown, problems)
      throw new Refusal(
        'refused',
        [
          `The Kettu Marketplace refused it, and it is kept as a draft: ${message}`,
          ...problems.map(problemLine),
        ].join('\n'),
        problems,
      )
    }
    const who =
      published.visibility === 'public'
        ? 'listed for everyone'
        : published.visibility === 'private'
          ? 'only for the user’s own computers'
          : 'unlisted, for the people who have it'
    if (published.held !== undefined) {
      const stays = published.current
        ? `${published.current} stays listed`
        : 'Nothing of it is listed yet'
      this.deps.settle(caller.sessionId, entryId, {
        kind: 'published',
        listingId: published.id,
        handle: published.handle,
        version: published.held,
        held: true,
      })
      return {
        content: [
          {
            type: 'text',
            text:
              `Not published yet: ${listingName(published)} ${published.held} is held for review ` +
              `before it lists, and ${stays}. Tell the user it waits for review; Marketplace › ` +
              'Published shows where it stands. Do not publish it again.',
          },
        ],
        structuredContent: {
          published: false,
          held: true,
          listing: listingName(published),
          id: published.id,
          version: published.held,
          visibility: published.visibility,
          current: published.current,
        },
      }
    }
    this.deps.settle(caller.sessionId, entryId, {
      kind: 'published',
      listingId: published.id,
      handle: published.handle,
      version: manifest.version,
    })
    return {
      content: [
        {
          type: 'text',
          text: `Published ${listingName(published)} ${plan.version}, ${who}.`,
        },
      ],
      structuredContent: {
        published: true,
        listing: listingName(published),
        id: published.id,
        version: plan.version,
        visibility: published.visibility,
      },
    }
  }

  /** What a card or the folder dialog asks the user; null for a folder that is nothing to publish. */
  private async askOf(
    plan: Plan,
    visibility: PublishVisibility | null,
    notes: string | null,
    from: { fromTask: string | null; changes: string | null } | null = null,
  ): Promise<MarketAsk | null> {
    const { check, listing } = plan
    if (!check.kind || !check.slug || !check.name) return null
    const account = this.deps.account()
    return {
      ...(check.kind === 'workflow' ? await this.workflowOf(check, from) : {}),
      ...(check.plugin ? this.pluginOf(plan) : {}),
      action: 'publish',
      item: {
        name: check.name,
        slug: check.slug,
        kind: check.kind,
        harness: null,
        description: check.description ?? '',
      },
      listingId: listing?.id ?? null,
      version: plan.version,
      previous: listing?.current ?? null,
      installs: listing?.installs.total ?? 0,
      visibility: listing?.visibility ?? visibility ?? 'public',
      notes,
      adds: check.adds,
      runs: check.runs,
      manifest: check.manifest,
      folder: plan.folder,
      files: check.files.map((file) => ({ path: file.path, size: file.size })),
      bytes: check.bytes,
      changes: listing ? await this.changes(listing, check) : null,
      publisher:
        !plan.mine || plan.mine.publisher || !account
          ? null
          : { suggested: suggestHandle(account) },
    }
  }

  /** What a Kettu plugin's card adds: its script, what an install leaves out, and a conversion. */
  private pluginOf(plan: Plan): Pick<MarketAsk, 'plugin' | 'converted'> {
    const contents = plan.check.plugin!
    const converted = this.deps.converter.conversionOf(plan.target)
    return {
      plugin: {
        script: contents.script,
        permissions: contents.permissions,
        notes: contents.warnings,
      },
      ...(converted ? { converted } : {}),
    }
  }

  /**
   * A workflow's flowchart for its card, and, when it generalizes the workflow a task ran on,
   * what the card compares; a task Kettu does not have leaves that out.
   */
  private async workflowOf(
    check: FolderCheck,
    from: { fromTask: string | null; changes: string | null } | null,
  ): Promise<Pick<MarketAsk, 'workflow' | 'fromTask'>> {
    const file = check.files.find((f) => f.path === 'workflow.yaml')
    const after = file?.data.toString('utf8') ?? null
    const workflow = after === null ? null : parseWorkflow(after).workflow
    if (!workflow) return {}
    const taskId = from?.fromTask ?? null
    const task = taskId ? await this.deps.taskWorkflow?.(taskId).catch(() => null) : null
    const before = task ? parseWorkflow(task.text).workflow : null
    if (!task || !before || !taskId) return { workflow }
    return {
      workflow,
      fromTask: {
        taskId,
        title: task.title,
        sameFlow: sameFlow(before, workflow),
        changes: from?.changes ?? null,
        before: task.text,
        after: after!,
      },
    }
  }

  /** The manifest of a plan with no problems. */
  private manifestOf(
    plan: Plan,
    visibility: PublishVisibility | null,
    notes: string | null,
    from: { agent?: string; session?: string },
  ): PublishManifest {
    const { check, listing } = plan
    return {
      slug: check.slug!,
      name: check.name!,
      kind: check.kind!,
      description: check.description ?? '',
      ...(check.about ? { about: check.about } : {}),
      version: plan.version!,
      ...(notes ? { notes } : {}),
      ...(listing ? {} : { visibility: visibility ?? 'public' }),
      ...(check.server ? { server: check.server } : {}),
      ...(check.adds.length > 0 ? { adds: check.adds } : {}),
      ...from,
    }
  }

  private async keepDraft(
    plan: Plan,
    manifest: PublishManifest,
    rest: Pick<NewDraft, 'sessionId' | 'sessionTitle' | 'agentId' | 'error' | 'problems'>,
  ): Promise<void> {
    await this.deps.drafts.put({
      path: plan.check.path,
      manifest,
      listingId: plan.listing?.id ?? null,
      ...rest,
    })
    this.deps.changed()
  }

  /** Sends the version; once the service has it, its folder and session are kept with it. */
  private async upload(
    plan: Plan,
    manifest: PublishManifest,
    sessionId: string | null,
  ): Promise<PublishResult> {
    const published = await this.deps.call({
      kind: 'publish',
      manifest,
      files: plan.check.files.map((file) => ({
        path: file.path,
        data: file.data.toString('base64'),
      })),
    })
    await this.deps.drafts.published(plan.check.path, {
      listingId: published.id,
      version: published.held ?? manifest.version,
      sessionId,
      path: plan.target,
    })
    this.deps.changed()
    return published
  }

  /** Who asked, as the version history shows it. */
  private from(sessionId: string): { agent?: string; session?: string } {
    const agent = this.deps.agentOf(sessionId)
    const session = this.deps.sessionTitle(sessionId)
    return {
      ...(agent ? { agent: agent.split('~')[0]! } : {}),
      ...(session ? { session } : {}),
    }
  }

  /** The files of a new version against the listing's current one; null when not comparable. */
  private async changes(
    listing: MineListing,
    check: FolderCheck,
  ): Promise<MarketPublishChange[] | null> {
    const current = listing.current
    if (!current) return null
    try {
      const old = await this.deps.call({ kind: 'version', id: listing.id, version: current })
      if (check.kind === 'mcp-server' && check.files.length === 0) {
        return stable(old.server ?? null) === stable(check.server)
          ? []
          : [{ path: 'server.json', status: 'changed', added: null, removed: null }]
      }
      const before = new Map(old.files.map((file) => [file.path, file]))
      const out: MarketPublishChange[] = []
      let compared = 0
      for (const file of check.files) {
        const was = before.get(file.path)
        before.delete(file.path)
        if (!was) {
          const added = file.text ? lineList(file.data.toString('utf8')).length : null
          out.push({ path: file.path, status: 'added', added, removed: null })
          continue
        }
        if (was.sha256 === file.sha256) continue
        let lines: { added: number; removed: number } | null = null
        if (comparable(file, was.size) && compared < COMPARE_FILES) {
          compared++
          lines = await this.lines(listing.id, current, file)
        }
        out.push({
          path: file.path,
          status: 'changed',
          added: lines?.added ?? null,
          removed: lines?.removed ?? null,
        })
      }
      for (const was of before.values()) {
        out.push({ path: was.path, status: 'removed', added: null, removed: null })
      }
      return out
    } catch (error) {
      if (error instanceof MarketCallError) return null
      throw error
    }
  }

  private async lines(
    id: string,
    version: string,
    file: CheckedFile,
  ): Promise<{ added: number; removed: number } | null> {
    try {
      const old = await this.deps.call({ kind: 'file', id, version, path: file.path })
      return lineChanges(
        Buffer.from(old.data, 'base64').toString('utf8'),
        file.data.toString('utf8'),
      )
    } catch (error) {
      if (error instanceof MarketCallError) return null
      throw error
    }
  }

  private async mine(): Promise<CallToolResult> {
    const mine = await this.deps.call({ kind: 'mine' })
    const drafts = this.deps.drafts.list()
    const listings = mine.listings.map((listing) => ({
      id: listing.id,
      listing: listingName(listing),
      name: listing.name,
      kind: listing.kind,
      ...(listing.harness ? { harness: listing.harness } : {}),
      visibility: listing.visibility,
      current: listing.current,
      versions: listing.versions.map((v) => ({
        version: v.version,
        status: v.status,
        publishedAt: v.publishedAt,
        ...(v.refusal ? { refusal: v.refusal } : {}),
      })),
      installs: { total: listing.installs.total, week: listing.installs.week },
      takenDown: listing.takenDown,
    }))
    const lines =
      listings.length === 0
        ? ['The user has published nothing to the Kettu Marketplace yet.']
        : listings.map(
            (l, i) =>
              `${l.listing} (${l.id}): ${l.name}, ${l.kind}, ${l.visibility}, version ${l.current ?? 'none live'}, ${l.installs.total} installs${l.takenDown ? ', taken down' : ''}${reviewText(mine.listings[i]!)}`,
          )
    if (drafts.length > 0) {
      lines.push(
        'Drafts not published yet:',
        ...drafts.map(
          (d) =>
            `- ${d.manifest.name} ${d.manifest.version} from ${d.path}${d.error ? `, refused: ${d.error}` : ''}`,
        ),
      )
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        publisher: mine.publisher?.handle ?? null,
        listings,
        drafts: drafts.map((d) => ({
          name: d.manifest.name,
          kind: d.manifest.kind,
          version: d.manifest.version,
          path: d.path,
          error: d.error,
        })),
      },
    }
  }

  private async unlist(caller: Caller, input: unknown, deadline: number): Promise<CallToolResult> {
    const o = fields(input, ['listing'])
    const ref = text(o, 'listing', LISTING_REF_CHARS, true)!
    const waiting = this.jobOf(caller.sessionId, 'unlist', ref)
    if (waiting) return this.follow(caller.sessionId, waiting, deadline)
    const mine = await this.deps.call({ kind: 'mine' })
    const listing =
      mine.listings.find(
        (l) => l.id === ref || listingName(l) === ref || `${l.handle}/${l.slug}` === ref,
      ) ?? null
    if (!listing) {
      throw new Refusal(
        'not_found',
        `The user has no listing ${ref}. Call marketplace_mine for them.`,
      )
    }
    // Another call, perhaps naming it another way, may have opened its card meanwhile.
    const opened = this.jobOf(caller.sessionId, 'unlist', listing.id)
    if (opened) return this.follow(caller.sessionId, opened, deadline)
    if (listing.visibility === 'unlisted') {
      throw new Refusal('refused', `${listingName(listing)} is unlisted already.`)
    }
    const asked = this.deps.ask(caller.sessionId, {
      action: 'unlist',
      item: {
        name: listing.name,
        slug: listing.slug,
        kind: listing.kind,
        harness: listing.harness ?? null,
        description: listing.description,
      },
      listingId: listing.id,
      version: null,
      previous: listing.current,
      installs: listing.installs.total,
      visibility: listing.visibility,
      notes: null,
      adds: [],
      runs: [],
      manifest: null,
      folder: '',
      files: [],
      bytes: 0,
      changes: null,
      publisher: null,
    })
    if (!asked) throw new Refusal('not_found', 'This session is not open, so it shows no card.')
    const refs = [listing.id, listingName(listing), `${listing.handle}/${listing.slug}`]
    const job = this.open(
      caller.sessionId,
      'unlist',
      refs,
      listingName(listing),
      asked.answer,
      (answer) => this.unlistAnswered(caller, listing, asked.entryId, answer),
    )
    return this.follow(caller.sessionId, job, deadline)
  }

  /** Unlists what the user confirmed. */
  private async unlistAnswered(
    caller: Caller,
    listing: MineListing,
    entryId: string,
    answer: MarketAnswer,
  ): Promise<CallToolResult> {
    if (answer.decision !== 'confirm') {
      return {
        content: [
          {
            type: 'text',
            text:
              answer.decision === 'later'
                ? `The user chose Not now; ${listingName(listing)} stays listed.`
                : `The user did not answer; ${listingName(listing)} stays listed.`,
          },
        ],
        structuredContent: { unlisted: false },
      }
    }
    try {
      await this.deps.call({ kind: 'update', id: listing.id, change: { visibility: 'unlisted' } })
    } catch (error) {
      if (!(error instanceof MarketCallError)) throw error
      const message = serviceText(error.failure)
      this.deps.settle(caller.sessionId, entryId, {
        kind: 'failed',
        message: userText(error.failure),
        problems: [],
      })
      throw new Refusal('refused', `The Kettu Marketplace did not unlist it: ${message}`)
    }
    this.deps.settle(caller.sessionId, entryId, { kind: 'unlisted' })
    this.deps.changed()
    return {
      content: [
        {
          type: 'text',
          text: `Unlisted ${listingName(listing)}. People who have it keep it and its updates.`,
        },
      ],
      structuredContent: { unlisted: true, listing: listingName(listing) },
    }
  }

  private jobOf(sessionId: string, action: CardJob['action'], ref: string): CardJob | null {
    return (
      this.jobs.get(sessionId)?.find((job) => job.action === action && job.refs.includes(ref)) ??
      null
    )
  }

  /** Follows a card past the call that opened it: what comes of its answer waits for a call. */
  private open(
    sessionId: string,
    action: CardJob['action'],
    refs: string[],
    name: string,
    answer: Promise<MarketAnswer>,
    then: (answer: MarketAnswer) => Promise<CallToolResult>,
  ): CardJob {
    const job: CardJob = {
      action,
      refs,
      name,
      confirmed: false,
      ended: false,
      result: null!,
      turn: 0,
      waiting: 0,
      came: null,
      told: false,
    }
    job.result = answer.then((given) => {
      job.confirmed = given.decision === 'confirm'
      job.ended = given.decision === 'ended'
      return then(given)
    })
    // Before any call's, so a call still waiting is counted when the outcome lands.
    job.result.then(
      (result) => this.came(sessionId, job, resultText(result)),
      (error: unknown) => this.came(sessionId, job, (error as Error).message),
    )
    this.jobs.set(sessionId, [...(this.jobs.get(sessionId) ?? []), job])
    return job
  }

  /**
   * The card has an outcome: a waiting call takes it; else the session is told now if the turn
   * that opened it ended, or when it ends.
   */
  private came(sessionId: string, job: CardJob, text: string): void {
    job.came = text
    if (job.waiting === 0 && job.turn > 0) this.tell(sessionId, job)
  }

  private tell(sessionId: string, job: CardJob): void {
    if (job.told || job.came === null) return
    job.told = true
    if (job.ended) return this.done(sessionId, job)
    const card = job.action === 'publish' ? 'publish' : 'unlist'
    this.deps.tell(
      sessionId,
      `What became of the card to ${card} ${job.name}, which an earlier turn of yours opened: ` +
        job.came,
    )
  }

  /** The card's outcome once it has one, or by the deadline that the user has not answered yet. */
  private async follow(sessionId: string, job: CardJob, deadline: number): Promise<CallToolResult> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()))
    })
    const turn = job.turn
    job.waiting++
    // A call whose turn ended meanwhile hands its outcome to no one, so the session is told it.
    const taken = () => job.turn === turn && !job.told
    try {
      const result = await Promise.race([job.result, late])
      if (result === null) return stillWaiting(job)
      if (taken()) this.done(sessionId, job)
      return result
    } catch (error) {
      if (taken()) this.done(sessionId, job)
      throw error
    } finally {
      if (job.turn === turn) job.waiting--
      clearTimeout(timer)
    }
  }

  private done(sessionId: string, job: CardJob): void {
    const left = (this.jobs.get(sessionId) ?? []).filter((other) => other !== job)
    if (left.length > 0) this.jobs.set(sessionId, left)
    else this.jobs.delete(sessionId)
  }
}

function resultText(result: CallToolResult): string {
  return result.content.flatMap((item) => (item.type === 'text' ? [item.text] : [])).join('\n')
}

/** A call that returns before the card's outcome, for the agent to call again. */
function stillWaiting(job: CardJob): CallToolResult {
  const publish = job.action === 'publish'
  const again = publish
    ? 'Call marketplace_publish again with the same path'
    : 'Call marketplace_unlist again with the same listing'
  const text = job.confirmed
    ? publish
      ? `The user pressed Publish and ${job.name} is uploading. ${again} for the outcome.`
      : `The user confirmed, and ${job.name} is being unlisted. ${again} for the outcome.`
    : publish
      ? `The user has not answered the card to publish ${job.name} yet, and nothing was uploaded. ${again} to keep waiting on the same card; it shows no second one.`
      : `The user has not answered the card to unlist ${job.name} yet, and it stays listed. ${again} to keep waiting on the same card; it shows no second one.`
  return {
    content: [
      { type: 'text', text: `${text} If your turn ends first, Kettu tells you the outcome.` },
    ],
    structuredContent: { waiting: true, confirmed: job.confirmed },
  }
}

/**
 * The version a draft keeps: a skill's or a workflow's, which Kettu chose; the others' manifests
 * say theirs.
 */
function draftVersion(draft: PublishDraft | null): string | null {
  return draft && numbered(draft.manifest.kind) ? draft.manifest.version : null
}

/** A workflow's steps, those that wait for the user and the tools they name, for the agent. */
function workflowLines(adds: readonly PublishAdds[]): string[] {
  const of = (label: string) => adds.find((group) => group.label === label)?.items ?? []
  const lines = [`Steps: ${of('steps').join(' → ')}.`]
  if (of('waits').length > 0) lines.push(`Waits for the user at: ${of('waits').join(', ')}.`)
  const tools = [...of('servers'), ...of('skills')]
  if (tools.length > 0) lines.push(`Names the MCP servers and Skills: ${tools.join(', ')}.`)
  return lines
}

/** A plugin's script with its permissions, and what an install would leave out, for the agent. */
function pluginLines(plugin: NonNullable<FolderCheck['plugin']>): string[] {
  const lines: string[] = []
  if (plugin.script) {
    lines.push(
      `Runs a script, ${plugin.script.entry}, with ${
        plugin.permissions.length > 0
          ? `the permissions ${plugin.permissions.join(', ')}`
          : 'no permissions'
      }. Only Kettu’s own publisher may publish a plugin with a script for now.`,
    )
  }
  if (plugin.warnings.length > 0) {
    lines.push('An install leaves out:', ...plugin.warnings.map((warning) => `- ${warning}`))
  }
  return lines
}

/** What a conversion made, carried over and left out, for the agent. */
function convertedLines({ path: folder, name, conversion }: PluginConverted): string[] {
  const lines = [`Converted to the Kettu plugin "${name}", written to ${folder}.`]
  const carried = conversion.carried.map((group) => `${group.items.length} ${group.label}`)
  lines.push(
    carried.length > 0 ? `Carried over: ${carried.join(', ')}.` : 'Nothing was carried over.',
  )
  if (conversion.leftOut.length > 0) {
    lines.push(
      'Left out:',
      ...conversion.leftOut.map(({ kind, name: item, message }) => `- ${kind} ${item}: ${message}`),
    )
  }
  if (conversion.notes.length > 0) {
    lines.push(
      'Changed on the way:',
      ...conversion.notes.map(
        ({ name: item, message }) => `- ${item ? `${item}: ` : ''}${message}`,
      ),
    )
  }
  lines.push(
    'The original folder was not changed. Check the new folder with marketplace_check, then ' +
      'publish it if the user asks; the card shows them what came over and what did not.',
  )
  return lines
}

/** The versions of a listing that wait for review or were not approved, for a line about it. */
function reviewText(listing: MineListing): string {
  return reviewVersions(listing)
    .map((v) =>
      v.status === 'held'
        ? `, ${v.version} held for review, not listed yet`
        : `, ${v.version} not approved${v.refusal ? `: ${v.refusal.reason}` : ''}`,
    )
    .join('')
}

function comparable(file: CheckedFile, oldSize: number): boolean {
  return file.text && file.size <= COMPARE_BYTES && oldSize <= COMPARE_BYTES
}

function problemLine(problem: MarketProblem): string {
  return problem.path ? `- ${problem.path}: ${problem.message}` : `- ${problem.message}`
}

/** A service's failure as an agent reads it. */
function serviceText(failure: MarketFailure): string {
  switch (failure.code) {
    case 'signed_out':
    case 'unauthorized':
      return 'This computer is not signed in to a Kettu account, or Kettu’s cloud services are off.'
    case 'storage_full':
      return 'The account’s cloud storage is full, which a listing for only the user counts against.'
    case 'too_many_listings':
      return 'The account has as many listings as it may have.'
    case 'rate_limited':
      return 'Too many versions were published in the last hour. Try again later.'
    default:
      return failure.message
  }
}

const USER_TEXT = new Set([
  'script_not_allowed',
  'kind_closed',
  'signed_out',
  'unauthorized',
  'storage_full',
  'too_many_listings',
  'rate_limited',
  'last_version',
  'handle_taken',
  'taken_down',
  'version_exists',
  'no_publisher',
  'not_found',
  'check_failed',
  'conflict',
])

/** A service's failure in the user's language: by its code when Kettu knows it, else as it said. */
export function userText(failure: MarketFailure): string {
  if (failure.code === 'network') return t('marketPublish.failure.network')
  if (!USER_TEXT.has(failure.code)) return failure.message
  return (t as (key: string) => string)(`marketPublish.failure.${failure.code}`)
}

/** A service's failure as the window gets it, with its code and problems. */
export function hostFailure(failure: MarketFailure): HostError {
  const data = { code: failure.code, problems: failure.problems ?? [] }
  const message = userText(failure)
  switch (failure.code) {
    case 'signed_out':
    case 'unauthorized':
      return new HostError('auth_required', message, data)
    case 'check_failed':
    case 'invalid_request':
      return new HostError('invalid_params', message, data)
    case 'not_found':
      return new HostError('not_found', message, data)
    case 'handle_taken':
    case 'version_exists':
    case 'last_version':
    case 'conflict':
      return new HostError('conflict', message, data)
    default:
      return new HostError('unavailable', message, data)
  }
}

function failed(code: string, message: string, problems: MarketProblem[]): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: {
      code,
      message,
      ...(problems.length > 0 ? { problems: forAgent(problems) } : {}),
    },
    isError: true,
  }
}
