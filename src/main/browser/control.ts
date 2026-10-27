// Who drives each session's page: an agent's running call, or the user until they hand back. Any
// input in the page or the pane's controls takes control, and every agent call then fails
// `user_has_control` until the pane's Hand back.

import type { BrowserControlState } from '@shared/browser'
import { ToolFailure } from './cdp'

/** How long the "You have control" bar stays after the last call that met it. */
export const CONTROL_BAR_MS = 10_000

export interface BrowserControlDeps {
  /** A page's control state changed, for the pane. */
  changed(sessionId: string, state: BrowserControlState): void
}

interface State {
  /** An agent's call runs. */
  running: boolean
  /** The user took control; it lasts until they hand back. */
  user: boolean
  /** The hand-back bar shows while this timer runs. */
  bar: ReturnType<typeof setTimeout> | null
}

export class BrowserControl {
  private readonly states = new Map<string, State>()

  constructor(private readonly deps: BrowserControlDeps) {}

  /** The state the pane draws. */
  state(sessionId: string): BrowserControlState {
    const state = this.states.get(sessionId)
    if (!state) return { kind: 'none' }
    if (state.user) return { kind: 'user', bar: state.bar !== null }
    return state.running ? { kind: 'agent' } : { kind: 'none' }
  }

  /** Whether the user holds the page, which refuses every call until Hand back. */
  userHolds(sessionId: string): boolean {
    return this.states.get(sessionId)?.user === true
  }

  /**
   * A call starts. While the user holds the page it fails, and the hand-back bar comes back for
   * another 10 s, so the way out of their control is always one click away.
   */
  begin(sessionId: string): void {
    const state = this.get(sessionId)
    if (state.user) {
      this.showBar(state)
      throw new ToolFailure(
        'user_has_control',
        'The user has control of the browser. Wait for them to hand it back.',
      )
    }
    state.running = true
    this.emit(sessionId)
  }

  /** A call ends, however it ended. */
  end(sessionId: string): void {
    const state = this.states.get(sessionId)
    if (!state?.running) return
    state.running = false
    this.emit(sessionId)
  }

  /** The user typed in the page or used the pane's controls: they drive from now on. */
  take(sessionId: string): void {
    const state = this.get(sessionId)
    if (state.user) return
    state.user = true
    state.running = false
    this.showBar(state)
    this.emit(sessionId)
  }

  /** The driving bar's Stop: the user takes control, and the call in flight fails with it. */
  stop(sessionId: string): void {
    this.take(sessionId)
  }

  /** The pane's Hand back: the agent may drive again. */
  handBack(sessionId: string): void {
    const state = this.states.get(sessionId)
    if (!state) return
    state.user = false
    this.clearBar(state)
    this.emit(sessionId)
  }

  /** The page is gone; nothing holds it. */
  forget(sessionId: string): void {
    const state = this.states.get(sessionId)
    if (!state) return
    this.clearBar(state)
    this.states.delete(sessionId)
  }

  /** The user took control a moment ago: the call in flight stops saying so. */
  assert(sessionId: string): void {
    if (this.userHolds(sessionId)) {
      throw new ToolFailure(
        'user_has_control',
        'The user has control of the browser. Wait for them to hand it back.',
      )
    }
  }

  private get(sessionId: string): State {
    let state = this.states.get(sessionId)
    if (!state) {
      state = { running: false, user: false, bar: null }
      this.states.set(sessionId, state)
    }
    return state
  }

  /**
   * Shows Hand back for 10 s after the last call that met the user's control. The bar goes then,
   * but their control stays until they press it; the next call brings the bar back.
   */
  private showBar(state: State): void {
    this.clearBar(state)
    state.bar = setTimeout(() => {
      state.bar = null
      this.emitOf(state)
    }, CONTROL_BAR_MS)
    state.bar.unref?.()
  }

  private clearBar(state: State): void {
    if (state.bar) clearTimeout(state.bar)
    state.bar = null
  }

  private emit(sessionId: string): void {
    this.deps.changed(sessionId, this.state(sessionId))
  }

  private emitOf(state: State): void {
    for (const [sessionId, known] of this.states) {
      if (known === state) this.emit(sessionId)
    }
  }
}
