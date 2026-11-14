import type { Locale } from './locale'
import type { AgentColor, SettingsFile } from './settings'
import type { ThemesState } from './themes'
import type { AgentId } from './thread'

// Who uses a surface an agent can drive: a browser tab, a device, a terminal or an app. One set of
// rules for all of them, counted by the turn rather than by the call:
//   idle   no turn uses it; the user's input goes through.
//   agent  from the turn's first call on it until the turn ends; the user's clicks and keys there
//          are held back, and only Take over takes it.
//   you    the user took over; the agent's calls wait, in segments, until Hand back.
//   asks   the agent asked the user to do a step only a person can do; its call waits for Done.

/** The surfaces an agent and the user share. */
export const CONTROL_SURFACES = ['browser', 'device', 'terminal', 'computer'] as const
export type ControlSurface = (typeof CONTROL_SURFACES)[number]

export function isControlSurface(value: unknown): value is ControlSurface {
  return (CONTROL_SURFACES as readonly unknown[]).includes(value)
}

/** What an agent asks the user to do on a surface. */
export const CONTROL_STEPS = ['sign_in', 'code', 'check', 'other'] as const
export type ControlStep = (typeof CONTROL_STEPS)[number]

export function isControlStep(value: unknown): value is ControlStep {
  return (CONTROL_STEPS as readonly unknown[]).includes(value)
}

/** How a step the agent asked for ended: the user pressed Done or Skip. */
export type ControlOutcome = 'done' | 'skipped'

export function isControlOutcome(value: unknown): value is ControlOutcome {
  return value === 'done' || value === 'skipped'
}

/** A step the agent asked the user to do. */
export interface ControlAsk {
  id: number
  step: ControlStep
  /** Where it is done: a page's site, a device's name; null when it is not known. */
  target: string | null
  /** The agent's words for why. */
  reason: string
}

/** Who uses a surface now. */
export type SurfaceControl =
  | { kind: 'idle' }
  /** `acting`: one of the agent's calls runs on it right now. */
  | { kind: 'agent'; acting: boolean }
  /** `since`: when the user took over, in ms since the epoch. */
  | { kind: 'you'; since: number }
  | { kind: 'asks'; ask: ControlAsk }

export const IDLE_CONTROL: SurfaceControl = { kind: 'idle' }

/** A surface a turn uses: everything but idle. */
export type ActiveControl = Exclude<SurfaceControl, { kind: 'idle' }>

/**
 * The longest a call waits on the user before it returns and asks the agent to call again. Under
 * the shortest tool time limit of the harnesses, Codex's 60 s for an MCP call, with room for the
 * round trip.
 */
export const CONTROL_WAIT_MS = 45_000

/** How long the bubble at a held-back click stays. */
export const HELD_BUBBLE_MS = 2_600

/**
 * Why a call that waited on the user returned without acting: the user still holds the surface or
 * still does the step (call again to keep waiting), the turn ended, or the surface is gone.
 */
export type ControlWaitReason = 'held' | 'asking' | 'stopped' | 'gone'

export class ControlWait extends Error {
  constructor(readonly reason: ControlWaitReason) {
    super(`The call stopped waiting: ${reason}`)
    this.name = 'ControlWait'
  }
}

/** How a call waits: until `deadline`, telling `waiting` when it starts and stops waiting. */
export interface ControlWaitOptions {
  /** In ms since the epoch; the call returns `held` or `asking` then. */
  deadline: number
  waiting?: (waiting: boolean) => void
}

export interface SurfaceControlsDeps {
  /** A surface's state changed. */
  changed(key: string, state: SurfaceControl): void
  /** The user handed a surface back after holding it for `durationMs`. */
  handedBack?(key: string, durationMs: number): void
  now?(): number
}

interface Waiter {
  resolve(): void
  reject(error: ControlWait): void
}

interface AskWaiter {
  resolve(outcome: ControlOutcome): void
  reject(error: ControlWait): void
}

