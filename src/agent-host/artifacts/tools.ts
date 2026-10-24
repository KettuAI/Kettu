// The seven tools of the artifacts service: what agents are told, the schemas, the checks and the
// limits, and the store calls behind them. See docs/design/artifacts.md, The artifacts service.

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { ARTIFACT_ID, ARTIFACT_TITLE_CHARS, longer } from '@shared/artifacts'
import { countPages } from './pages'
import { ArtifactError, type ArtifactStore, type Editor } from './store'

export const HTML_BYTES = 5 * 1024 * 1024
export const NOTE_CHARS = 200
export const EDITS = 50
export const WRITES_PER_MINUTE = 60
const QUERY_CHARS = 200
const LIST_LIMIT = 200
const LIST_DEFAULT = 50
const MINUTE_MS = 60_000
const MIB = 1024 * 1024

const CDNS =
  'cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com, esm.sh, cdn.tailwindcss.com, ' +
  'fonts.googleapis.com and fonts.gstatic.com'

const FORMAT =
  `An artifact is one self-contained HTML file: inline its styles and scripts, or load them from ` +
  `${CDNS}; nothing else loads, files beside it included. ` +
  'For several pages in one file, such as design options or slides, put each page in its own ' +
  'element with a data-page attribute that names it and a data-page-size attribute that gives ' +
  'its size in CSS pixels, such as `<section data-page="Sign in · A" data-page-size="390x844">`, ' +
  'as children of `<body>` or of a `<div data-page-group="Group name">` child of `<body>`; each ' +
  'group becomes a row. Write the page elements in the markup, not from a script.'

/** The service's `instructions`, which an agent reads when it connects. */
export const INSTRUCTIONS =
  'OverBench shows artifacts to the user: HTML pages for them to look at, such as reports, slide ' +
  'decks, design options and prototypes. Use create_artifact for a page the user should see, not ' +
  `for files of the project you are working on. ${FORMAT} To change an artifact, read it, then ` +
  'call update_artifact with the version you read; if it changed since, read it again.'

export type ToolErrorCode =
  'not_found' | 'deleted' | 'conflict' | 'edit_not_found' | 'too_large' | 'invalid' | 'rate_limited'

/** A refusal, returned as a tool error whose text says what to do next. */
export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ToolError'
  }
}

/** The session a call is from, and its project or scratch folder: all it reaches. */
export interface Caller {
  sessionId: string
  project: string
}

export interface ArtifactToolsDeps {
  store: ArtifactStore
  /** A session's title, null for one without a title, or undefined for one OverBench forgot. */
  sessionTitle(sessionId: string): string | null | undefined
  /**
   * The session's running turn, compared by identity, so that what it writes counts as editing
   * only while that same turn runs. Null between turns.
   */
  runningTurn(sessionId: string): object | null
  now?: () => number
}

// Schemas.

type Schema = Record<string, unknown>

const ID: Schema = {
  type: 'string',
  pattern: ARTIFACT_ID.source,
  description: 'The artifact id, such as art_01J9Z3K4V5W6X7Y8Z9A0B1C2D3.',
}
const VERSION: Schema = { type: 'integer', minimum: 1 }
const TITLE: Schema = {
  type: 'string',
  minLength: 1,
  maxLength: ARTIFACT_TITLE_CHARS,
  description: 'Shown on its card and in its viewer.',
}
const HTML: Schema = {
  type: 'string',
  description: 'The whole page, at most 5 MiB of UTF-8.',
}
const NOTE: Schema = {
  type: 'string',
  maxLength: NOTE_CHARS,
  description: 'One line on what this version changes, shown in its history.',
}
const TIME: Schema = { type: 'string', format: 'date-time' }
const PAGES: Schema = {
  type: 'integer',
  minimum: 0,
  description: 'The pages it marks with data-page; two or more make it a canvas.',
}

interface ObjectSchema {
  [key: string]: unknown
  type: 'object'
  properties: Record<string, Schema>
  required: string[]
}

function object(properties: Record<string, Schema>, required: string[] = []): ObjectSchema {
  return { type: 'object', properties, required, additionalProperties: false }
}

const ERROR_CODES: ToolErrorCode[] = [
  'not_found',
  'deleted',
  'conflict',
  'edit_not_found',
  'too_large',
  'invalid',
  'rate_limited',
]

