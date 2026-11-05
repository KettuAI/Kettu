// The computer use service: whether a call may use the computer, which app it touches, the user's
// approval of that app, the one session that holds the computer, and the driver that acts.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type {
  ComputerApp,
  ComputerAppAnswer,
  ComputerAppDecision,
  ComputerToolErrorCode,
  ComputerUseSettings,
} from '@shared/computer-use'
import { COMPUTER_APP_WAIT_MS } from '@shared/computer-use'
import type { Platform } from '@shared/platform'
import type { ComputerUseView } from '@shared/thread'
import type { LogFn } from '../storage'
import {
  appIdentity,
  blockedApp,
  refusedMenuItem,
  refusedShortcut,
  type BlockReason,
  type DriverApp,
  type SelfApp,
} from './policy'
import { ComputerToolError, computerCall, tokenSnapshot, type ComputerCall } from './tools'

/** A session holds the computer this long after its last call, unless its turn ends first. */
export const HOLD_IDLE_MS = 2 * 60_000
/** How long a list of apps stands for finding a process's app. */
const APPS_FRESH_MS = 3_000
/** Snapshots remembered for checking element tokens, the oldest dropped first. */
const SNAPSHOTS_KEPT = 256

/** What runs the driver's tools: `ComputerDriver`, or a stand-in in tests. */
export interface DriverLike {
  call(tool: string, args: Record<string, unknown>): Promise<CallToolResult>
  stop(): Promise<void>
}

export interface ComputerUseDeps {
  platform: Platform
  /** The driver, or null where this host has none: the daemon, or a checkout without it. */
  driver: DriverLike | null
  /** Kettu's own processes and app ids, which computer use never touches. */
  self: SelfApp
  settings(): ComputerUseSettings
  /** Why the session's running turn may not use the computer, or null when it may. */
  turnRefusal(sessionId: string): string | null
  /** The title a busy error names. */
  sessionTitle(sessionId: string): string
  /** Shows the first use of an app in the session's thread; the answer comes to `answer`. */
  asked(sessionId: string, requestId: number, app: ComputerApp): void
  /** The wait ended, with its answer, so the card shows it. */
  settled(requestId: number, answer: ComputerAppAnswer): void
  /** Always allow: main adds the app to the settings, which come back to `settings`. */
  allowAlways(app: ComputerApp): void
  /** The session took or released the computer, or used another app. */
  using(sessionId: string, view: ComputerUseView | null): void
  log: LogFn
}

interface Waiting {
  sessionId: string
  app: ComputerApp
  timer: ReturnType<typeof setTimeout>
  resolve: (answer: ComputerAppAnswer) => void
}

interface Hold {
  sessionId: string
  app: string | null
  timer: ReturnType<typeof setTimeout> | null
}

function failure(code: ComputerToolErrorCode, message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { code, message },
    isError: true,
  }
}

const BLOCKED: Record<BlockReason, string> = {
  kettu: 'Computer use cannot use Kettu itself.',
  password_manager: 'Computer use never uses password managers or the keychain.',
  system:
    'Computer use never uses system settings or security prompts. Ask the user to change them.',
  terminal: 'Computer use never uses terminals. Run commands with your own tools instead.',
  browser:
    'Computer use never uses the user’s browsers. Open pages in Kettu’s browser with the ' +
    'browser_* tools.',
}

function asDriverApp(value: unknown): DriverApp | null {
  if (typeof value !== 'object' || value === null) return null
  const o = value as Record<string, unknown>
  if (typeof o.pid !== 'number' || typeof o.name !== 'string') return null
  return {
    pid: o.pid,
    name: o.name,
    bundleId: typeof o.bundle_id === 'string' ? o.bundle_id : null,
    launchPath: typeof o.launch_path === 'string' ? o.launch_path : null,
  }
}

/** The running apps of a `list_apps` result. */
function runningApps(result: CallToolResult): DriverApp[] {
  const apps = (result.structuredContent as { apps?: unknown } | undefined)?.apps
  if (!Array.isArray(apps)) return []
  return apps.flatMap((item) => {
    const running = (item as { running?: unknown }).running
    const app = running === false ? null : asDriverApp(item)
    return app && app.pid > 0 ? [app] : []
  })
}

