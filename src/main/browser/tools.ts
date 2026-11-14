// Main's side of the browser tools: the pages BrowserViews holds, who uses each of them, and the
// DevTools protocol layer that drives them, as one service the agent host talks to.

import type { WebContents } from 'electron'
import type { BrowserCallAnswer, BrowserToolError, BrowserToolName } from '@shared/browser'
import { BROWSER_TOOL_NAMES } from '@shared/browser'
import {
  CONTROL_WAIT_MS,
  SurfaceControls,
  type ControlOutcome,
  type SurfaceControl,
} from '@shared/control'
import { BrowserCdp, ToolFailure } from './cdp'
import type { BrowserViews, NavigateResult } from './views'

export interface BrowserToolsDeps {
  views: BrowserViews
  /** Who uses a page changed, so the pane, the label and the overlay draw it. */
  controlChanged(sessionId: string, state: SurfaceControl): void
  /** The user handed a page back after holding it for `durationMs`, for the session's thread. */
  handedBack?(sessionId: string, durationMs: number): void
  /** The agent acted on a page, at a point or on it as a whole. */
  acted?(sessionId: string, at: { x: number; y: number } | null, click: boolean): void
  /** The first navigation of a session opened its page: the pane may show it. */
  opened(sessionId: string): void
  log(level: 'warn' | 'error', message: string): void
  /** A call waits for the user to answer a new origin: its own time limit covers that wait. */
  waiting?(callId: number, waiting: boolean): void
}

function isName(value: string): value is BrowserToolName {
  return (BROWSER_TOOL_NAMES as readonly string[]).includes(value)
}

export class BrowserTools {
  readonly controls: SurfaceControls
  readonly cdp: BrowserCdp
  /** Sessions that already had their page opened for an agent's navigation. */
  private readonly opened = new Set<string>()

  constructor(private readonly deps: BrowserToolsDeps) {
    this.controls = new SurfaceControls({
      changed: (sessionId, state) => {
        deps.controlChanged(sessionId, state)
        // A hidden page a turn uses renders fully; it throttles again once the turn ended.
        deps.views.setDriving(sessionId, state.kind !== 'idle')
      },
      handedBack: (sessionId, ms) => deps.handedBack?.(sessionId, ms),
    })
    this.cdp = new BrowserCdp({
      contents: (sessionId) => deps.views.contents(sessionId),
      load: async (sessionId, url) => {
        const result = await deps.views.load(sessionId, url)
        if (!result.ok) throw refused(result)
        this.firstOpen(sessionId)
        return result
      },
      back: async (sessionId) => {
        const result = await deps.views.backAndWait(sessionId)
        if (!result.ok) throw refused(result)
        return result
      },
      reload: async (sessionId) => {
        const result = await deps.views.reloadAndWait(sessionId)
        if (!result.ok) throw refused(result)
        return result
      },
      controls: this.controls,
      acted: (sessionId, at, click) => deps.acted?.(sessionId, at, click),
      log: (level, message) => deps.log(level, message),
    })
  }

  /** The state of a session's page. */
  control(sessionId: string): SurfaceControl {
    return this.controls.state(sessionId)
  }

  /** A page was made: its debugger's events flow to the page's buffers from here on. */
  watch(sessionId: string, contents: WebContents): void {
    this.cdp.watch(sessionId, contents)
  }

  /** Take over, from the label, the pill or the bubble: the page is the user's until Hand back. */
  takeOver(sessionId: string): void {
    this.controls.takeOver(sessionId)
  }

  /** Hand back: the agent goes on, and its waiting calls with it. */
  handBack(sessionId: string): void {
    this.controls.handBack(sessionId)
  }

  /** Done or Skip on the step the agent asked for, from the label, the pill or the thread. */
  answerAsk(sessionId: string, outcome: ControlOutcome): void {
    this.controls.answer(sessionId, outcome)
  }

  /** The turn that used the session's page ended: the page is nobody's, and waiting calls end. */
  turnEnded(sessionId: string): void {
    this.controls.turnEnded(sessionId)
  }

  /** The agent host went away: no turn uses any page now. */
  endTurns(sessionIds: readonly string[] = this.controls.keys()): void {
    for (const sessionId of sessionIds) this.controls.turnEnded(sessionId)
  }

  /** Whether an input event a page reports right now is the agent's own. */
  isInjecting(sessionId: string): boolean {
    return this.cdp.isInjecting(sessionId)
  }

  /** A page opened a dialog, which views.ts answered at once. */
  dialogOpened(sessionId: string, type: string, accepted: boolean): void {
    this.cdp.dialogOpened(sessionId, type, accepted)
  }

  /** The session's page crashed or stopped responding: its call in flight fails now. */
  pageFailed(sessionId: string, kind: 'crashed' | 'unresponsive', message: string): void {
    this.cdp.pageFailed(sessionId, kind, message)
  }

  /** The session's page is gone: nothing more drives it. */
  forget(sessionId: string): void {
    this.controls.forget(sessionId)
    this.cdp.forget(sessionId)
    this.opened.delete(sessionId)
  }

  /**
   * Runs a call the agent host forwarded, and answers its result or error. `waiting` hears that
   * the call waits on a new origin, in place of `deps.waiting`, for a call of another host's.
   */
  async call(
    callId: number,
    sessionId: string,
    tool: string,
    args: Record<string, unknown>,
    projectPath = '',
    waiting?: (waiting: boolean) => void,
  ): Promise<BrowserCallAnswer> {
    if (!isName(tool)) {
      return error('invalid', `Unknown browser tool ${tool}.`)
    }
    // The page's rules read the project its always-allowed sites are stored under.
    this.deps.views.setProject(sessionId, projectPath)
    // A wait for a new origin and a wait for the user may overlap; the call's limit grows while
    // either lasts.
    const report = waiting ?? ((on: boolean) => this.deps.waiting?.(callId, on))
    let waits = 0
    const wait = (on: boolean): void => {
      waits = Math.max(0, waits + (on ? 1 : -1))
      if (waits === (on ? 1 : 0)) report(on)
    }
    this.deps.views.setOriginWait(sessionId, callId, wait)
    try {
      const result = await this.cdp.call(sessionId, tool, args, {
        // Before the harness's own limit for one tool call, from when it reached main.
        deadline: Date.now() + CONTROL_WAIT_MS,
        waiting: wait,
      })
      return {
        result: {
          text: result.text,
          value: result.value,
          ...(result.image ? { image: result.image } : {}),
        },
      }
    } catch (caught) {
      if (caught instanceof ToolFailure) return error(caught.code, caught.message)
      this.deps.log('warn', `Browser call ${tool} failed: ${(caught as Error).message}`)
      return error('invalid', (caught as Error)?.message ?? String(caught))
    } finally {
      this.deps.views.setOriginWait(sessionId, callId, null)
    }
  }

  private firstOpen(sessionId: string): void {
    if (this.opened.has(sessionId)) return
    this.opened.add(sessionId)
    this.deps.opened(sessionId)
  }
}

function error(code: BrowserToolError['code'], message: string): BrowserCallAnswer {
  return { error: { code, message } }
}

/** A navigation that did not end: the user refused its site, or the page failed. */
function refused(result: Extract<NavigateResult, { ok: false }>): ToolFailure {
  return new ToolFailure(result.code ?? 'navigation_failed', result.error)
}
