// Which sites an agent's page may open: a local dev host always, an origin the user allowed for
// the session, or one the project always allows. Anything else waits for the user, and the call
// fails when they refuse or do not answer.

import { join } from 'node:path'
import {
  ORIGIN_WAIT_MS,
  type BrowserOriginAnswer,
  type BrowserOriginDecision,
  type BrowserOriginRequest,
} from '@shared/browser'
import type { AllowedSites } from '@shared/ipc'
import { JsonFileWriter, readJsonFile } from '../json-file'
import { createLogger } from '../log'
import { isLocalAddress } from './policy'

const log = createLogger('browser-origins')

/** How long the pane shows the answer it was given. */
export const ORIGIN_ANSWER_MS = 10_000

/**
 * The origin a page opens: scheme, host and port. Null for a URL that has none, such as the
 * empty document. The host is lowercased and a default port left out, as a browser names it.
 */
export function originOf(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return parsed.origin
}

/** Whether a URL opens without asking: the empty document, and any page on a local dev host. */
export function opensFreely(url: string): boolean {
  if (url === 'about:blank' || url === 'about:srcdoc') return true
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return isLocalAddress(parsed)
}

/** The projects' allowed origins in `state/browser-origins.json`, with anything unfit left out. */
export function parseOrigins(raw: unknown): Record<string, string[]> {
  const projects: Record<string, string[]> = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return projects
  const stored = (raw as Record<string, unknown>).projects
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return projects
  for (const [path, origins] of Object.entries(stored as Record<string, unknown>)) {
    if (path === '' || !Array.isArray(origins)) continue
    const kept = [
      ...new Set(
        origins.filter(
          (origin): origin is string => typeof origin === 'string' && originOf(origin) === origin,
        ),
      ),
    ]
    if (kept.length > 0) projects[path] = kept
  }
  return projects
}

/** The projects' always-allowed origins, kept in `state/browser-origins.json`. */
export class BrowserOriginStore {
  private constructor(
    private projects: Record<string, string[]>,
    private readonly writer: JsonFileWriter,
  ) {}

  /** Reads the file leniently: what does not fit is left out, and the file is never moved aside. */
  static async load(userDataPath: string): Promise<BrowserOriginStore> {
    const path = join(userDataPath, 'state', 'browser-origins.json')
    const read = await readJsonFile(path)
    let projects: Record<string, string[]> = {}
    if (read.kind === 'ok') projects = parseOrigins(read.value)
    else if (read.kind === 'unreadable')
      log.warn(`Could not read browser-origins.json: ${read.reason}`)
    return new BrowserOriginStore(projects, new JsonFileWriter(path, log))
  }

  origins(projectPath: string): string[] {
    return this.projects[projectPath] ?? []
  }

  allows(projectPath: string, origin: string): boolean {
    return this.origins(projectPath).includes(origin)
  }

  add(projectPath: string, origin: string): void {
    if (this.allows(projectPath, origin) || originOf(origin) !== origin) return
    this.projects = { ...this.projects, [projectPath]: [...this.origins(projectPath), origin] }
    this.save()
  }

  remove(projectPath: string, origin: string): void {
    const origins = this.origins(projectPath)
    if (!origins.includes(origin)) return
    const kept = origins.filter((known) => known !== origin)
    const projects = { ...this.projects }
    if (kept.length > 0) projects[projectPath] = kept
    else delete projects[projectPath]
    this.projects = projects
    this.save()
  }

  list(): AllowedSites[] {
    return Object.entries(this.projects)
      .map(([projectPath, origins]) => ({ projectPath, origins: [...origins] }))
      .sort((a, b) => a.projectPath.localeCompare(b.projectPath))
  }

  flush(): Promise<void> {
    return this.writer.flush()
  }

  private save(): void {
    this.writer.schedule({ version: 1, projects: this.projects })
  }
}

interface Waiting {
  sessionId: string
  id: number
  origin: string
  timer: ReturnType<typeof setTimeout>
  resolve(answer: BrowserOriginAnswer): void
}

interface Shown {
  request: BrowserOriginRequest
  /** Clears the answer from the pane once it has been read. */
  timer: ReturnType<typeof setTimeout> | null
}

export interface BrowserOriginsDeps {
  /** A page wants a new origin, for the thread to show it. */
  asked(request: { id: number; sessionId: string; origin: string }): void
  /** The wait ended, so the thread takes the answer; the call settles after this. */
  settled(request: {
    id: number
    sessionId: string
    origin: string
    decision: BrowserOriginAnswer
  }): void
  /** The session's page has a new request to draw, or the answer went. */
  changed(sessionId: string): void
  /** How long a new origin waits for the user; the process test shortens it. */
  waitMs?: number
}

