// What the user did not publish yet, kept on the host in `state/market-drafts.json`: a version put
// off with Not now or left unanswered, and one the service refused, each with the folder it came
// from, for Marketplace › Published to show and publish later. Beside them, where each listing was
// last published from and the session each version came from, which the service never learns.

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  LISTING_ID,
  type MarketProblem,
  type PublishDraft,
  type PublishOrigin,
} from '@shared/market-publish'
import { JsonFile, type LogFn } from '../storage'

export interface PublishDraftsFile {
  version: 1
  drafts: PublishDraft[]
  /** By listing id; absent from files written before it was kept. */
  origins: Record<string, PublishOrigin>
}

const MAX_DRAFTS = 100
// An account has at most 100 listings, each with its versions.
const MAX_ORIGINS = 200
const MAX_ORIGIN_VERSIONS = 500
const KINDS = new Set(['skill', 'workflow', 'plugin', 'mcp-server', 'agent-plugin'])

function isDraft(value: unknown): value is PublishDraft {
  if (typeof value !== 'object' || value === null) return false
  const draft = value as Record<string, unknown>
  const manifest = draft.manifest as Record<string, unknown> | null
  return (
    typeof draft.id === 'string' &&
    typeof draft.path === 'string' &&
    typeof manifest === 'object' &&
    manifest !== null &&
    typeof manifest.slug === 'string' &&
    typeof manifest.name === 'string' &&
    KINDS.has(manifest.kind as string) &&
    typeof manifest.version === 'string' &&
    (draft.listingId === null || typeof draft.listingId === 'string') &&
    (draft.sessionId === null || typeof draft.sessionId === 'string') &&
    (draft.sessionTitle === null || typeof draft.sessionTitle === 'string') &&
    (draft.agentId === null || typeof draft.agentId === 'string') &&
    typeof draft.createdAt === 'number' &&
    (draft.error === null || typeof draft.error === 'string') &&
    Array.isArray(draft.problems)
  )
}

function parseOrigins(value: unknown): Record<string, PublishOrigin> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const origins: Record<string, PublishOrigin> = {}
  for (const [id, item] of Object.entries(value).slice(-MAX_ORIGINS)) {
    const origin = item as Record<string, unknown> | null
    if (!LISTING_ID.test(id) || typeof origin?.path !== 'string') continue
    const sessions =
      typeof origin.sessions === 'object' && origin.sessions !== null ? origin.sessions : {}
    origins[id] = {
      path: origin.path,
      sessions: Object.fromEntries(
        Object.entries(sessions)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
          .slice(-MAX_ORIGIN_VERSIONS),
      ),
    }
  }
  return origins
}

export function parsePublishDraftsFile(data: Record<string, unknown>): PublishDraftsFile | string {
  if (!Array.isArray(data.drafts)) return '"drafts" must be a list'
  return {
    version: 1,
    drafts: data.drafts.filter(isDraft).slice(-MAX_DRAFTS),
    origins: parseOrigins(data.origins),
  }
}

/**
 * A version that reached the service: its listing, the session that asked, if one did, and its
 * folder as it was given.
 */
export interface PublishedVersion {
  listingId: string
  version: string
  sessionId: string | null
  path: string
}

/** A draft as the tools make one; the store gives it its id and time. */
export type NewDraft = Omit<PublishDraft, 'id' | 'createdAt' | 'problems'> & {
  problems?: MarketProblem[]
}

export class PublishDrafts {
  private readonly file: JsonFile<PublishDraftsFile>
  private drafts: PublishDraft[] = []
  private origin: Record<string, PublishOrigin> = {}
  readonly ready: Promise<void>

  constructor(
    userDataPath: string,
    log: LogFn,
    private readonly now: () => number = Date.now,
  ) {
    this.file = new JsonFile<PublishDraftsFile>({
      file: path.join(userDataPath, 'state', 'market-drafts.json'),
      version: 1,
      migrations: {},
      parse: parsePublishDraftsFile,
      empty: () => ({ version: 1, drafts: [], origins: {} }),
      log,
    })
    this.ready = this.file.load().then(
      (data) => {
        this.drafts = data.drafts
        this.origin = data.origins
      },
      () => undefined,
    )
  }

  /** Newest first. */
  list(): PublishDraft[] {
    return [...this.drafts].reverse()
  }

  /** Keeps a draft, in place of an earlier one of the same folder. */
  async put(draft: NewDraft): Promise<PublishDraft> {
    await this.ready
    const kept: PublishDraft = {
      ...draft,
      id: randomUUID(),
      createdAt: this.now(),
      problems: draft.problems ?? [],
    }
    this.drafts = [...this.drafts.filter((d) => d.path !== draft.path), kept].slice(-MAX_DRAFTS)
    this.save()
    return kept
  }

  async remove(id: string): Promise<void> {
    await this.ready
    const before = this.drafts.length
    this.drafts = this.drafts.filter((d) => d.id !== id)
    if (this.drafts.length !== before) this.save()
  }

  /** Where each listing was last published from, by listing id. */
  origins(): Record<string, PublishOrigin> {
    return { ...this.origin }
  }

  /** A folder was published: its draft is done with, and the listing came from it. */
  async published(folder: string, version?: PublishedVersion): Promise<void> {
    await this.ready
    this.drafts = this.drafts.filter((d) => d.path !== folder)
    if (version) {
      const { [version.listingId]: was, ...rest } = this.origin
      const sessions = { ...was?.sessions }
      if (version.sessionId) sessions[version.version] = version.sessionId
      // The listing published last goes last, so the oldest are dropped first.
      this.origin = { ...rest, [version.listingId]: { path: version.path, sessions } }
    }
    this.save()
  }

  /** A listing was deleted: where it came from is done with. */
  async forget(listingId: string): Promise<void> {
    await this.ready
    if (!(listingId in this.origin)) return
    this.origin = Object.fromEntries(Object.entries(this.origin).filter(([id]) => id !== listingId))
    this.save()
  }

  flush(): Promise<void> {
    return this.file.flush()
  }

  private save(): void {
    this.file.save({ version: 1, drafts: this.drafts, origins: this.origin })
  }
}