// The message too, since the agents give the model the structured value rather than the text.
const ERROR = object({ code: { type: 'string', enum: ERROR_CODES }, message: { type: 'string' } }, [
  'code',
  'message',
])

/** A result is the tool's value, or the code of a tool error, which its text explains. */
function output(properties: Record<string, Schema>): Tool['outputSchema'] {
  return { type: 'object', anyOf: [object(properties, Object.keys(properties)), ERROR] }
}

const ON_ARTIFACTS = { openWorldHint: false } as const

export const TOOLS: Tool[] = [
  {
    name: 'create_artifact',
    title: 'Create artifact',
    description:
      'Makes a new artifact, an HTML page OverBench shows the user, at version 1. ' +
      `${FORMAT} Returns its id, which update_artifact and read_artifact take.`,
    inputSchema: object({ title: TITLE, html: HTML, note: NOTE }, ['title', 'html']),
    outputSchema: output({ id: ID, version: VERSION, pages: PAGES }),
    annotations: { ...ON_ARTIFACTS, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'read_artifact',
    title: 'Read artifact',
    description:
      'Returns the HTML of an artifact in this project, of its latest version or of the one ' +
      'asked for, with its title and its latest version (head).',
    inputSchema: object(
      {
        id: ID,
        version: { ...VERSION, description: 'The version to read; the latest by default.' },
      },
      ['id'],
    ),
    outputSchema: output({
      id: ID,
      title: TITLE,
      version: VERSION,
      head: VERSION,
      pages: PAGES,
      updated_at: TIME,
      html: HTML,
    }),
    annotations: { ...ON_ARTIFACTS, readOnlyHint: true },
  },
  {
    name: 'update_artifact',
    title: 'Update artifact',
    description:
      'Changes an artifact in this project. Give html to replace the page, or edits to replace ' +
      'parts of it, as a new version from base_version, the version you read; a stale ' +
      'base_version is refused, and you read it again. Each edit replaces old_text, which must ' +
      'occur exactly once in the HTML as the edits before it left it. Or give a title alone to ' +
      'rename it, which makes no version.',
    inputSchema: object(
      {
        id: ID,
        base_version: {
          ...VERSION,
          description: 'The version your change starts from; needed with html or edits.',
        },
        html: HTML,
        edits: {
          type: 'array',
          minItems: 1,
          maxItems: EDITS,
          items: object(
            {
              old_text: { type: 'string', minLength: 1 },
              new_text: { type: 'string' },
            },
            ['old_text', 'new_text'],
          ),
          description: `Up to ${EDITS} text replacements, applied in order.`,
        },
        title: TITLE,
        note: NOTE,
      },
      ['id'],
    ),
    outputSchema: output({ id: ID, version: VERSION, pages: PAGES }),
    annotations: { ...ON_ARTIFACTS, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'list_artifacts',
    title: 'List artifacts',
    description:
      'Lists the artifacts of this project, newest first, without those the user deleted.',
    inputSchema: object({
      query: {
        type: 'string',
        maxLength: QUERY_CHARS,
        description: 'Keeps the artifacts whose title contains it, ignoring case and accents.',
      },
      limit: { type: 'integer', minimum: 1, maximum: LIST_LIMIT, default: LIST_DEFAULT },
    }),
    outputSchema: output({
      artifacts: {
        type: 'array',
        items: object(
          {
            id: ID,
            title: TITLE,
            version: VERSION,
            pages: PAGES,
            updated_at: TIME,
            session: {
              type: 'string',
              description: 'The title of the session it shows under, or "user".',
            },
          },
          ['id', 'title', 'version', 'pages', 'updated_at', 'session'],
        ),
      },
    }),
    annotations: { ...ON_ARTIFACTS, readOnlyHint: true },
  },
  {
    name: 'delete_artifact',
    title: 'Delete artifact',
    description:
      'Moves an artifact of this project to Recently deleted, where the user can restore it ' +
      'for 30 days.',
    inputSchema: object({ id: ID }, ['id']),
    outputSchema: output({ id: ID, purge_at: TIME }),
    annotations: { ...ON_ARTIFACTS, destructiveHint: true, idempotentHint: true },
  },
  {
    name: 'list_artifact_versions',
    title: 'List artifact versions',
    description: 'Lists every version of an artifact in this project, newest first.',
    inputSchema: object({ id: ID }, ['id']),
    outputSchema: output({
      versions: {
        type: 'array',
        items: object(
          {
            version: VERSION,
            created_at: TIME,
            author: {
              type: 'string',
              description: 'The title of the session that wrote it, or "user".',
            },
            note: { type: ['string', 'null'] },
            size: { type: 'integer', description: 'Bytes of UTF-8.' },
          },
          ['version', 'created_at', 'author', 'note', 'size'],
        ),
      },
    }),
    annotations: { ...ON_ARTIFACTS, readOnlyHint: true },
  },
  {
    name: 'restore_artifact_version',
    title: 'Restore artifact version',
    description:
      'Copies an earlier version of an artifact in this project as its new latest version, ' +
      'from base_version, the latest version you know of.',
    inputSchema: object(
      {
        id: ID,
        version: { ...VERSION, description: 'The version to restore.' },
        base_version: VERSION,
      },
      ['id', 'version', 'base_version'],
    ),
    outputSchema: output({ id: ID, version: VERSION }),
    annotations: { ...ON_ARTIFACTS, destructiveHint: false, idempotentHint: false },
  },
]

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name))

