// The artifacts of every project, as the host serves them: the store the interface and the
// artifacts service call, the watches that count viewers, and the purge of Recently deleted.
// The records and files belong to the thread worker; this side only reads the files.

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isStrictDeclaration } from '@shared/artifact-capabilities'
import type { CommentAnchor, CommentAuthor, CommentThread } from '@shared/artifact-comments'
import { ARTIFACT_ENTRY, DISK_FILE_BYTES, isHtmlPath } from '@shared/artifact-files'
import { findAnchor, startTagAt } from '@shared/artifact-source'
import {
  ARTIFACT_KEEP_DELETED_MS,
  type ArtifactDoing,
  type ArtifactFocus,
  type ArtifactSession,
  type ArtifactState,
  type VersionSummary,
} from '@shared/artifacts'
import type { ArtifactTypeInfo } from '@shared/artifact-types'
import type { CanvasEvent } from '@shared/artifact-canvas'
import { withParamValues, type ParamValue } from '@shared/artifact-params'
import { HostError } from '../errors'
import type { LogFn } from '../storage'
import { ThreadStoreError, type ThreadStore } from '../threads/store'
import { contentPath, versionKey } from './content'
import { editElement, EditError, type ElementChange } from './element-edit'
import { newArtifactId, ulid } from './ids'
import { LiveCanvases } from './live-canvas'
import { countPages } from './pages'
import type {
  ArtifactCallName,
  ArtifactCalls,
  ArtifactRecord,
  FileChange,
  StoredFile,
  StoredSummary,
  VersionRecord,
} from './model'
import type { Declaration, RuntimeCallName, RuntimeCalls } from './runtime/calls'

const PURGE_EVERY_MS = 24 * 60 * 60 * 1000

export type ArtifactErrorCode = 'not_found' | 'deleted' | 'conflict'

/**
 * A call the store refused. `not_found`: no such artifact or version within reach. `deleted`: it
 * is in Recently deleted. `conflict`: it is not in the state the call assumed, such as a
 * `baseVersion` that is not the latest; `state` says what it is. On the port the first is
 * `not_found` and the others `conflict`, with the state as data.
 */
export class ArtifactError extends HostError {
  constructor(
    readonly reason: ArtifactErrorCode,
    message: string,
    readonly state: ArtifactState | null,
  ) {
    super(reason === 'not_found' ? 'not_found' : 'conflict', message, state ?? undefined)
    this.name = 'ArtifactError'
  }
}

export interface ArtifactActivity {
  id: string
  viewers: number
  sessions: ArtifactSession[]
  /** The canvas page each port shows, where it said. */
  pages: ReadonlyMap<string, string | null>
}

export interface ArtifactStoreDeps {
  threads: ThreadStore | null
  contentDir: string
  log: LogFn
  /** The list changed: an artifact came or went, was renamed or has a new version. */
  changed(): void
  /** A new version, for the ports watching the artifact. */
  version(portIds: Iterable<string>, id: string, version: number): void
  activity(portIds: Iterable<string>, activity: ArtifactActivity): void
  /** Its comments changed, for the ports watching the artifact. */
  comments?(portIds: Iterable<string>, id: string): void
  /** The last port watching the artifact stopped. */
  unwatched?(id: string): void
  /** A canvas being worked on changed, for the ports watching the artifact. */
  canvas?(portIds: Iterable<string>, event: CanvasEvent): void
  /** How long a canvas stays quiet before the user's changes on it become a version. */
  canvasQuietMs?: number
  now?: () => number
  purgeEveryMs?: number
}

/**
 * Where a call reaches. A session's is its project, or its scratch folder: the artifacts there,
 * outside Recently deleted, are all that exist for it. Without one, the call is the user's and
 * reaches every artifact.
 */
export interface Reach {
  project?: string
}

/**
 * The session whose running turn makes a call, which then counts as using the artifact until the
 * turn ends. `current` says, once the call has done its work, whether that same turn still runs:
 * one that ended meanwhile already cleared what it used.
 */
export interface SessionTurn {
  session: string
  current(): boolean
}

/** The turn of a session that reads an artifact, which then counts as reading it. */
export interface Reading {
  reader?: SessionTurn
  /** The file it read, for its pointer. */
  focus?: ArtifactFocus
}

