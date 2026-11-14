// What the user did not publish yet, kept on the host in `state/market-drafts.json`: a version put
// off with Not now or left unanswered, and one the service refused, each with the folder it came
// from, for Marketplace › Published to show and publish later.

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { MarketProblem, PublishDraft } from '@shared/market-publish'
import { JsonFile, type LogFn } from '../storage'

export interface PublishDraftsFile {
  version: 1
  drafts: PublishDraft[]
}

const MAX_DRAFTS = 100
const KINDS = new Set(['skill', 'plugin', 'mcp-server'])

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

export function parsePublishDraftsFile(data: Record<string, unknown>): PublishDraftsFile | string {
  if (!Array.isArray(data.drafts)) return '"drafts" must be a list'
  return { version: 1, drafts: data.drafts.filter(isDraft).slice(-MAX_DRAFTS) }
}

/** A draft as the tools make one; the store gives it its id and time. */
export type NewDraft = Omit<PublishDraft, 'id' | 'createdAt' | 'problems'> & {
  problems?: MarketProblem[]
}

export class PublishDrafts {
  private readonly file: JsonFile<PublishDraftsFile>
  private drafts: PublishDraft[] = []
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
      empty: () => ({ version: 1, drafts: [] }),
      log,
    })
    this.ready = this.file.load().then(
      (data) => {
        this.drafts = data.drafts
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

  /** A folder was published: its draft is done with. */
  async published(folder: string): Promise<void> {
    await this.ready
    const before = this.drafts.length
    this.drafts = this.drafts.filter((d) => d.path !== folder)
    if (this.drafts.length !== before) this.save()
  }

  flush(): Promise<void> {
    return this.file.flush()
  }

  private save(): void {
    this.file.save({ version: 1, drafts: this.drafts })
  }
}