/** The driver's answer with only its text and pictures, which is all the tools pass on. */
function passed(result: CallToolResult): CallToolResult {
  const content = result.content.filter((item) => item.type === 'text' || item.type === 'image')
  return {
    content,
    ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
    ...(result.isError ? { isError: true } : {}),
  }
}

export class ComputerUse {
  private hold: Hold | null = null
  private nextRequest = 1
  private readonly waiting = new Map<number, Waiting>()
  /** One question per session and app at a time; later calls wait on the same answer. */
  private readonly asking = new Map<string, Promise<ComputerAppAnswer>>()
  /** Apps allowed for the session while it stays in memory. */
  private readonly granted = new Map<string, Set<string>>()
  /** Apps denied in the session's running turn, which it does not ask about again. */
  private readonly denied = new Map<string, Set<string>>()
  /** Sessions whose turn the user stopped from using the computer. */
  private readonly stopped = new Set<string>()
  /** Which process each snapshot read, for the element tokens it gave. */
  private readonly snapshots = new Map<string, number>()
  private apps: { at: number; list: Promise<DriverApp[]> } | null = null

  constructor(private readonly deps: ComputerUseDeps) {}

  /** Serves a tool call of `sessionId`, a subagent's already counted as the session above it. */
  async call(sessionId: string, name: string, input: unknown): Promise<CallToolResult> {
    try {
      return await this.run(sessionId, computerCall(name, input, this.deps.platform))
    } catch (error) {
      if (error instanceof ComputerToolError) return failure(error.code, error.message)
      const message = (error as Error)?.message ?? String(error)
      this.deps.log('warn', `Computer use ${name} failed: ${message}`)
      if (/timed? ?out/i.test(message)) {
        return failure('timeout', 'The app did not answer in time. Read the window and try again.')
      }
      return failure('failed', `Computer use failed: ${message}`)
    }
  }

  /** A window's or device's answer to a first use of an app; false when nothing waits on it. */
  answer(requestId: number, decision: ComputerAppDecision): boolean {
    const waiting = this.waiting.get(requestId)
    if (!waiting) return false
    this.settle(requestId, decision)
    return true
  }

  /** The user pressed Stop: the driver ends, and the turn may not use the computer again. */
  stop(sessionId: string): void {
    if (this.hold?.sessionId !== sessionId) return
    this.stopped.add(sessionId)
    this.settleSession(sessionId)
    this.release(sessionId)
    void this.deps.driver?.stop()
  }

  /** The session's turn ended: it lets go of the computer, and its next turn starts afresh. */
  turnEnded(sessionId: string): void {
    this.stopped.delete(sessionId)
    this.denied.delete(sessionId)
    this.settleSession(sessionId)
    this.release(sessionId)
  }

  /** The session left memory: what it was allowed goes with it. */
  forget(sessionId: string): void {
    this.turnEnded(sessionId)
    this.granted.delete(sessionId)
  }

  /** The settings changed; turned off, every hold, question and the driver end. */
  settingsChanged(): void {
    if (this.deps.settings().enabled) return
    for (const requestId of [...this.waiting.keys()]) this.settle(requestId, 'timeout')
    if (this.hold) this.release(this.hold.sessionId)
    void this.deps.driver?.stop()
  }

  /** The host stops: so does the driver. */
  async shutdown(): Promise<void> {
    for (const requestId of [...this.waiting.keys()]) this.settle(requestId, 'timeout')
    if (this.hold) this.release(this.hold.sessionId)
    await this.deps.driver?.stop()
  }