export function isToolName(name: string): boolean {
  return TOOL_NAMES.has(name)
}

// Arguments, checked as the schemas say.

type Args = Record<string, unknown>

function args(value: unknown, allowed: readonly string[]): Args {
  const o = value ?? {}
  if (typeof o !== 'object' || Array.isArray(o)) throw invalid('The arguments must be an object.')
  for (const key of Object.keys(o)) {
    if (!allowed.includes(key)) throw invalid(`Unknown argument ${key}.`)
  }
  return o as Args
}

function invalid(message: string): ToolError {
  return new ToolError('invalid', message)
}

function id(o: Args): string {
  const value = o.id
  if (typeof value !== 'string' || !ARTIFACT_ID.test(value)) {
    throw invalid('id must be an artifact id, such as art_01J9Z3K4V5W6X7Y8Z9A0B1C2D3.')
  }
  return value
}

function wholeNumber(o: Args, key: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const value = o[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalid(
      max === Number.MAX_SAFE_INTEGER
        ? `${key} must be a whole number from ${min}.`
        : `${key} must be a whole number from ${min} to ${max}.`,
    )
  }
  return value
}

function optionalNumber(o: Args, key: string, min: number, max?: number): number | undefined {
  return o[key] === undefined ? undefined : wholeNumber(o, key, min, max)
}

function title(o: Args): string {
  const value = o.title
  if (typeof value !== 'string' || value.length === 0 || longer(value, ARTIFACT_TITLE_CHARS)) {
    throw invalid(`title must be 1 to ${ARTIFACT_TITLE_CHARS} characters.`)
  }
  if (value.trim() === '') throw invalid('title must not be blank.')
  return value
}

function note(o: Args): string | null {
  const value = o.note
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || longer(value, NOTE_CHARS)) {
    throw invalid(`note must be at most ${NOTE_CHARS} characters.`)
  }
  return value.trim() === '' ? null : value
}

function html(o: Args): string {
  const value = o.html
  if (typeof value !== 'string') throw invalid('html must be a string.')
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes > HTML_BYTES) throw tooLarge(bytes)
  return value
}

function tooLarge(bytes: number): ToolError {
  const size = (Math.max(bytes, HTML_BYTES + 1) / MIB).toFixed(1)
  return new ToolError(
    'too_large',
    `The HTML is ${size} MiB; an artifact holds at most 5 MiB. Move images to a CDN or shrink them.`,
  )
}

interface Edit {
  oldText: string
  newText: string
}

function edits(o: Args): Edit[] {
  const value = o.edits
  if (!Array.isArray(value) || value.length === 0 || value.length > EDITS) {
    throw invalid(`edits must be a list of 1 to ${EDITS} edits.`)
  }
  return value.map((item: unknown, i) => {
    const edit = args(item, ['old_text', 'new_text'])
    if (typeof edit.old_text !== 'string' || edit.old_text.length === 0) {
      throw invalid(`Edit ${i + 1}: old_text must be text that is not empty.`)
    }
    if (typeof edit.new_text !== 'string') throw invalid(`Edit ${i + 1}: new_text must be text.`)
    return { oldText: edit.old_text, newText: edit.new_text }
  })
}

