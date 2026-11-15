// The GitHub star prompt on this host: when it may show, and whether the user starred Kettu or
// turned the prompt away. The record stays on this computer; nothing about it is sent anywhere.

import path from 'node:path'
import type { GitHubStarState } from '@shared/agent-host'
import type { GitServiceApi } from './git/api'
import type { StarCheck } from './git/star'
import { JsonFile, type LogFn, type Migration } from './storage'

export interface GitHubStarFile {
  version: 1
  /** Local days a turn ended normally, the latest MIN_DAYS of them. */
  days: string[]
  /** Turns that ended normally in the user's own sessions. */
  turns: number
  /** Starred through Kettu or found starred, so no prompt shows again. */
  starred: boolean
  /** The repository page was opened instead of starring, which ends the prompts too. */
  opened: boolean
  dismissals: number
  dismissedAt: number | null
  turnsAtDismissal: number
  /** A turn ended with the card due, so it shows until it is starred or closed. */
  cardDue: boolean
}

export const GITHUB_STAR_VERSION = 1
export const GITHUB_STAR_MIGRATIONS: Readonly<Record<number, Migration>> = {}

const MIN_DAYS = 3
const MIN_TURNS = 20
const MAX_DISMISSALS = 2
const PAUSE_MS = 30 * 24 * 60 * 60 * 1000
const MAX_COUNT = 1_000_000
const DAY = /^\d{4}-\d{2}-\d{2}$/

function emptyFile(): GitHubStarFile {
  return {
    version: 1,
    days: [],
    turns: 0,
    starred: false,
    opened: false,
    dismissals: 0,
    dismissedAt: null,
    turnsAtDismissal: 0,
    cardDue: false,
  }
}

function count(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? Math.min(value as number, MAX_COUNT)
    : 0
}

/** Keeps what is valid and resets the rest, so a damaged field never shows the prompt early. */
export function parseGitHubStarFile(data: Record<string, unknown>): GitHubStarFile | string {
  const days = Array.isArray(data.days)
    ? [...new Set(data.days.filter((d): d is string => typeof d === 'string' && DAY.test(d)))]
    : []
  const dismissedAt =
    typeof data.dismissedAt === 'number' && Number.isFinite(data.dismissedAt)
      ? data.dismissedAt
      : null
  return {
    version: 1,
    days: days.slice(-MIN_DAYS),
    turns: count(data.turns),
    starred: data.starred === true,
    opened: data.opened === true,
    dismissals: Math.min(count(data.dismissals), MAX_DISMISSALS),
    dismissedAt,
    turnsAtDismissal: count(data.turnsAtDismissal),
    cardDue: data.cardDue === true,
  }
}

export function gitHubStarFile(userDataPath: string, log: LogFn): JsonFile<GitHubStarFile> {
  return new JsonFile<GitHubStarFile>({
    file: path.join(userDataPath, 'state', 'github-star.json'),
    version: GITHUB_STAR_VERSION,
    migrations: GITHUB_STAR_MIGRATIONS,
    parse: parseGitHubStarFile,
    empty: emptyFile,
    log,
  })
}

function localDay(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function usedEnough(f: GitHubStarFile): boolean {
  return f.days.length >= MIN_DAYS && f.turns >= MIN_TURNS
}

function ended(f: GitHubStarFile): boolean {
  return f.starred || f.opened || f.dismissals >= MAX_DISMISSALS
}

/** Whether the card is due once a turn ends now: after enough use, or a while after a close. */
function cardDue(f: GitHubStarFile, now: number): boolean {
  if (ended(f) || !usedEnough(f)) return false
  if (f.dismissals === 0) return true
  return (
    f.dismissedAt !== null &&
    now - f.dismissedAt >= PAUSE_MS &&
    f.turns - f.turnsAtDismissal >= MIN_TURNS
  )
}

export interface GitHubStarDeps {
  file: JsonFile<GitHubStarFile>
  git: () => GitServiceApi | null
  changed: (state: GitHubStarState) => void
  log: LogFn
  now?: () => number
}

export class GitHubStar {
  private data: GitHubStarFile = emptyFile()
  private loaded: Promise<void> | null = null
  private check: StarCheck | null = null
  private checking: Promise<void> | null = null

  constructor(private readonly deps: GitHubStarDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private load(): Promise<void> {
    this.loaded ??= this.deps.file.load().then(
      (data) => {
        this.data = data
      },
      (error: unknown) => {
        this.deps.log('warn', `Could not read the GitHub star record: ${(error as Error).message}`)
      },
    )
    return this.loaded
  }

  private save(next: GitHubStarFile): void {
    this.data = next
    this.deps.file.save(next)
    this.deps.changed(this.view())
  }

  private view(): GitHubStarState {
    const f = this.data
    return {
      gh: this.check === null ? null : this.check !== 'unavailable',
      starred: this.check === null ? f.starred : this.check === 'starred',
      card: f.cardDue && !ended(f),
      line: usedEnough(f) && f.dismissals === 0 && !f.starred && !f.opened,
    }
  }

  /** Reads whether gh can star and whether the user already did, once until `recheck`. */
  private ensureChecked(): Promise<void> {
    this.checking ??= (async () => {
      const git = this.deps.git()
      const check = git ? await git.starred().catch(() => 'unavailable' as const) : 'unavailable'
      this.check = check
      if (check === 'starred' && !this.data.starred) {
        this.save({ ...this.data, starred: true, cardDue: false })
      } else {
        this.deps.changed(this.view())
      }
    })()
    return this.checking
  }

  async state(): Promise<GitHubStarState> {
    await this.load()
    void this.ensureChecked()
    return this.view()
  }

  /** gh changed, as after the user signed in: read it again. */
  recheck(): void {
    if (this.checking === null) return
    this.checking = null
    void this.ensureChecked()
  }

  /** A turn of the user's own session ended normally. */
  async turnCompleted(): Promise<void> {
    await this.load()
    const f = this.data
    if (ended(f)) return
    const now = this.now()
    const day = localDay(now)
    const days = f.days.includes(day) ? f.days : [...f.days, day].slice(-MIN_DAYS)
    const next = { ...f, days, turns: Math.min(f.turns + 1, MAX_COUNT) }
    if (!next.cardDue && cardDue(next, now)) next.cardDue = true
    this.save(next)
  }

  /** Stars through gh; false when gh could not, and the caller opens the page instead. */
  async star(): Promise<boolean> {
    await this.load()
    const git = this.deps.git()
    const ok = git ? await git.star().catch(() => false) : false
    if (ok) {
      this.check = 'starred'
      this.save({ ...this.data, starred: true, cardDue: false })
    } else {
      this.check = 'unavailable'
      this.deps.changed(this.view())
    }
    return ok
  }

  /** The user closed the card or New session's line, which both put away. */
  async dismiss(): Promise<void> {
    await this.load()
    const f = this.data
    if (ended(f)) return
    this.save({
      ...f,
      dismissals: Math.min(f.dismissals + 1, MAX_DISMISSALS),
      dismissedAt: this.now(),
      turnsAtDismissal: f.turns,
      cardDue: false,
    })
  }

  /** The repository page opened in the browser in place of a star. */
  async opened(): Promise<void> {
    await this.load()
    if (this.data.opened) return
    this.save({ ...this.data, opened: true, cardDue: false })
  }

  flush(): Promise<void> {
    return this.deps.file.flush()
  }
}
