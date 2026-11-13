// Who drives each session's page: an agent's running call, or the user until they hand back. Any
// input in the page or the pane's controls takes control, and every agent call then fails
// `user_has_control` until the pane's Hand back.

import type { BrowserControlState } from '@shared/browser'
import { ToolFailure } from './cdp'

export interface BrowserControlDeps {
  /** A page's control state changed, for the pane. */
  changed(sessionId: string, state: BrowserControlState): void
}

interface State {
  /** An agent's call runs. */
  running: boolean
  /** The user took control; it lasts until they hand back. */
  user: boolean
}

export class BrowserControl {
  private readonly states = new Map<string, State>()

  constructor(private readonly deps: BrowserControlDeps) {}

  /** The state the pane draws. */
  state(sessionId: string): BrowserControlState {
    const state = this.states.get(sessionId)
    if (!state) return { kind: 'none' }
    if (state.user) return { kind: 'user' }
    return state.running ? { kind: 'agent' } : { kind: 'none' }
  }

  /** Whether the user holds the page, which refuses every call until Hand back. */
  userHolds(sessionId: string): boolean {
    return this.states.get(sessionId)?.user === true
  }

  /** A call starts. While the user holds the page it fails. */
  begin(sessionId: string): void {
    const state = this.get(sessionId)
    if (state.user) {
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
    this.emit(sessionId)
  }

  /** The page is gone; nothing holds it. */
  forget(sessionId: string): void {
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
      state = { running: false, user: false }
      this.states.set(sessionId, state)
    }
    return state
  }

  private emit(sessionId: string): void {
    this.deps.changed(sessionId, this.state(sessionId))
  }
}