export interface Editing {
  editor?: SessionTurn
  /** What it changed, for its pointer. */
  focus?: ArtifactFocus
  doing?: ArtifactDoing
}

/** A version as the store reads it: the artifact, the version and its files. */
export interface FoundVersion {
  artifact: ArtifactRecord
  version: VersionRecord
  files: StoredFile[]
  /** The version's type and format; null for a plain artifact. */
  type: ArtifactTypeInfo | null
}

/** A file of a version as main and the remote host serve it: where its bytes lie on disk. */
export interface ContentFile {
  path: string
  file: string
  size: number
}

export function versionSummary(record: VersionRecord): VersionSummary {
  const { version, createdAt, author, note, size } = record
  return { version, createdAt, author, note, size }
}

export class ArtifactStore {
  /** The watches of each artifact, counted per port, since one window can show it twice. */
  private readonly watches = new Map<string, Map<string, number>>()
  /** The sessions using each artifact, in the order they started, and whether each edits it. */
  private readonly users = new Map<
    string,
    Map<string, { editing: boolean; last: { doing: ArtifactDoing; focus: ArtifactFocus } | null }>
  >()
  private timer: ReturnType<typeof setInterval> | null = null
  /** The canvas page each port shows each artifact at. */
  private readonly views = new Map<string, Map<string, string | null>>()
  /** The canvas documents clients are working on, with their changes not yet in a version. */
  readonly canvases: LiveCanvases

