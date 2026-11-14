// The computer use service: whether a call may use the computer, which app it touches, the user's
// approval of that app, the one session that holds the computer, and the driver that acts.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type {
  ComputerAct,
  ComputerApp,
  ComputerAppAnswer,
  ComputerAppDecision,
  ComputerControl,
  ComputerFrame,
  ComputerHold,
  ComputerPermissions,
  ComputerSetupOutcome,
  ComputerSetupStep,
  ComputerToolErrorCode,
  ComputerUseSettings,
  ComputerWindowRef,
} from '@shared/computer-use'
import {
  COMPUTER_APP_WAIT_MS,
  COMPUTER_SETUP_POLL_MS,
  COMPUTER_SETUP_WAIT_MS,
} from '@shared/computer-use'
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
/** Windows whose last read is remembered, for placing the agent's actions in them. */
const WINDOWS_KEPT = 32
/**
 * How long a call waits while the user holds the app before it answers that they still do, so
 * the agent calls again: under the harnesses' own limits on a tool call, such as Codex's 60 s.
 */
export const TAKEN_OVER_WAIT_MS = 45_000

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
  /**
   * macOS: Kettu's grants as a new driver process reports them, since the app's own process keeps
   * an old Screen Recording answer until it restarts; null when it cannot tell.
   */
  permissions?(): Promise<ComputerPermissions | null>
  /** Shows the setup a session's call waits on in its thread; Not now comes to `declineSetup`. */
  setupAsked(sessionId: string, requestId: number, steps: ComputerSetupStep[]): void
  /** Steps of a waiting setup were done since it asked. */
  setupDone(requestId: number, done: ComputerSetupStep[]): void
  /** The setup ended, so the card shows how. */
  setupSettled(requestId: number, outcome: ComputerSetupOutcome): void
  /** The user pressed Stop using: the thread says so. */
  stopped(sessionId: string): void
  /** The session's agent, which the floating label names. */
  agent(sessionId: string): { id: string; name: string }
  /** The hold changed in any way main draws, or ended. */
  held(hold: ComputerHold | null): void
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
  appPath: string | null
  action: 'read' | 'act' | null
  window: ComputerWindowRef | null
  control: ComputerControl
  act: ComputerAct | null
  timer: ReturnType<typeof setTimeout> | null
  /** Calls waiting while the user holds the app, woken by Hand back or the hold's end. */
  waiters: Set<() => void>
}

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/** A window as its latest reads left it: where it is, its screenshot's size and its elements. */
interface WindowRead {
  title: string | null
  bounds: Bounds | null
  shot: { width: number; height: number } | null
  /** Element frames in screen points, by their row in the window's latest snapshot. */
  frames: Map<number, Bounds>
}

/** The app a call touches, as the label on the composer shows it. */
interface Using {
  name: string
  path: string | null
  action: 'read' | 'act'
}

/** A setup a session's calls wait on. */
interface Setup {
  sessionId: string
  requestId: number
  steps: ComputerSetupStep[]
  done: ComputerSetupStep[]
  timer: ReturnType<typeof setTimeout>
  outcome: Promise<ComputerSetupOutcome>
  resolve: (outcome: ComputerSetupOutcome) => void
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
  /** Which process and window each snapshot read, for the element tokens it gave. */
  private readonly snapshots = new Map<string, { pid: number; windowId: number }>()
  /** What the latest reads of each window say, by `pid:window`. */
  private readonly windows = new Map<string, WindowRead>()
  private actSeq = 0
  private apps: { at: number; list: Promise<DriverApp[]> } | null = null
  /** Setups waiting for the user, by session. */
  private readonly setups = new Map<string, Setup>()
  /** Sessions whose turn the user did not set computer use up for, and how, not asked again. */
  private readonly notSetUp = new Map<string, 'declined' | 'timeout'>()
  /** The macOS permissions were seen granted, so calls stop checking them. */
  private permissionsSeen = false
  private poll: ReturnType<typeof setTimeout> | null = null
  private polling = false

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

