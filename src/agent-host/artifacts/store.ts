// The artifacts of every project, as the host serves them: the store the interface and the
// artifacts service call, the watches that count viewers, and the purge of Recently deleted.
// The records and files belong to the thread worker; this side only reads the files.

import { readFile } from 'node:fs/promises'
import {
  ARTIFACT_KEEP_DELETED_MS,
  type ArtifactSession,
  type ArtifactState,
  type VersionSummary,
} from '@shared/artifacts'
import { HostError } from '../errors'
import type { LogFn } from '../storage'
import { ThreadStoreError, type ThreadStore } from '../threads/store'
import { contentPath } from './content'
import { newArtifactId } from './ids'
import type {
  ArtifactCallName,
  ArtifactCalls,
  ArtifactRecord,
  StoredSummary,
  VersionRecord,
} from './model'

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
}

export interface Editing {
  editor?: SessionTurn
}

export function versionSummary(record: VersionRecord): VersionSummary {
  const { version, createdAt, author, note, size } = record
  return { version, createdAt, author, note, size }
}

export class ArtifactStore {
  /** The watches of each artifact, counted per port, since one window can show it twice. */
  private readonly watches = new Map<string, Map<string, number>>()
  /** The sessions using each artifact, in the order they started, and whether each edits it. */
  private readonly users = new Map<string, Map<string, boolean>>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: ArtifactStoreDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private async call<K extends ArtifactCallName>(
    name: K,
    params: ArtifactCalls[K]['params'],
  ): Promise<ArtifactCalls[K]['result']> {
    const { threads } = this.deps
    if (!threads) throw new HostError('internal', 'Artifacts need the thread database')
    try {
      return await threads.artifact(name, params)
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

  /** The artifact and one of its versions, the latest by default, without the HTML. */
  get(
    id: string,
    { version, project }: Reach & { version?: number } = {},
  ): Promise<{ artifact: ArtifactRecord; version: VersionRecord }> {
    return this.call('get', { id, version: version ?? null, project: project ?? null })
  }

  /** A version, the latest by default, with its HTML. */
  async read(
    id: string,
    reach: Reach & { version?: number } & Reading = {},
  ): Promise<{ artifact: ArtifactRecord; version: VersionRecord; html: string }> {
    const { reader, ...rest } = reach
    const found = await this.get(id, rest)
    const file = contentPath(this.deps.contentDir, found.version.hash)
    let html: string
    try {
      html = await readFile(file, 'utf8')
    } catch (error) {
      throw new Error(
        `The HTML of ${id} version ${found.version.version} cannot be read: ${(error as Error).message}`,
        { cause: error },
      )
    }
    this.used(id, reader, false)
    return { ...found, html }
  }

  /** Newest first. */
  async versions(id: string, { project, reader }: Reach & Reading = {}): Promise<VersionRecord[]> {
    const records = await this.call('versions', { id, project: project ?? null })
    this.used(id, reader, false)
    return records
  }

  /** The file of a version, the latest by default, for main to serve; with the artifact's title. */
  async content(
    id: string,
    version?: number,
  ): Promise<{ path: string; version: number; title: string }> {
    const found = await this.get(id, version === undefined ? {} : { version })
    return {
      path: contentPath(this.deps.contentDir, found.version.hash),
      version: found.version.version,
      title: found.artifact.title,
    }
  }

  // Writing.

  /** A new artifact in the session's project, at version 1, written by that session. */
  async create(
    input: {
      project: string
      sessionId: string
      title: string
      html: string
      pages: number
      note: string | null
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

  /** A new version from `baseVersion`, which must be the latest; `author` null is the user. */
  async write(
    input: {
      id: string
      baseVersion: number
      html: string
      pages: number
      author: string | null
      note: string | null
    } & Reach &
      Editing,
  ): Promise<{ version: number }> {
    const { project, editor, ...rest } = input
    const { version } = await this.call('write', {
      ...rest,
      project: project ?? null,
      at: this.now(),
    })
    this.used(input.id, editor, true)
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

  // Presence.

  /** The sessions using the artifact, in the order they started. */
  private using(id: string): ArtifactSession[] {
    const sessions = this.users.get(id)
    return sessions ? [...sessions].map(([sessionId, editing]) => ({ sessionId, editing })) : []
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
  private used(id: string, turn: SessionTurn | undefined, editing: boolean): void {
    if (!turn?.current()) return
    let sessions = this.users.get(id)
    if (!sessions) {
      sessions = new Map()
      this.users.set(id, sessions)
    }
    const was = sessions.get(turn.session)
    // A session that read and then wrote is editing; one that only read stays reading.
    if (was === true || was === editing) return
    sessions.set(turn.session, editing)
    this.sendActivity(id)
  }

  /** The session's turn ended, or the session went: it uses nothing now. */
  stopUsing(sessionId: string): void {
    let edited = false
    for (const [id, sessions] of [...this.users]) {
      const editing = sessions.get(sessionId)
      if (editing === undefined) continue
      edited ||= editing
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
    this.deps.activity(ports.keys(), { id, viewers, sessions: this.using(id) })
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

  /** Removes one watch of the port; false when it had none. */
  private drop(id: string, portId: string): boolean {
    const ports = this.watches.get(id)
    const count = ports?.get(portId)
    if (!ports || !count) return false
    if (count > 1) ports.set(portId, count - 1)
    else ports.delete(portId)
    if (ports.size === 0) this.watches.delete(id)
    return true
  }

  portClosed(portId: string): void {
    for (const [id, ports] of [...this.watches]) {
      if (!ports.delete(portId)) continue
      if (ports.size === 0) this.watches.delete(id)
      else this.sendActivity(id)
    }
  }
}
