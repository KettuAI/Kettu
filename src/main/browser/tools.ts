// Main's side of the browser tools: the pages BrowserViews holds, the control state, and the
// DevTools protocol layer that drives them, as one service the agent host talks to.

import type { WebContents } from 'electron'
import type {
  BrowserCallAnswer,
  BrowserControlState,
  BrowserToolError,
  BrowserToolName,
} from '@shared/browser'
import { BROWSER_TOOL_NAMES } from '@shared/browser'
import { BrowserCdp, ToolFailure } from './cdp'
import { BrowserControl } from './control'
import type { BrowserViews } from './views'

export interface BrowserToolsDeps {
  views: BrowserViews
  /** A page's control state changed, so the pane draws it. */
  controlChanged(sessionId: string, state: BrowserControlState): void
  /** The first navigation of a session opened its page: the pane may show it. */
  opened(sessionId: string): void
  log(level: 'warn' | 'error', message: string): void
}

function isName(value: string): value is BrowserToolName {
  return (BROWSER_TOOL_NAMES as readonly string[]).includes(value)
}

export class BrowserTools {
  readonly control: BrowserControl
  readonly cdp: BrowserCdp
  /** Sessions that already had their page opened for an agent's navigation. */
  private readonly opened = new Set<string>()

  constructor(private readonly deps: BrowserToolsDeps) {
    this.control = new BrowserControl({
      changed: (sessionId, state) => {
        deps.controlChanged(sessionId, state)
        // A hidden page an agent drives renders fully; it throttles again once it is idle.
        deps.views.setDriving(sessionId, state.kind === 'agent')
      },
    })
    this.cdp = new BrowserCdp({
      contents: (sessionId) => deps.views.contents(sessionId),
      load: async (sessionId, url) => {
        const result = await deps.views.load(sessionId, url)
        if (!result.ok) throw new ToolFailure('navigation_failed', result.error)
        this.firstOpen(sessionId)
        return result
      },
      back: async (sessionId) => {
        const result = await deps.views.backAndWait(sessionId)
        if (!result.ok) throw new ToolFailure('navigation_failed', result.error)
        return result
      },
      reload: async (sessionId) => {
        const result = await deps.views.reloadAndWait(sessionId)
        if (!result.ok) throw new ToolFailure('navigation_failed', result.error)
        return result
      },
      control: this.control,
      log: (level, message) => deps.log(level, message),
    })
  }

  /** A page was made: its debugger's events flow to the page's buffers from here on. */
  watch(sessionId: string, contents: WebContents): void {
    this.cdp.watch(sessionId, contents)
  }

  /** The pane's Hand back. */
  handBack(sessionId: string): void {
    this.control.handBack(sessionId)
  }

  /** The driving bar's Stop: the call in flight fails, and the user drives from here. */
  stopDriving(sessionId: string): void {
    this.control.stop(sessionId)
  }

  /** The user typed or used the mouse in a page; an input the agent injected is not theirs. */
  userInput(sessionId: string): void {
    if (this.cdp.isInjecting(sessionId)) return
    this.control.take(sessionId)
  }

  /** A page opened a dialog, which views.ts answered at once. */
  dialogOpened(sessionId: string, type: string, accepted: boolean): void {
    this.cdp.dialogOpened(sessionId, type, accepted)
  }

  /** The session's page is gone: nothing more drives it. */
  forget(sessionId: string): void {
    this.control.forget(sessionId)
    this.cdp.forget(sessionId)
    this.opened.delete(sessionId)
  }

  /** Runs a call the agent host forwarded, and answers its result or error. */
  async call(
    sessionId: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<BrowserCallAnswer> {
    if (!isName(tool)) {
      return error('invalid', `Unknown browser tool ${tool}.`)
    }
    try {
      const result = await this.cdp.call(sessionId, tool, args)
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