  /** Not now on a setup card, from any window or device; false when nothing waits on it. */
  declineSetup(requestId: number): boolean {
    const setup = [...this.setups.values()].find((s) => s.requestId === requestId)
    if (!setup) return false
    this.settleSetup(setup, 'declined')
    return true
  }

  /** The user pressed Stop using: the driver ends, and the turn may not use the computer again. */
  stop(sessionId: string): void {
    if (this.hold?.sessionId !== sessionId) return
    this.stopped.add(sessionId)
    this.settleSession(sessionId)
    this.release(sessionId)
    void this.deps.driver?.stop()
    this.deps.stopped(sessionId)
  }

  /** The session's turn ended: it lets go of the computer, and its next turn starts afresh. */
  turnEnded(sessionId: string): void {
    const setup = this.setups.get(sessionId)
    if (setup) this.settleSetup(setup, 'timeout')
    this.stopped.delete(sessionId)
    this.denied.delete(sessionId)
    this.notSetUp.delete(sessionId)
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
    // A setup waiting on the switch goes on at once rather than at its next check.
    if (this.setups.size > 0) void this.check()
    if (this.deps.settings().enabled) return
    for (const requestId of [...this.waiting.keys()]) this.settle(requestId, 'timeout')
    if (this.hold) this.release(this.hold.sessionId)
    void this.deps.driver?.stop()
  }

  /** Take over: the session's calls to its app wait until the user hands it back. */
  takeOver(sessionId: string): void {
    const hold = this.hold
    if (hold?.sessionId !== sessionId || hold.control === 'you') return
    hold.control = 'you'
    // The user may hold the app as long as they like; the hold lasts until the turn ends.
    if (hold.timer) clearTimeout(hold.timer)
    hold.timer = null
    this.emit(hold)
  }

  /** Hand back: the calls that waited go on, and so does the agent. */
  handBack(sessionId: string): void {
    const hold = this.hold
    if (hold?.sessionId !== sessionId || hold.control === 'agent') return
    hold.control = 'agent'
    this.arm(hold)
    this.emit(hold)
    this.wake(hold)
  }

  /** What the floating label and the stop shortcut ask for the session holding the computer. */
  control(sessionId: string, action: 'take-over' | 'hand-back' | 'stop'): void {
    if (action === 'take-over') this.takeOver(sessionId)
    else if (action === 'hand-back') this.handBack(sessionId)
    else this.stop(sessionId)
  }

  /** Show app: brings the window the session uses to the front, for the user to look at. */
  async show(sessionId: string): Promise<void> {
    const hold = this.hold
    const driver = this.deps.driver
    if (hold?.sessionId !== sessionId || !hold.window || !driver) return
    const { pid, id } = hold.window
    const result = await driver.call('bring_to_front', { pid, window_id: id })
    if (result.isError && !cameForward(result, id)) {
      throw new Error(firstText(result) || 'The app could not come to the front.')
    }
  }

  /** Where the window the holding session uses is now; null without one, or when it is gone. */
  async frame(): Promise<ComputerFrame | null> {
    const hold = this.hold
    const driver = this.deps.driver
    if (!hold?.window || !driver) return null
    const { pid, id } = hold.window
    const result = await driver.call('list_windows', { pid })
    const found = windowsOf(result).find((entry) => entry.window_id === id)
    const bounds = found ? boundsOf(found.bounds) : null
    if (!found || !bounds) return null
    const title = typeof found.title === 'string' ? found.title : null
    if (title !== null && title !== hold.window.title && this.hold === hold) {
      hold.window = { ...hold.window, title }
      this.emit(hold)
    }
    return {
      bounds,
      visible: found.is_on_screen !== false && found.on_current_space !== false,
      title,
    }
  }