  private async run(sessionId: string, call: ComputerCall): Promise<CallToolResult> {
    const driver = this.deps.driver
    if (!driver) {
      throw new ComputerToolError(
        'unavailable',
        'Computer use is not available on this host: it runs in the Kettu desktop app, on the ' +
          'computer whose apps it uses.',
      )
    }
    if (!this.deps.settings().enabled) {
      throw new ComputerToolError(
        'unavailable',
        'Computer use is off. The user can turn it on in Kettu’s Settings › Computer use.',
      )
    }
    const refusal = this.deps.turnRefusal(sessionId)
    if (refusal) throw new ComputerToolError('unavailable', refusal)
    if (this.stopped.has(sessionId)) throw stoppedError()
    this.take(sessionId)
    if (call.pid === null) return this.listApps(driver)
    const app = await this.appOf(driver, call.pid)
    const blocked = blockedApp(app, call.pid, this.deps.self)
    if (blocked) throw new ComputerToolError('blocked', BLOCKED[blocked])
    if (call.keys && refusedShortcut(call.keys, this.deps.platform)) {
      throw new ComputerToolError(
        'blocked',
        'That shortcut quits an app, logs out, locks or empties the trash, which computer use ' +
          'never presses.',
      )
    }
    if (call.menuPath && refusedMenuItem(call.menuPath)) {
      throw new ComputerToolError(
        'blocked',
        'That menu item quits an app, logs out, shuts down or empties the trash, which computer ' +
          'use never chooses.',
      )
    }
    if (call.elementToken && this.snapshots.get(tokenSnapshot(call.elementToken)) !== call.pid) {
      throw invalidToken()
    }
    await this.approve(sessionId, app)
    // The user may have pressed Stop, or another session taken over, while the card waited.
    if (this.stopped.has(sessionId)) throw stoppedError()
    this.take(sessionId, app.name)
    const result = await driver.call(call.driverTool, call.args)
    if (call.tool === 'computer_get_window_state') this.remember(result, call.pid)
    return passed(result)
  }

  /** Takes the computer for the session, or fails naming the session that has it. */
  private take(sessionId: string, app?: string): void {
    const hold = this.hold
    if (hold && hold.sessionId !== sessionId) {
      const title = this.deps.sessionTitle(hold.sessionId)
      throw new ComputerToolError(
        'busy',
        `Another session, “${title}”, is using the computer. Wait for it to finish, or ask the ` +
          'user.',
      )
    }
    const next: Hold = hold ?? { sessionId, app: null, timer: null }
    if (next.timer) clearTimeout(next.timer)
    next.timer = setTimeout(() => this.release(sessionId), HOLD_IDLE_MS)
    next.timer.unref?.()
    const changed = !hold || (app !== undefined && app !== next.app)
    if (app !== undefined) next.app = app
    this.hold = next
    if (changed) this.deps.using(sessionId, { app: next.app })
  }

  private release(sessionId: string): void {
    const hold = this.hold
    if (hold?.sessionId !== sessionId) return
    if (hold.timer) clearTimeout(hold.timer)
    this.hold = null
    this.deps.using(sessionId, null)
  }

  /** The user's leave to use the app in the session, asking them on its first use. */
  private async approve(sessionId: string, app: ComputerApp): Promise<void> {
    if (this.deps.settings().allowedApps.some((allowed) => allowed.id === app.id)) return
    if (this.granted.get(sessionId)?.has(app.id)) return
    if (this.denied.get(sessionId)?.has(app.id)) throw notAllowed(app, 'deny')
    const key = `${sessionId}\n${app.id}`
    let asking = this.asking.get(key)
    if (!asking) {
      asking = this.ask(sessionId, app).finally(() => this.asking.delete(key))
      this.asking.set(key, asking)
    }
    const answer = await asking
    if (answer === 'session' || answer === 'always') return
    // Stop ends the question unanswered; the agent hears that the user stopped it.
    if (this.stopped.has(sessionId)) throw stoppedError()
    throw notAllowed(app, answer)
  }

  private ask(sessionId: string, app: ComputerApp): Promise<ComputerAppAnswer> {
    const requestId = this.nextRequest++
    return new Promise<ComputerAppAnswer>((resolve) => {
      const timer = setTimeout(() => this.settle(requestId, 'timeout'), COMPUTER_APP_WAIT_MS)
      timer.unref?.()
      this.waiting.set(requestId, { sessionId, app, timer, resolve })
      this.deps.asked(sessionId, requestId, app)
    })
  }