/**
 * The rules of a new origin, the session sets, the wait with its timeout, and the request the
 * pane draws. A session's set lives with its page; a project's is stored.
 */
export class BrowserOrigins {
  /** What each session's page may open until it leaves memory. */
  private readonly session = new Map<string, Set<string>>()
  /** The project each session's page belongs to, as the agent's call names it. */
  private readonly projects = new Map<string, string>()
  private readonly waiting = new Map<number, Waiting>()
  private readonly shown = new Map<string, Shown>()
  private nextId = 1

  constructor(
    private readonly store: BrowserOriginStore,
    private readonly deps: BrowserOriginsDeps,
  ) {}

  /** The project of the session's page, from the agent's call that drives it. */
  setProject(sessionId: string, projectPath: string): void {
    if (projectPath !== '') this.projects.set(sessionId, projectPath)
  }

  /** Whether the page must ask before opening `url`; the user's own navigation never asks. */
  needsAsking(sessionId: string, url: string): boolean {
    const origin = originOf(url)
    if (origin === null || opensFreely(url)) return false
    if (this.session.get(sessionId)?.has(origin)) return false
    const project = this.projects.get(sessionId)
    return project === undefined || !this.store.allows(project, origin)
  }

  /** Waits for the user to answer a new origin; an unanswered one counts as a refusal. */
  ask(sessionId: string, origin: string): Promise<BrowserOriginAnswer> {
    const id = this.nextId++
    this.show(sessionId, { id, origin, decision: null })
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(id, 'timeout'), this.deps.waitMs ?? ORIGIN_WAIT_MS)
      timer.unref?.()
      this.waiting.set(id, { sessionId, id, origin, timer, resolve })
      this.deps.asked({ id, sessionId, origin })
      this.deps.changed(sessionId)
    })
  }

  /** Answers a request from the pane or the card; another session's request is not answered. */
  answer(sessionId: string, id: number, decision: BrowserOriginDecision): void {
    const waiting = this.waiting.get(id)
    if (!waiting || waiting.sessionId !== sessionId) return
    this.settle(id, decision)
  }

  /** The origins each project always allows, for Settings. */
  allowedSites(): AllowedSites[] {
    return this.store.list()
  }

  /** Settings' Remove: the project no longer allows the origin. */
  removeAllowedSite(projectPath: string, origin: string): void {
    this.store.remove(projectPath, origin)
  }

  /** The request the pane draws for the session, while it waits and once it is answered. */
  requestOf(sessionId: string): BrowserOriginRequest | null {
    return this.shown.get(sessionId)?.request ?? null
  }

  /** A page is gone: whatever it waited for is refused, and its session's set goes with it. */
  close(sessionId: string): void {
    for (const [id, waiting] of [...this.waiting]) {
      if (waiting.sessionId === sessionId) this.settle(id, 'deny')
    }
    this.session.delete(sessionId)
    this.projects.delete(sessionId)
    this.clearShown(sessionId)
  }

  /** The app quits: what an answer wrote is on disk before the window goes. */
  flush(): Promise<void> {
    return this.store.flush()
  }

  private settle(id: number, decision: BrowserOriginAnswer): void {
    const waiting = this.waiting.get(id)
    if (!waiting) return
    this.waiting.delete(id)
    clearTimeout(waiting.timer)
    if (decision === 'session' || decision === 'project') {
      const allowed = this.session.get(waiting.sessionId) ?? new Set<string>()
      allowed.add(waiting.origin)
      this.session.set(waiting.sessionId, allowed)
      const project = this.projects.get(waiting.sessionId)
      // A page whose project is unknown still opens now: the session's set holds it.
      if (decision === 'project' && project !== undefined) this.store.add(project, waiting.origin)
    }
    const show = this.shown.get(waiting.sessionId)
    if (show?.request.id === id) {
      show.request = { ...show.request, decision }
      if (show.timer) clearTimeout(show.timer)
      show.timer = setTimeout(() => {
        this.clearShown(waiting.sessionId)
        this.deps.changed(waiting.sessionId)
      }, ORIGIN_ANSWER_MS)
      show.timer.unref?.()
    }
    this.deps.settled({
      id,
      sessionId: waiting.sessionId,
      origin: waiting.origin,
      decision,
    })
    this.deps.changed(waiting.sessionId)
    waiting.resolve(decision)
  }

  private show(sessionId: string, request: BrowserOriginRequest): void {
    const previous = this.shown.get(sessionId)
    if (previous?.timer) clearTimeout(previous.timer)
    this.shown.set(sessionId, { request, timer: null })
  }

  private clearShown(sessionId: string): void {
    const show = this.shown.get(sessionId)
    if (show?.timer) clearTimeout(show.timer)
    this.shown.delete(sessionId)
  }
}