  /** The host stops: so does the driver. */
  async shutdown(): Promise<void> {
    for (const setup of [...this.setups.values()]) this.settleSetup(setup, 'timeout')
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
    const refusal = this.deps.turnRefusal(sessionId)
    if (refusal) throw new ComputerToolError('unavailable', refusal)
    if (this.stopped.has(sessionId)) throw stoppedError()
    await this.setUp(sessionId)
    if (this.stopped.has(sessionId)) throw stoppedError()
    this.take(sessionId)
    if (call.pid === null) return this.listApps(driver)
    const { app, path } = await this.appOf(driver, call.pid)
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
    if (
      call.elementToken &&
      this.snapshots.get(tokenSnapshot(call.elementToken))?.pid !== call.pid
    ) {
      throw invalidToken()
    }
    await this.approve(sessionId, app)
    // The user may have pressed Stop, or another session taken over, while the card waited.
    if (this.stopped.has(sessionId)) throw stoppedError()
    if (this.hold?.sessionId === sessionId && this.hold.control === 'you') {
      const waited = await this.waitForHandBack(this.hold)
      if (this.stopped.has(sessionId) || waited === 'released') throw stoppedError()
      if (waited === 'later') return stillTheirs(this.hold?.app ?? app.name)
    }
    this.take(sessionId, { name: app.name, path, action: call.acts ? 'act' : 'read' }, call)
    const read = call.tool === 'computer_get_window_state'
    // Every row's frame comes back too, for placing the agent's pointer; the agent sees none.
    const args =
      read && call.args.include_accessibility_tree !== false
        ? { ...call.args, tree_format: 'both' }
        : call.args
    const result = await driver.call(call.driverTool, args)
    if (read && call.windowId !== null) {
      this.remember(result, call.pid, call.windowId, call.args.since !== undefined)
      this.titled(call.pid, call.windowId)
    }
    return passed(result)
  }

  /**
   * Waits while the user holds the app: `handed` once they hand it back, `released` when the hold
   * ends, as on Stop or the turn's end, and `later` when the wait runs past its limit.
   */
  private waitForHandBack(hold: Hold): Promise<'handed' | 'released' | 'later'> {
    return new Promise((resolve) => {
      const done = (outcome: 'handed' | 'released' | 'later') => {
        clearTimeout(timer)
        hold.waiters.delete(wake)
        resolve(outcome)
      }
      const wake = () => done(this.hold === hold ? 'handed' : 'released')
      const timer = setTimeout(() => done('later'), TAKEN_OVER_WAIT_MS)
      timer.unref?.()
      hold.waiters.add(wake)
    })
  }

  private wake(hold: Hold): void {
    for (const wake of [...hold.waiters]) wake()
  }

  /**
   * Waits while the user sets computer use up, when the switch is off or a macOS permission is
   * missing; fails once they say Not now or do not finish in time, for the rest of the turn.
   */
  private async setUp(sessionId: string): Promise<void> {
    const before = this.notSetUp.get(sessionId)
    if (before) throw notSetUpError(before)
    let setup = this.setups.get(sessionId)
    if (!setup) {
      const steps = await this.missing()
      if (steps.length === 0) return
      // Another call of the session may have asked while this one checked.
      setup = this.setups.get(sessionId) ?? this.askSetup(sessionId, steps)
    }
    const outcome = await setup.outcome
    if (outcome !== 'ready') throw notSetUpError(outcome)
  }

  /** What computer use lacks on this computer, in the order a card explains it. */
  private async missing(): Promise<ComputerSetupStep[]> {
    const steps: ComputerSetupStep[] = []
    if (!this.deps.settings().enabled) steps.push('enable')
    if (this.deps.platform !== 'darwin' || this.permissionsSeen || !this.deps.permissions) {
      return steps
    }
    let granted: ComputerPermissions | null = null
    try {
      granted = await this.deps.permissions()
    } catch (error) {
      this.deps.log('warn', `Computer use could not check permissions: ${String(error)}`)
    }
    // Unknown goes on: the driver's own error then says what is wrong.
    if (!granted) return steps
    if (!granted.accessibility) steps.push('accessibility')
    if (!granted.screenRecording) steps.push('screen-recording')
    if (granted.accessibility && granted.screenRecording) this.permissionsSeen = true
    return steps
  }