/** Applies the edits in order; each `oldText` must occur exactly once in what came before. */
export function applyEdits(source: string, list: readonly Edit[]): string {
  let text = source
  list.forEach((edit, i) => {
    const at = text.indexOf(edit.oldText)
    if (at < 0) {
      throw new ToolError(
        'edit_not_found',
        `Edit ${i + 1}: old_text does not occur in the HTML` +
          `${i > 0 ? ' as the edits before it left it' : ''}. ` +
          'Read the artifact again and copy the text exactly.',
      )
    }
    if (text.indexOf(edit.oldText, at + 1) >= 0) {
      let count = 0
      for (let from = 0; ; count++) {
        const next = text.indexOf(edit.oldText, from)
        if (next < 0) break
        from = next + edit.oldText.length
      }
      throw new ToolError(
        'edit_not_found',
        `Edit ${i + 1}: old_text occurs ${Math.max(count, 2)} times. ` +
          'Include more of the surrounding text.',
      )
    }
    text = text.slice(0, at) + edit.newText + text.slice(at + edit.oldText.length)
  })
  return text
}

/** Lowercase, without accents, for matching titles. */
function folded(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function pagesText(pages: number): string {
  return pages >= 2 ? `a canvas of ${pages} pages` : 'a single page'
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

// Results.

function result(text: string, value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: value }
}

function failure(error: ToolError): CallToolResult {
  return {
    content: [{ type: 'text', text: error.message }],
    structuredContent: { code: error.code, message: error.message },
    isError: true,
  }
}

export class ArtifactTools {
  /** When each session's latest writes were made, for the rate limit. */
  private readonly writes = new Map<string, number[]>()

  constructor(private readonly deps: ArtifactToolsDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** Serves a call; a refusal becomes a tool error, anything else a failure of the request. */
  async call(caller: Caller, name: string, input: unknown): Promise<CallToolResult> {
    try {
      return await this.run(caller, name, input)
    } catch (error) {
      if (error instanceof ToolError) return failure(error)
      if (error instanceof ArtifactError) return failure(await this.refusal(caller, error, input))
      throw error
    }
  }

  private run(caller: Caller, name: string, input: unknown): Promise<CallToolResult> {
    switch (name) {
      case 'create_artifact':
        return this.create(caller, args(input, ['title', 'html', 'note']))
      case 'read_artifact':
        return this.read(caller, args(input, ['id', 'version']))
      case 'update_artifact':
        return this.update(
          caller,
          args(input, ['id', 'base_version', 'html', 'edits', 'title', 'note']),
        )
      case 'list_artifacts':
        return this.list(caller, args(input, ['query', 'limit']))
      case 'delete_artifact':
        return this.delete(caller, args(input, ['id']))
      case 'list_artifact_versions':
        return this.versions(caller, args(input, ['id']))
      case 'restore_artifact_version':
        return this.restore(caller, args(input, ['id', 'version', 'base_version']))
      default:
        throw new Error(`Unknown tool ${name}`)
    }
  }

  /** Runs a write as one of the session's 60 a minute; a write that fails gives its slot back. */
  private async limited<T>(caller: Caller, write: () => Promise<T>): Promise<T> {
    const at = this.allowWrite(caller)
    try {
      return await write()
    } catch (error) {
      const recent = this.writes.get(caller.sessionId) ?? []
      const i = recent.indexOf(at)
      if (i >= 0) recent.splice(i, 1)
      throw error
    }
  }

  /** Takes a slot as the write starts, so calls that run at once all count; 60 a minute. */
  private allowWrite(caller: Caller): number {
    const now = this.now()
    const recent = (this.writes.get(caller.sessionId) ?? []).filter((at) => at > now - MINUTE_MS)
    this.writes.set(caller.sessionId, recent)
    if (recent.length >= WRITES_PER_MINUTE) {
      const wait = Math.max(1, Math.ceil((recent[0]! + MINUTE_MS - now) / 1000))
      throw new ToolError('rate_limited', `Too many changes in a minute. Wait ${wait} s.`)
    }
    recent.push(now)
    return now
  }

  /** The session left: its writes need no counting. */
  forget(sessionId: string): void {
    this.writes.delete(sessionId)
  }

  /** The session a change counts as editing for, while the turn it was made in runs. */
  private editor(caller: Caller): Editor | undefined {
    const turn = this.deps.runningTurn(caller.sessionId)
    if (turn === null) return undefined
    return {
      session: caller.sessionId,
      current: () => this.deps.runningTurn(caller.sessionId) === turn,
    }
  }

  private sessionName(sessionId: string | null): string {
    if (sessionId === null) return 'user'
    const known = this.deps.sessionTitle(sessionId)
    if (known === undefined) return 'Deleted session'
    return known ?? 'Untitled session'
  }

  /** The text and code for what the store refused. */
  private async refusal(caller: Caller, error: ArtifactError, input: unknown): Promise<ToolError> {
    const o = (typeof input === 'object' && input !== null ? input : {}) as Args
    const artifact = String(o.id ?? 'The artifact')
    switch (error.reason) {
      case 'deleted':
        return new ToolError(
          'deleted',
          `${artifact} was deleted. The user can restore it in OverBench.`,
        )
      case 'conflict': {
        const head = error.state?.version
        return new ToolError(
          'conflict',
          `${artifact} is at version ${head}. Read it again and apply your change to version ${head}.`,
        )
      }
      case 'not_found': {
        if (typeof o.version === 'number' && typeof o.id === 'string') {
          // The artifact may be there without the version asked for.
          const head = await this.deps.store
            .get(o.id, { project: caller.project })
            .then((found) => found.artifact.head)
            .catch(() => null)
          if (head !== null) {
            return new ToolError(
              'not_found',
              `${artifact} has no version ${o.version}; its latest is ${head}. ` +
                'list_artifact_versions shows them.',
            )
          }
        }
        return new ToolError(
          'not_found',
          `No artifact ${artifact} in this project. list_artifacts shows the ones you can use.`,
        )
      }
    }
  }

  private async create(caller: Caller, o: Args): Promise<CallToolResult> {
    const input = { title: title(o), html: html(o), note: note(o) }
    return this.limited(caller, async () => {
      const pages = countPages(input.html)
      const editor = this.editor(caller)
      const { id, version } = await this.deps.store.create({
        ...input,
        project: caller.project,
        sessionId: caller.sessionId,
        pages,
        ...(editor ? { editor } : {}),
      })
      return result(`Created ${id} version ${version}, ${pagesText(pages)}.`, {
        id,
        version,
        pages,
      })
    })
  }

  private async read(caller: Caller, o: Args): Promise<CallToolResult> {
    const artifactId = id(o)
    const version = optionalNumber(o, 'version', 1)
    const read = await this.deps.store.read(artifactId, {
      project: caller.project,
      ...(version === undefined ? {} : { version }),
    })
    const { artifact } = read
    const pages = read.version.pages
    return result(
      `${artifactId}, "${artifact.title}", version ${read.version.version} of ${artifact.head}, ` +
        `${pagesText(pages)}.`,
      {
        id: artifactId,
        title: artifact.title,
        version: read.version.version,
        head: artifact.head,
        pages,
        updated_at: iso(artifact.updatedAt),
        html: read.html,
      },
    )
  }

  private async update(caller: Caller, o: Args): Promise<CallToolResult> {
    const artifactId = id(o)
    const given = ['html', 'edits', 'title'].filter((key) => o[key] !== undefined)
    if (given.length !== 1) {
      throw invalid(
        'Give one of html, edits or title: html or edits for a new version, a title to rename.',
      )
    }
    const { store } = this.deps
    if (o.title !== undefined) {
      // A rename makes no version, so base_version and a note have nothing to apply to.
      const newTitle = title(o)
      const editor = this.editor(caller)
      await this.limited(caller, () =>
        store.rename(artifactId, newTitle, {
          project: caller.project,
          ...(editor ? { editor } : {}),
        }),
      )
      const { version } = await store.get(artifactId, { project: caller.project })
      return result(
        `Renamed ${artifactId} to "${newTitle}"; it stays at version ${version.version}.`,
        {
          id: artifactId,
          version: version.version,
          pages: version.pages,
        },
      )
    }
    if (o.base_version === undefined) throw invalid('base_version is needed with html or edits.')
    const baseVersion = wholeNumber(o, 'base_version', 1)
    const versionNote = note(o)
    const replaced = o.html === undefined ? undefined : html(o)
    const list = replaced === undefined ? edits(o) : []
    return this.limited(caller, async () => {
      let next = replaced
      if (next === undefined) {
        // The version first, so a stale one is refused without reading the HTML.
        const { artifact } = await store.get(artifactId, { project: caller.project })
        if (artifact.head !== baseVersion) {
          throw new ArtifactError('conflict', 'Not the latest version', {
            version: artifact.head,
            deleted: false,
          })
        }
        const base = await store.read(artifactId, { project: caller.project, version: baseVersion })
        next = applyEdits(base.html, list)
        const bytes = Buffer.byteLength(next, 'utf8')
        if (bytes > HTML_BYTES) throw tooLarge(bytes)
      }
      const pages = countPages(next)
      const editor = this.editor(caller)
      const { version } = await store.write({
        id: artifactId,
        baseVersion,
        html: next,
        pages,
        author: caller.sessionId,
        note: versionNote,
        project: caller.project,
        ...(editor ? { editor } : {}),
      })
      return result(`Updated ${artifactId} to version ${version}, ${pagesText(pages)}.`, {
        id: artifactId,
        version,
        pages,
      })
    })
  }

  private async list(caller: Caller, o: Args): Promise<CallToolResult> {
    if (o.query !== undefined && (typeof o.query !== 'string' || longer(o.query, QUERY_CHARS))) {
      throw invalid(`query must be text of at most ${QUERY_CHARS} characters.`)
    }
    const query = typeof o.query === 'string' ? folded(o.query.trim()) : ''
    const limit = optionalNumber(o, 'limit', 1, LIST_LIMIT) ?? LIST_DEFAULT
    const all = await this.deps.store.list({ project: caller.project })
    const matching = query === '' ? all : all.filter((a) => folded(a.title).includes(query))
    const artifacts = matching.slice(0, limit).map((a) => ({
      id: a.id,
      title: a.title,
      version: a.version,
      pages: a.pages,
      updated_at: iso(a.updatedAt),
      session: this.sessionName(a.sessionId),
    }))
    const text =
      matching.length === 0
        ? query === ''
          ? 'No artifacts in this project yet.'
          : `No artifact title in this project matches "${String(o.query)}".`
        : artifacts.length < matching.length
          ? `${count(matching.length, 'artifact', 'artifacts')}; the newest ${artifacts.length} are listed.`
          : `${count(matching.length, 'artifact', 'artifacts')}, newest first.`
    return result(text, { artifacts })
  }

  private async delete(caller: Caller, o: Args): Promise<CallToolResult> {
    const artifactId = id(o)
    const { purgeAt } = await this.limited(caller, () =>
      this.deps.store.delete(artifactId, { project: caller.project }),
    )
    return result(
      `Moved ${artifactId} to Recently deleted; the user can restore it until ${iso(purgeAt)}.`,
      { id: artifactId, purge_at: iso(purgeAt) },
    )
  }

  private async versions(caller: Caller, o: Args): Promise<CallToolResult> {
    const artifactId = id(o)
    const records = await this.deps.store.versions(artifactId, { project: caller.project })
    const versions = records.map((record) => ({
      version: record.version,
      created_at: iso(record.createdAt),
      author: this.sessionName(record.author),
      note: record.note,
      size: record.size,
    }))
    return result(
      `${artifactId} has ${count(versions.length, 'version', 'versions')}, newest first.`,
      { versions },
    )
  }

  private async restore(caller: Caller, o: Args): Promise<CallToolResult> {
    const artifactId = id(o)
    const version = wholeNumber(o, 'version', 1)
    const baseVersion = wholeNumber(o, 'base_version', 1)
    const editor = this.editor(caller)
    const restored = await this.limited(caller, () =>
      this.deps.store.restore({
        id: artifactId,
        version,
        baseVersion,
        author: caller.sessionId,
        project: caller.project,
        ...(editor ? { editor } : {}),
      }),
    )
    return result(`Restored version ${version} of ${artifactId} as version ${restored.version}.`, {
      id: artifactId,
      version: restored.version,
    })
  }
}