interface Surface {
  state: Exclude<SurfaceControl, { kind: 'idle' }>
  /** The agent's calls acting on it now. */
  acting: number
  /** Calls held until the surface is the agent's again. */
  waiters: Set<Waiter>
  /** Calls waiting for the step the agent asked for. */
  askers: Set<AskWaiter>
  /** The step's outcome, when the user answered while no call waited for it. */
  answered: ControlOutcome | null
}

/**
 * The state of every surface, by a key its owner chooses: a session's page now, a tab later. A
 * call takes the surface with `begin`, checks it again before each step with `gate`, and lets it
 * go with the function `begin` gave. Nothing here fails a call because the user acted: it waits.
 */
export class SurfaceControls {
  private readonly surfaces = new Map<string, Surface>()
  private nextAsk = 1

  constructor(private readonly deps: SurfaceControlsDeps) {}

  state(key: string): SurfaceControl {
    const surface = this.surfaces.get(key)
    if (!surface) return IDLE_CONTROL
    if (surface.state.kind === 'agent') return { kind: 'agent', acting: surface.acting > 0 }
    return surface.state
  }

  /** Whether the user's clicks and keys on the surface are held back now. */
  holdsInput(key: string): boolean {
    return this.surfaces.get(key)?.state.kind === 'agent'
  }

  /** The keys of every surface a turn uses. */
  keys(): string[] {
    return [...this.surfaces.keys()]
  }

  /**
   * A call starts on the surface: the turn uses it from now on. While the user holds it, the call
   * waits; it settles with the function that ends the call once it may act.
   */
  async begin(key: string, options: ControlWaitOptions): Promise<() => void> {
    let surface = this.surfaces.get(key)
    if (!surface) {
      surface = {
        state: { kind: 'agent', acting: false },
        acting: 0,
        waiters: new Set(),
        askers: new Set(),
        answered: null,
      }
      this.surfaces.set(key, surface)
    } else {
      // Any other call means the agent moved on from the step it asked for.
      surface.answered = null
    }
    if (surface.state.kind !== 'agent') await this.wait(key, surface, options)
    const current = this.surfaces.get(key)
    if (!current) throw new ControlWait('gone')
    current.acting += 1
    if (current.acting === 1) this.emit(key)
    let ended = false
    return () => {
      if (ended) return
      ended = true
      const live = this.surfaces.get(key)
      if (live !== current) return
      live.acting -= 1
      if (live.acting === 0 && live.state.kind === 'agent') this.emit(key)
    }
  }

  /** A call in flight goes on with its next step; it waits while the user holds the surface. */
  async gate(key: string, options: ControlWaitOptions): Promise<void> {
    const surface = this.surfaces.get(key)
    if (!surface) throw new ControlWait('stopped')
    if (surface.state.kind === 'agent') return
    // Its own step waits like a new call; the surface reads as not acting meanwhile.
    surface.acting -= 1
    if (surface.acting === 0) this.emit(key)
    try {
      await this.wait(key, surface, options)
    } finally {
      const live = this.surfaces.get(key)
      if (live === surface) {
        live.acting += 1
        if (live.acting === 1 && live.state.kind === 'agent') this.emit(key)
      }
    }
  }

  /** The user's Take over: the surface is theirs until they hand it back or the turn ends. */
  takeOver(key: string): boolean {
    const surface = this.surfaces.get(key)
    if (surface?.state.kind !== 'agent') return false
    surface.state = { kind: 'you', since: this.now() }
    this.emit(key)
    return true
  }

  /** The user's Hand back: the agent goes on, and its waiting calls with it. */
  handBack(key: string): boolean {
    const surface = this.surfaces.get(key)
    if (surface?.state.kind !== 'you') return false
    const held = Math.max(0, this.now() - surface.state.since)
    surface.state = { kind: 'agent', acting: false }
    this.release(surface)
    this.emit(key)
    this.deps.handedBack?.(key, held)
    return true
  }