  private askSetup(sessionId: string, steps: ComputerSetupStep[]): Setup {
    const requestId = this.nextRequest++
    let resolve!: (outcome: ComputerSetupOutcome) => void
    const outcome = new Promise<ComputerSetupOutcome>((done) => (resolve = done))
    const timer = setTimeout(() => {
      const setup = this.setups.get(sessionId)
      if (setup?.requestId === requestId) this.settleSetup(setup, 'timeout')
    }, COMPUTER_SETUP_WAIT_MS)
    timer.unref?.()
    const setup: Setup = { sessionId, requestId, steps, done: [], timer, outcome, resolve }
    this.setups.set(sessionId, setup)
    this.deps.setupAsked(sessionId, requestId, steps)
    this.schedule()
    return setup
  }

  private settleSetup(setup: Setup, outcome: ComputerSetupOutcome): void {
    if (this.setups.get(setup.sessionId) !== setup) return
    this.setups.delete(setup.sessionId)
    clearTimeout(setup.timer)
    if (outcome !== 'ready') this.notSetUp.set(setup.sessionId, outcome)
    this.deps.setupSettled(setup.requestId, outcome)
    setup.resolve(outcome)
    if (this.setups.size === 0 && this.poll) {
      clearTimeout(this.poll)
      this.poll = null
    }
  }

  private schedule(): void {
    if (this.poll || this.setups.size === 0) return
    this.poll = setTimeout(() => {
      this.poll = null
      void this.check().finally(() => this.schedule())
    }, COMPUTER_SETUP_POLL_MS)
    this.poll.unref?.()
  }

  /** Checks again what the waiting setups lack: done steps show, and a setup lacking none ends. */
  private async check(): Promise<void> {
    if (this.polling || this.setups.size === 0) return
    this.polling = true
    try {
      const missing = new Set(await this.missing())
      for (const setup of [...this.setups.values()]) {
        const done = setup.steps.filter((step) => !missing.has(step))
        if (done.length !== setup.done.length) {
          setup.done = done
          this.deps.setupDone(setup.requestId, done)
        }
        if (missing.size === 0) this.settleSetup(setup, 'ready')
      }
    } finally {
      this.polling = false
    }
  }

  /** Takes the computer for the session, or fails naming the session that has it. */
  private take(sessionId: string, app?: Using, call?: ComputerCall): void {
    const hold = this.hold
    if (hold && hold.sessionId !== sessionId) {
      const title = this.deps.sessionTitle(hold.sessionId)
      throw new ComputerToolError(
        'busy',
        `Another session, “${title}”, is using the computer. Wait for it to finish, or ask the ` +
          'user.',
      )
    }
    const next: Hold = hold ?? {
      sessionId,
      app: null,
      appPath: null,
      action: null,
      window: null,
      control: 'agent',
      act: null,
      timer: null,
      waiters: new Set(),
    }
    this.arm(next)
    let changed =
      !hold ||
      (app !== undefined &&
        (app.name !== next.app || app.path !== next.appPath || app.action !== next.action))
    if (app) {
      next.app = app.name
      next.appPath = app.path
      next.action = app.action
    }
    if (call && call.pid !== null && call.windowId !== null) {
      const known = this.windows.get(windowKey(call.pid, call.windowId))
      if (next.window?.pid !== call.pid || next.window.id !== call.windowId) {
        next.window = { pid: call.pid, id: call.windowId, title: known?.title ?? null }
        changed = true
      }
      if (call.acts) {
        next.act = this.actOf(call, next.act)
        changed = true
      }
    }
    this.hold = next
    if (changed) this.emit(next)
  }

  /** The hold ends after a while without calls, unless the user holds the app. */
  private arm(hold: Hold): void {
    if (hold.timer) clearTimeout(hold.timer)
    hold.timer = null
    if (hold.control === 'you') return
    const { sessionId } = hold
    hold.timer = setTimeout(() => this.release(sessionId), HOLD_IDLE_MS)
    hold.timer.unref?.()
  }