  constructor(private readonly deps: ArtifactStoreDeps) {
    this.canvases = new LiveCanvases(this, {
      log: deps.log,
      ports: (id) => this.watchers(id),
      send: (ports, event) => deps.canvas?.(ports, event),
      ...(deps.canvasQuietMs !== undefined ? { quietMs: deps.canvasQuietMs } : {}),
    })
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private async call<K extends ArtifactCallName>(
    name: K,
    params: ArtifactCalls[K]['params'],
  ): Promise<ArtifactCalls[K]['result']> {
    const { threads } = this.deps
    if (!threads) throw new HostError('internal', 'Artifacts need the thread database')
    return this.refused(() => threads.artifact(name, params))
  }

  /**
   * A call on the page runtime's tables beside the artifacts: a version's declaration, the data
   * and the consents. Fails as the artifact calls do, and `invalid` or `too_large` as the
   * ThreadStoreError of a write of data that does not apply or fit.
   */
  runtime<K extends RuntimeCallName>(
    name: K,
    params: RuntimeCalls[K]['params'],
  ): Promise<RuntimeCalls[K]['result']> {
    const { threads } = this.deps
    if (!threads) throw new HostError('internal', 'Artifacts need the thread database')
    return this.refused(() => threads.runtime(name, params))
  }

  private async refused<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      if (
        error instanceof ThreadStoreError &&
        (error.code === 'not_found' || error.code === 'deleted' || error.code === 'conflict')
      ) {
        throw new ArtifactError(error.code, error.message, error.data ?? null)
      }
      throw error
    }
  }

  /** The purge now and every 24 hours, until `stop`. */
  start(): void {
    if (this.timer) return
    void this.purge()
    this.timer = setInterval(() => void this.purge(), this.deps.purgeEveryMs ?? PURGE_EVERY_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Removes what has been in Recently deleted for 30 days, and the files no version names. */
  async purge(): Promise<void> {
    if (!this.deps.threads) return
    try {
      const before = this.now() - ARTIFACT_KEEP_DELETED_MS
      const { artifacts, files } = await this.call('purge', { before })
      if (artifacts > 0 || files > 0) {
        this.deps.log('info', `Purged ${artifacts} artifacts and ${files} content files`)
      }
      if (artifacts > 0) this.deps.changed()
    } catch (error) {
      this.deps.log('warn', `The artifact purge failed: ${(error as Error).message}`)
    }
  }

  // Reading.

  /** Newest first. Recently deleted is the user's alone, by when each artifact went. */
  async list(reach: { project: string } | { deleted?: boolean } = {}): Promise<StoredSummary[]> {
    const listed = await this.call(
      'list',
      'project' in reach
        ? { project: reach.project }
        : { project: null, deleted: reach.deleted ?? false },
    )
    return listed.map((artifact) => ({ ...artifact, editing: this.editing(artifact.id) }))
  }

  /** The artifact and one of its versions, the latest by default, with the version's files. */
  get(id: string, { version, project }: Reach & { version?: number } = {}): Promise<FoundVersion> {
    return this.call('get', { id, version: version ?? null, project: project ?? null })
  }

  /** As `get`, which counts as the reader's reading it. */
  async read(
    id: string,
    reach: Reach & { version?: number } & Reading = {},
  ): Promise<FoundVersion> {
    const { reader, focus, ...rest } = reach
    const found = await this.get(id, rest)
    this.used(id, reader, false, focus ? { doing: 'read', focus } : undefined)
    return found
  }

  /** The bytes of a file of a version. */
  async bytes(found: FoundVersion, file: StoredFile): Promise<Buffer> {
    try {
      return await readFile(contentPath(this.deps.contentDir, file.hash))
    } catch (error) {
      throw new Error(
        `${file.path} of ${found.artifact.id} version ${found.version.version} cannot be read: ${(error as Error).message}`,
        { cause: error },
      )
    }
  }

  /** The text of the version's entry page, which the viewer and the page count read. */
  async entryText(found: FoundVersion): Promise<string> {
    const entry = found.files.find((file) => file.path === ARTIFACT_ENTRY)
    if (!entry) throw new Error(`${found.artifact.id} has no ${ARTIFACT_ENTRY}`)
    return (await this.bytes(found, entry)).toString('utf8')
  }

  /** Newest first. */
  async versions(id: string, { project, reader }: Reach & Reading = {}): Promise<VersionRecord[]> {
    const records = await this.call('versions', { id, project: project ?? null })
    this.used(id, reader, false)
    return records
  }

  /**
   * The files of a version, the latest by default, for main and the remote host to serve; with the
   * artifact's title, the key its thumbnail is kept under, and whether its pages load from their
   * own origin alone, as the latest version's declaration says.
   */
  async content(
    id: string,
    version?: number,
  ): Promise<{
    version: number
    title: string
    key: string
    strict: boolean
    files: ContentFile[]
    type: ArtifactTypeInfo | null
  }> {
    const [found, latest] = await Promise.all([
      this.get(id, version === undefined ? {} : { version }),
      this.runtime('declaration', { id, project: null, version: null }),
    ])
    const key = versionKey(found.files)
    return {
      version: found.version.version,
      title: found.artifact.title,
      type: found.type,
      // A typed version's thumbnail is its viewer's, which a new format's viewer draws anew.
      key: found.type
        ? createHash('sha256')
            .update(`${key}\0${found.type.name}\0${found.type.format}`, 'utf8')
            .digest('hex')
        : key,
      strict: isStrictDeclaration(latest.capabilities),
      files: found.files.map((file) => ({
        path: file.path,
        file: contentPath(this.deps.contentDir, file.hash),
        size: file.size,
      })),
    }
  }

  // Writing.

  /** A new artifact in the session's project, at version 1, written by that session. */
  async create(
    input: {
      project: string
      sessionId: string
      title: string
      files: { path: string; data: Uint8Array }[]
      pages: number
      note: string | null
      declaration?: Declaration
      type?: ArtifactTypeInfo | null
    } & Editing,
  ): Promise<{ id: string; version: number }> {
    const { editor, ...rest } = input
    const at = this.now()
    const id = newArtifactId(at)
    const { version } = await this.call('create', { ...rest, id, at })
    this.used(id, editor, true)
    this.deps.changed()
    return { id, version }
  }

  /**
   * A new version from `baseVersion`, which must be the latest: its files with `changes` made, the
   * others as they were. `author` null is the user.
   */
  async write(
    input: {
      id: string
      baseVersion: number
      changes: FileChange[]
      pages: number
      author: string | null
      note: string | null
      declaration?: Declaration
      type?: ArtifactTypeInfo | null
      unchecked?: string[]
    } & Reach &
      Editing,
  ): Promise<{ version: number }> {
    const { project, editor, focus, doing, ...rest } = input
    const { version } = await this.call('write', {
      ...rest,
      project: project ?? null,
      at: this.now(),
    })
    this.used(input.id, editor, true, focus ? { doing: doing ?? 'write', focus } : undefined)
    this.versioned(input.id, version)
    return { version }
  }

  /** An earlier version again as the newest, from `baseVersion`, which must be the latest. */
  async restore(
    input: {
      id: string
      version: number
      baseVersion: number
      author: string | null
      note?: string | null
    } & Reach &
      Editing,
  ): Promise<{ version: number }> {
    const { project, note, editor, ...rest } = input
    const { version } = await this.call('restore', {
      ...rest,
      project: project ?? null,
      note: note ?? null,
      at: this.now(),
    })
    this.used(input.id, editor, true)
    this.versioned(input.id, version)
    return { version }
  }

  private versioned(id: string, version: number): void {
    this.deps.changed()
    const ports = this.watches.get(id)
    if (ports) this.deps.version(ports.keys(), id, version)
    this.canvases.versioned(id)
  }

  /** Changes the title, which is not versioned. */
  async rename(
    id: string,
    title: string,
    { project, editor }: Reach & Editing = {},
  ): Promise<void> {
    await this.call('rename', { id, title, project: project ?? null })
    this.used(id, editor, true)
    this.deps.changed()
  }

  /** Moves the artifact to Recently deleted, until `purgeAt`. */
  async delete(
    id: string,
    { project }: Reach = {},
  ): Promise<{ deletedAt: number; purgeAt: number }> {
    const { deletedAt, changed } = await this.call('delete', {
      id,
      project: project ?? null,
      at: this.now(),
    })
    if (changed) this.deps.changed()
    return { deletedAt, purgeAt: deletedAt + ARTIFACT_KEEP_DELETED_MS }
  }

  /** Brings the artifact back from Recently deleted; the user's alone. */
  async undelete(id: string): Promise<void> {
    const { changed } = await this.call('undelete', { id })
    if (changed) this.deps.changed()
  }

  /** Removes an artifact in Recently deleted for good; the user's alone. */
  async erase(id: string): Promise<void> {
    await this.call('erase', { id })
    this.deps.changed()
  }

  // Comments.

  /**
   * The artifact's threads, oldest first, each anchored in its latest version: an element a new
   * version moved is found again by its tag, text and page, and one no longer there is marked so.
   */
  async threads(id: string, { project }: Reach = {}): Promise<CommentThread[]> {
    const threads = await this.call('threads', { id, project: project ?? null })
    const stale = threads.filter((t) => t.anchor.offset !== null && !t.anchor.missing)
    if (stale.length === 0) return threads
    const found = await this.get(id, project ? { project } : {}).catch(() => null)
    if (!found) return threads
    const head = found.version.version
    const texts = new Map<string, string | null>()
    const textOf = async (path: string): Promise<string | null> => {
      if (!texts.has(path)) {
        const file = found.files.find((f) => f.path === path)
        texts.set(path, file ? (await this.bytes(found, file)).toString('utf8') : null)
      }
      return texts.get(path)!
    }
    const moved: { threadId: string; anchor: CommentAnchor }[] = []
    for (const thread of stale) {
      const { anchor } = thread
      if (anchor.version === head) continue
      const text = await textOf(anchor.path)
      const old = { offset: anchor.offset!, tag: anchor.tag ?? '', text: anchor.text }
      const offset =
        text === null ? null : findAnchor(text, { ...old, page: anchor.page?.number ?? null })
      // Without text to match, an element whose tag is still where it was stays.
      const kept =
        offset === null &&
        text !== null &&
        anchor.text === '' &&
        startTagAt(text, old.offset)?.name === anchor.tag
      const next: CommentAnchor =
        offset !== null
          ? { ...anchor, version: head, offset }
          : kept
            ? { ...anchor, version: head }
            : { ...anchor, version: head, missing: true }
      moved.push({ threadId: thread.id, anchor: next })
      thread.anchor = next
    }
    if (moved.length > 0) await this.call('reanchor', { id, anchors: moved }).catch(() => {})
    return threads
  }

  private commented(id: string): void {
    const ports = this.watches.get(id)
    if (ports) this.deps.comments?.(ports.keys(), id)
  }

  /** A new thread on the artifact, by the user or, with a session, their agent. */
  async addThread(
    id: string,
    input: { anchor: CommentAnchor; author: CommentAuthor; body: string },
    { project }: Reach = {},
  ): Promise<CommentThread> {
    const at = this.now()
    const thread = await this.call('addThread', {
      id,
      project: project ?? null,
      threadId: `thr_${ulid(at)}`,
      ...input,
      at,
    })
    this.commented(id)
    return thread
  }

  async reply(
    id: string,
    threadId: string,
    input: { author: CommentAuthor; body: string },
    { project }: Reach = {},
  ): Promise<CommentThread> {
    const thread = await this.call('reply', {
      id,
      project: project ?? null,
      threadId,
      ...input,
      at: this.now(),
    })
    this.commented(id)
    return thread
  }

  async resolve(
    id: string,
    threadId: string,
    resolved: boolean,
    { project }: Reach = {},
  ): Promise<CommentThread> {
    const thread = await this.call('resolve', {
      id,
      project: project ?? null,
      threadId,
      resolved,
      at: this.now(),
    })
    this.commented(id)
    return thread
  }

  /** The user sent the threads to the session; they wait no more until the user writes again. */
  async markSent(id: string, threadIds: string[], sessionId: string): Promise<void> {
    await this.call('markSent', { id, threadIds, sessionId, at: this.now() })
    this.commented(id)
  }

  /**
   * The user's direct edit of one element as a new version from `baseVersion`, which must be the
   * latest: only that element's start tag's style, or its text, changes in its file.
   */
  async editElement(input: {
    id: string
    baseVersion: number
    path: string
    offset: number
    change: ElementChange
  }): Promise<{ version: number }> {
    const found = await this.get(input.id)
    if (found.artifact.deletedAt !== null) {
      throw new ArtifactError('deleted', `${input.id} is in Recently deleted`, {
        version: found.artifact.head,
        deleted: true,
      })
    }
    // The latest version's file: the write lands there unless the file changed since the base.
    const file = found.files.find((f) => f.path === input.path)
    if (!file || !isHtmlPath(file.path)) {
      throw new HostError('not_found', `${input.id} has no HTML file ${input.path}`)
    }
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        await this.bytes(found, file),
      )
    } catch {
      throw new HostError('invalid_params', `${input.path} is not UTF-8 text`)
    }
    let edited: string
    try {
      edited = editElement(text, input.offset, input.change)
    } catch (error) {
      if (error instanceof EditError) throw new HostError('invalid_params', error.message)
      throw error
    }
    const data = Buffer.from(edited, 'utf8')
    if (data.length > DISK_FILE_BYTES)
      throw new HostError('invalid_params', 'The file is too large')
    return this.write({
      id: input.id,
      baseVersion: input.baseVersion,
      changes: [{ path: input.path, data }],
      pages: input.path === ARTIFACT_ENTRY ? countPages(edited) : found.version.pages,
      author: null,
      note: null,
    })
  }

  /** New values for a page's declared parameters, written into the page as the user's version. */
  async setParams(input: {
    id: string
    baseVersion: number
    path: string
    values: Record<string, ParamValue>
  }): Promise<{ version: number }> {
    const found = await this.get(input.id)
    if (found.artifact.deletedAt !== null) {
      throw new ArtifactError('deleted', `${input.id} is in Recently deleted`, {
        version: found.artifact.head,
        deleted: true,
      })
    }
    const file = found.files.find((f) => f.path === input.path)
    if (!file || !isHtmlPath(file.path)) {
      throw new HostError('not_found', `${input.id} has no HTML file ${input.path}`)
    }
    let edited: string
    try {
      edited = withParamValues((await this.bytes(found, file)).toString('utf8'), input.values)
    } catch (error) {
      throw new HostError('invalid_params', (error as Error).message)
    }
    return this.write({
      id: input.id,
      baseVersion: input.baseVersion,
      changes: [{ path: input.path, data: Buffer.from(edited, 'utf8') }],
      pages: found.version.pages,
      author: null,
      note: null,
    })
  }

  // Presence.

  /** The sessions using the artifact, in the order they started. */
  private using(id: string): ArtifactSession[] {
    const sessions = this.users.get(id)
    return sessions
      ? [...sessions].map(([sessionId, use]) => ({
          sessionId,
          editing: use.editing,
          ...(use.last ? { doing: use.last.doing, focus: use.last.focus } : {}),
        }))
      : []
  }

  private editing(id: string): string[] {
    return this.using(id)
      .filter((session) => session.editing)
      .map((session) => session.sessionId)
  }

  /**
   * Counts the session's use once the call has done its work: it joins as reading, or as editing
   * where it stands. Called before a change is announced, so lists include the editor.
   */
  private used(
    id: string,
    turn: SessionTurn | undefined,
    editing: boolean,
    last?: { doing: ArtifactDoing; focus: ArtifactFocus },
  ): void {
    if (!turn?.current()) return
    let sessions = this.users.get(id)
    if (!sessions) {
      sessions = new Map()
      this.users.set(id, sessions)
    }
    const was = sessions.get(turn.session)
    // A session that read and then wrote is editing; one that only read stays reading.
    const now = { editing: (was?.editing ?? false) || editing, last: last ?? was?.last ?? null }
    if (was && was.editing === now.editing && was.last === now.last) return
    sessions.set(turn.session, now)
    this.sendActivity(id)
  }

  /** The session's turn ended, or the session went: it uses nothing now. */
  stopUsing(sessionId: string): void {
    let edited = false
    for (const [id, sessions] of [...this.users]) {
      const use = sessions.get(sessionId)
      if (use === undefined) continue
      edited ||= use.editing
      sessions.delete(sessionId)
      if (sessions.size === 0) this.users.delete(id)
      this.sendActivity(id)
    }
    // The page's cards show who edits from the list, which no new version refreshes now.
    if (edited) this.deps.changed()
  }

  private sendActivity(id: string): void {
    const ports = this.watches.get(id)
    if (!ports) return
    let viewers = 0
    for (const count of ports.values()) viewers += count
    this.deps.activity(ports.keys(), {
      id,
      viewers,
      sessions: this.using(id),
      pages: this.views.get(id) ?? new Map(),
    })
  }

  /** The canvas page a port shows the artifact at. */
  view(id: string, portId: string, page: string | null): void {
    if (!this.watches.get(id)?.has(portId)) return
    let pages = this.views.get(id)
    if (!pages) {
      pages = new Map()
      this.views.set(id, pages)
    }
    if (pages.get(portId) === page) return
    pages.set(portId, page)
    this.sendActivity(id)
  }

  /** The canvas pages the user shows the artifact at, for an agent that reads it. */
  viewedPages(id: string): string[] {
    return [
      ...new Set([...(this.views.get(id)?.values() ?? [])].filter((p): p is string => p !== null)),
    ]
  }

  /** Counts a viewer of the artifact, which brings the port its new versions. */
  async watch(id: string, portId: string): Promise<void> {
    // Counted before the check, so a port that closes meanwhile takes its watch with it.
    let ports = this.watches.get(id)
    if (!ports) {
      ports = new Map()
      this.watches.set(id, ports)
    }
    ports.set(portId, (ports.get(portId) ?? 0) + 1)
    try {
      await this.call('get', { id, version: null, project: null })
    } catch (error) {
      this.drop(id, portId)
      throw error
    }
    this.sendActivity(id)
  }

  unwatch(id: string, portId: string): void {
    if (this.drop(id, portId)) this.sendActivity(id)
  }

  /** The ports watching the artifact now. */
  watchers(id: string): string[] {
    return [...(this.watches.get(id)?.keys() ?? [])]
  }

  /** Removes one watch of the port; false when it had none. */
  private drop(id: string, portId: string): boolean {
    const ports = this.watches.get(id)
    const count = ports?.get(portId)
    if (!ports || !count) return false
    if (count > 1) ports.set(portId, count - 1)
    else {
      ports.delete(portId)
      this.views.get(id)?.delete(portId)
    }
    if (ports.size === 0) this.unwatched(id)
    return true
  }

  portClosed(portId: string): void {
    for (const [id, ports] of [...this.watches]) {
      if (!ports.delete(portId)) continue
      this.views.get(id)?.delete(portId)
      if (ports.size === 0) this.unwatched(id)
      else this.sendActivity(id)
    }
  }

  private unwatched(id: string): void {
    this.watches.delete(id)
    this.views.delete(id)
    this.canvases.closed(id)
    this.deps.unwatched?.(id)
  }
}