  /**
   * The agent asks the user to do a step on the surface, which is theirs while it waits. A call
   * made again while the step waits, after an earlier one returned `asking`, waits for the same
   * step; an answer given between the two is its outcome.
   */
  async ask(
    key: string,
    step: { step: ControlStep; target: string | null; reason: string },
    options: ControlWaitOptions,
  ): Promise<ControlOutcome> {
    let surface = this.surfaces.get(key)
    if (surface?.answered) {
      const outcome = surface.answered
      surface.answered = null
      return outcome
    }
    if (!surface) {
      surface = {
        state: { kind: 'agent', acting: false },
        acting: 0,
        waiters: new Set(),
        askers: new Set(),
        answered: null,
      }
      this.surfaces.set(key, surface)
    }
    if (surface.state.kind !== 'asks') {
      surface.state = { kind: 'asks', ask: { id: this.nextAsk++, ...step } }
      this.emit(key)
    }
    const asking = surface
    return new Promise<ControlOutcome>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          asking.askers.delete(asker)
          asker.reject(new ControlWait('asking'))
        },
        Math.max(0, options.deadline - this.now()),
      )
      const asker: AskWaiter = {
        resolve: (outcome) => {
          clearTimeout(timer)
          options.waiting?.(false)
          resolve(outcome)
        },
        reject: (error) => {
          clearTimeout(timer)
          options.waiting?.(false)
          reject(error)
        },
      }
      asking.askers.add(asker)
      options.waiting?.(true)
    })
  }

  /** Done or Skip on the step the agent asked for; false when none waits. */
  answer(key: string, outcome: ControlOutcome): boolean {
    const surface = this.surfaces.get(key)
    if (surface?.state.kind !== 'asks') return false
    surface.state = { kind: 'agent', acting: false }
    const askers = [...surface.askers]
    surface.askers.clear()
    if (askers.length === 0) surface.answered = outcome
    for (const asker of askers) asker.resolve(outcome)
    this.release(surface)
    this.emit(key)
    return true
  }

  /** The turn that used the surface ended, however it ended: it is nobody's now. */
  turnEnded(key: string): void {
    this.end(key, 'stopped')
  }

  /** The surface is gone: whatever waits on it fails. */
  forget(key: string): void {
    this.end(key, 'gone')
  }

  private end(key: string, reason: 'stopped' | 'gone'): void {
    const surface = this.surfaces.get(key)
    if (!surface) return
    this.surfaces.delete(key)
    const error = new ControlWait(reason)
    for (const waiter of [...surface.waiters]) waiter.reject(error)
    surface.waiters.clear()
    for (const asker of [...surface.askers]) asker.reject(error)
    surface.askers.clear()
    this.deps.changed(key, IDLE_CONTROL)
  }

  /** Waits until the surface is the agent's, the deadline passes or the turn ends. */
  private wait(key: string, surface: Surface, options: ControlWaitOptions): Promise<void> {
    const reason = surface.state.kind === 'asks' ? 'asking' : 'held'
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          surface.waiters.delete(waiter)
          const live = this.surfaces.get(key)
          waiter.reject(new ControlWait(live?.state.kind === 'asks' ? 'asking' : reason))
        },
        Math.max(0, options.deadline - this.now()),
      )
      const waiter: Waiter = {
        resolve: () => {
          clearTimeout(timer)
          options.waiting?.(false)
          resolve()
        },
        reject: (error) => {
          clearTimeout(timer)
          options.waiting?.(false)
          reject(error)
        },
      }
      surface.waiters.add(waiter)
      options.waiting?.(true)
    })
  }

  private release(surface: Surface): void {
    const waiters = [...surface.waiters]
    surface.waiters.clear()
    for (const waiter of waiters) waiter.resolve()
  }

  private emit(key: string): void {
    this.deps.changed(key, this.state(key))
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}

// The overlay over a surface Kettu draws natively, such as a browser page: a transparent page of
// the app's own that holds back the user's clicks and keys while the agent has the surface, and
// draws the pill, the bubble, the agent's pointer and the light. Main and the overlay's page speak
// over the overlay's own channel; the page gets nothing else.

/** What the user holds on a surface, as the pill and the bubble name it. */
export type ControlScope = 'tab' | 'device' | 'terminal' | 'app'

/** The agent that uses a surface, as the pill names and marks it. */
export interface ControlAgent {
  id: AgentId
  name: string
  /** The dot an added agent's mark carries; null for a harness's default agent. */
  dot: AgentColor | null
}