  /** Tells the session's views and main what the hold is now. */
  private emit(hold: Hold): void {
    if (this.hold !== hold) return
    this.deps.using(hold.sessionId, {
      app: hold.app,
      appPath: hold.appPath,
      action: hold.action,
      control: hold.control,
      window: hold.window ? { id: hold.window.id, title: hold.window.title } : null,
      act: hold.act,
    })
    const agent = this.deps.agent(hold.sessionId)
    this.deps.held({
      sessionId: hold.sessionId,
      agentId: agent.id,
      agentName: agent.name,
      app: hold.app,
      appPath: hold.appPath,
      window: hold.window,
      control: hold.control,
      act: hold.act,
    })
  }

  private release(sessionId: string): void {
    const hold = this.hold
    if (hold?.sessionId !== sessionId) return
    if (hold.timer) clearTimeout(hold.timer)
    this.hold = null
    this.wake(hold)
    this.deps.using(sessionId, null)
    this.deps.held(null)
  }

  /** Where an action lands in its window, as shares of the window, kept from the last one else. */
  private actOf(call: ComputerCall, last: ComputerAct | null): ComputerAct {
    const point = this.pointOf(call)
    return {
      seq: ++this.actSeq,
      kind: ACT_KINDS[call.tool] ?? 'click',
      x: point ? point.x : (last?.x ?? null),
      y: point ? point.y : (last?.y ?? null),
    }
  }

  private pointOf(call: ComputerCall): { x: number; y: number } | null {
    if (call.pid === null || call.windowId === null) return null
    const read = this.windows.get(windowKey(call.pid, call.windowId))
    if (!read) return null
    const { args } = call
    const x = typeof args.x === 'number' ? args.x : args.to_x
    const y = typeof args.y === 'number' ? args.y : args.to_y
    if (typeof x === 'number' && typeof y === 'number' && read.shot) {
      return share(x / read.shot.width, y / read.shot.height)
    }
    if (!call.elementToken || !read.bounds) return null
    const row = Number(call.elementToken.slice(call.elementToken.indexOf(':') + 1))
    const frame = read.frames.get(row)
    if (!frame) return null
    const { bounds } = read
    return share(
      (frame.x + frame.width / 2 - bounds.x) / bounds.width,
      (frame.y + frame.height / 2 - bounds.y) / bounds.height,
    )
  }