  private settle(requestId: number, answer: ComputerAppAnswer): void {
    const waiting = this.waiting.get(requestId)
    if (!waiting) return
    this.waiting.delete(requestId)
    clearTimeout(waiting.timer)
    const { sessionId, app } = waiting
    if (answer === 'session' || answer === 'always') {
      const apps = this.granted.get(sessionId) ?? new Set<string>()
      apps.add(app.id)
      this.granted.set(sessionId, apps)
      if (answer === 'always') this.deps.allowAlways(app)
    } else if (answer === 'deny') {
      const apps = this.denied.get(sessionId) ?? new Set<string>()
      apps.add(app.id)
      this.denied.set(sessionId, apps)
    }
    this.deps.settled(requestId, answer)
    waiting.resolve(answer)
  }

  /** Every question of the session ends unanswered. */
  private settleSession(sessionId: string): void {
    for (const [requestId, waiting] of [...this.waiting]) {
      if (waiting.sessionId === sessionId) this.settle(requestId, 'timeout')
    }
  }

  private listedApps(driver: DriverLike): Promise<DriverApp[]> {
    const now = Date.now()
    if (this.apps && now - this.apps.at < APPS_FRESH_MS) return this.apps.list
    const list = driver.call('list_apps', {}).then((result) => {
      if (result.isError) throw new Error('The driver could not list the apps.')
      return runningApps(result)
    })
    this.apps = { at: now, list }
    list.catch(() => {
      if (this.apps?.list === list) this.apps = null
    })
    return list
  }

  /** The app a process belongs to, as the driver reports it, never as the agent named it. */
  private async appOf(driver: DriverLike, pid: number): Promise<ComputerApp> {
    const found = (await this.listedApps(driver)).find((app) => app.pid === pid)
    const app = found ? appIdentity(found, this.deps.platform) : null
    if (!app) {
      throw new ComputerToolError(
        'invalid',
        `No running app has process id ${pid}. List the apps again with computer_list_apps.`,
      )
    }
    return app
  }

  private async listApps(driver: DriverLike): Promise<CallToolResult> {
    this.apps = null
    const apps = await this.listedApps(driver)
    const rows = apps.flatMap((found) => {
      const app = appIdentity(found, this.deps.platform)
      if (!app) return []
      const blocked = blockedApp(app, found.pid, this.deps.self)
      return [{ name: app.name, pid: found.pid, id: app.id, available: blocked === null }]
    })
    const lines = rows.map(
      (row) => `- ${row.name} (pid ${row.pid})${row.available ? '' : ' — not available'}`,
    )
    const text =
      rows.length === 0
        ? 'No apps are running.'
        : `Running apps:\n${lines.join('\n')}\n\nApps marked not available are never used.`
    return { content: [{ type: 'text', text }], structuredContent: { apps: rows } }
  }

  /** Notes which process a read's snapshot is of, for the tokens it handed out. */
  private remember(result: CallToolResult, pid: number): void {
    const id = (result.structuredContent as { snapshot_id?: unknown } | undefined)?.snapshot_id
    if (typeof id !== 'string') return
    this.snapshots.delete(id)
    this.snapshots.set(id, pid)
    if (this.snapshots.size > SNAPSHOTS_KEPT) {
      this.snapshots.delete(this.snapshots.keys().next().value!)
    }
  }
}

function stoppedError(): ComputerToolError {
  return new ComputerToolError(
    'stopped',
    'The user stopped computer use for this turn. Do not use the computer again until they send ' +
      'another message.',
  )
}

function invalidToken(): ComputerToolError {
  return new ComputerToolError(
    'invalid',
    'That element token is not from a read of this app’s window. Read the window with ' +
      'computer_get_window_state, then use a token from it.',
  )
}

function notAllowed(app: ComputerApp, answer: ComputerAppAnswer): ComputerToolError {
  return new ComputerToolError(
    'not_allowed',
    answer === 'timeout'
      ? `The user did not answer whether computer use may use ${app.name}.`
      : `The user did not allow computer use of ${app.name} in this turn.`,
  )
}