/**
 * What the overlay draws. `full`: it covers the whole surface, holds back input and draws the
 * light; `pill`: it covers only the pill, so the user uses the surface around it.
 */
export interface ControlOverlayState {
  control: SurfaceControl
  agent: ControlAgent | null
  scope: ControlScope
  layout: 'full' | 'pill'
  /** The surface's corner radius, in the overlay's CSS pixels. */
  radius: number
  /** The surface's width in the overlay's CSS pixels, which the pill keeps inside in either layout. */
  width: number
}

/** A point on the surface in the overlay's CSS pixels. */
export interface ControlPoint {
  x: number
  y: number
}

/** Room the overlay's page leaves around the pill for its shadow, in its CSS pixels. */
export const OVERLAY_PILL_ROOM = 12

/** The pill's gap from the surface's bottom edge, in the overlay's CSS pixels. */
export const OVERLAY_PILL_BOTTOM = 14

/** What main tells the overlay's page. */
export type ControlOverlayEvent =
  | { type: 'state'; state: ControlOverlayState }
  /** The agent acts: at a point, which its pointer glides to, or on the surface as a whole. */
  | { type: 'act'; at: ControlPoint | null; click: boolean }
  /** The user's input reached the surface itself and was held back there. */
  | { type: 'held'; at: ControlPoint | null }

/** What the overlay's page asks of main. */
export type ControlOverlayRequest =
  | { type: 'ready' }
  | { type: 'take-over' }
  | { type: 'hand-back' }
  | { type: 'answer'; outcome: ControlOutcome }
  /** A wheel over the surface, which goes through to it. */
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  /** The pill's box with its shadow's room, in CSS pixels, for the `pill` layout's bounds. */
  | { type: 'pill'; width: number; height: number }

const MAX_WHEEL = 10_000
const MAX_EDGE = 100_000

/** A request from the overlay's page, or null when it is not one: the page is untrusted input. */
export function parseOverlayRequest(value: unknown): ControlOverlayRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const request = value as Record<string, unknown>
  const finite = (key: string, limit: number): boolean =>
    typeof request[key] === 'number' &&
    Number.isFinite(request[key]) &&
    Math.abs(request[key]) <= limit
  switch (request.type) {
    case 'ready':
    case 'take-over':
    case 'hand-back':
      return { type: request.type }
    case 'answer':
      return isControlOutcome(request.outcome) ? { type: 'answer', outcome: request.outcome } : null
    case 'wheel':
      if (!['x', 'y'].every((key) => finite(key, MAX_EDGE))) return null
      if (!['deltaX', 'deltaY'].every((key) => finite(key, MAX_WHEEL))) return null
      return {
        type: 'wheel',
        x: request.x as number,
        y: request.y as number,
        deltaX: request.deltaX as number,
        deltaY: request.deltaY as number,
      }
    case 'pill':
      if (!finite('width', MAX_EDGE) || !finite('height', MAX_EDGE)) return null
      if ((request.width as number) <= 0 || (request.height as number) <= 0) return null
      return { type: 'pill', width: request.width as number, height: request.height as number }
    default:
      return null
  }
}

/** The overlay's channels, between its preload and main. */
export const OVERLAY_CHANNELS = {
  event: 'control-overlay:event',
  request: 'control-overlay:request',
  settings: 'control-overlay:settings',
  settingsChanged: 'control-overlay:settings-changed',
  themes: 'control-overlay:themes',
  themesChanged: 'control-overlay:themes-changed',
} as const

/** What the overlay's preload exposes as `window.kettu`: the reads it shares and its channel. */
export interface ControlOverlayApi {
  platform: string
  client: 'desktop'
  systemLocale: Locale
  settings: {
    get(): Promise<SettingsFile>
    onChanged(listener: (settings: SettingsFile) => void): () => void
  }
  themes: {
    get(): Promise<ThemesState>
    onChanged(listener: (state: ThemesState) => void): () => void
  }
  overlay: {
    onEvent(listener: (event: ControlOverlayEvent) => void): () => void
    request(request: ControlOverlayRequest): void
  }
}