  /** A read named the window's title: the hold on it takes it. */
  private titled(pid: number, windowId: number): void {
    const hold = this.hold
    const title = this.windows.get(windowKey(pid, windowId))?.title ?? null
    if (!hold?.window || hold.window.pid !== pid || hold.window.id !== windowId) return
    if (title === null || title === hold.window.title) return
    hold.window = { ...hold.window, title }
    this.emit(hold)
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
  private async appOf(
    driver: DriverLike,
    pid: number,
  ): Promise<{ app: ComputerApp; path: string | null }> {
    const found = (await this.listedApps(driver)).find((app) => app.pid === pid)
    const app = found ? appIdentity(found, this.deps.platform) : null
    if (!found || !app) {
      throw new ComputerToolError(
        'invalid',
        `No running app has process id ${pid}. List the apps again with computer_list_apps.`,
      )
    }
    return { app, path: found.launchPath }
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

  /**
   * Notes which window a read's snapshot is of, for the tokens it handed out, and what the read
   * says of the window. A read that only gives what changed keeps the frames of the rows it leaves
   * out. The frames of every row are Kettu's alone, so they leave the result.
   */
  private remember(result: CallToolResult, pid: number, windowId: number, diff: boolean): void {
    const found = result.structuredContent as Record<string, unknown> | undefined
    if (!found) return
    const id = found.snapshot_id
    if (typeof id === 'string') {
      this.snapshots.delete(id)
      this.snapshots.set(id, { pid, windowId })
      if (this.snapshots.size > SNAPSHOTS_KEPT) {
        this.snapshots.delete(this.snapshots.keys().next().value!)
      }
    }
    const key = windowKey(pid, windowId)
    const before = this.windows.get(key)
    const width = found.screenshot_width
    const height = found.screenshot_height
    const read: WindowRead = {
      title: typeof found.window_title === 'string' ? found.window_title : (before?.title ?? null),
      bounds: boundsOf(found.window_bounds) ?? before?.bounds ?? null,
      shot:
        typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0
          ? { width, height }
          : (before?.shot ?? null),
      frames: diff && before ? new Map(before.frames) : new Map(),
    }
    if (Array.isArray(found.elements)) {
      for (const element of found.elements as unknown[]) {
        const e = element as { element_index?: unknown; frame?: unknown } | null
        const frame = frameOf(e?.frame)
        if (typeof e?.element_index === 'number' && frame) read.frames.set(e.element_index, frame)
      }
      delete found.elements
    }
    this.windows.delete(key)
    this.windows.set(key, read)
    if (this.windows.size > WINDOWS_KEPT) this.windows.delete(this.windows.keys().next().value!)
  }
}

const ACT_KINDS: Partial<Record<ComputerCall['tool'], ComputerAct['kind']>> = {
  computer_click: 'click',
  computer_type_text: 'type',
  computer_press_key: 'key',
  computer_hotkey: 'key',
  computer_scroll: 'scroll',
  computer_drag: 'drag',
  computer_invoke_menu: 'menu',
}

function windowKey(pid: number, windowId: number): string {
  return `${pid}:${windowId}`
}

/** A point as shares of its window, or null when it lies outside the window. */
function share(x: number, y: number): { x: number; y: number } | null {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 1 || y > 1) return null
  return { x, y }
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** The driver's `{ x, y, width, height }`, in screen points. */
function boundsOf(value: unknown): Bounds | null {
  const o = value as Record<string, unknown> | null | undefined
  if (!o || !isNumber(o.x) || !isNumber(o.y) || !isNumber(o.width) || !isNumber(o.height)) {
    return null
  }
  if (o.width <= 0 || o.height <= 0) return null
  return { x: o.x, y: o.y, width: o.width, height: o.height }
}

/** An element's `{ x, y, w, h }`, in screen points. */
function frameOf(value: unknown): Bounds | null {
  const o = value as Record<string, unknown> | null | undefined
  if (!o) return null
  return boundsOf({ x: o.x, y: o.y, width: o.w, height: o.h })
}

interface DriverWindow {
  window_id?: unknown
  title?: unknown
  bounds?: unknown
  is_on_screen?: unknown
  on_current_space?: unknown
}

function windowsOf(result: CallToolResult): DriverWindow[] {
  const windows = (result.structuredContent as { windows?: unknown } | undefined)?.windows
  return Array.isArray(windows) ? (windows as DriverWindow[]) : []
}

function firstText(result: CallToolResult): string {
  const item = result.content.find((entry) => entry.type === 'text')
  return item?.type === 'text' ? item.text : ''
}

/**
 * Whether the app came forward with the window focused although the driver could not confirm the
 * window is the front one on its display: Kettu's own light sits just above it.
 */
function cameForward(result: CallToolResult, windowId: number): boolean {
  const data = result.structuredContent as
    { process_activated?: unknown; observed?: { focused_window_id?: unknown } } | undefined
  return data?.process_activated === true && data.observed?.focused_window_id === windowId
}

/** A call's answer while the user holds the app: not done, and not failed either. */
function stillTheirs(app: string): CallToolResult {
  const message =
    `The user has taken over ${app} and is still using it, so nothing was done yet. Call the ` +
    'same tool again to keep waiting; it runs once they hand the app back.'
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { code: 'user_has_control', message },
  }
}

function stoppedError(): ComputerToolError {
  return new ComputerToolError(
    'stopped',
    'The user stopped computer use for this turn. Do not use the computer again until they send ' +
      'another message.',
  )
}

function notSetUpError(outcome: 'declined' | 'timeout'): ComputerToolError {
  return new ComputerToolError(
    'unavailable',
    outcome === 'declined'
      ? 'The user chose not to set up computer use for now. Do not use the computer again in ' +
          'this turn; do the task another way, or tell the user what you needed it for.'
      : 'The user did not finish setting up computer use in time. Do not use the computer ' +
          'again in this turn; do the task another way, or tell the user what you needed it for.',
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
