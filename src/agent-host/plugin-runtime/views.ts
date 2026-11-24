// Opening a plugin's view and running its actions: the host wakes the plugin's script for the view,
// asks it for the view's data or tells it the action, checks the answer against the format and
// hands a window either the view or why it did not come out. Nothing here throws for what a
// plugin does: a script that fails, hangs or answers badly gives an error that one view shows.

import {
  PLUGIN_VIEW_LIMITS,
  viewTrigger,
  type PluginViewActionInput,
  type PluginViewActionRequest,
  type PluginViewActionResult,
  type PluginViewDataRequest,
  type PluginViewDecl,
  type PluginViewError,
  type PluginViewParams,
  type PluginViewResult,
} from '@shared/plugin-views'
import { PluginRequestError, type PluginDeadline } from '@shared/plugin-host'
import { parseActionResult, parseViewContent, ViewDataError } from './view-data'

/** The plugin host, as the views use it. */
export interface ViewClient {
  activate(pluginId: string, trigger: string): Promise<void>
  hook(
    pluginId: string,
    name: string,
    payload: unknown,
    deadline?: PluginDeadline,
  ): Promise<unknown[]>
}

export interface PluginViewsDeps {
  client: ViewClient
  /** The views of a plugin that is installed and on; none for one that is off or has no script. */
  views(pluginId: string): PluginViewDecl[]
  locale(): string
  log(level: 'info' | 'warn', message: string): void
}

// A listener that throws is left out of a hook's answers, so a throw and a missing listener look
// alike here; the plugin's own log says which.
const NO_VIEW = 'No listener of view.data gave a view; the plugin’s log says why if one threw'
const NO_ACTION = 'No listener of view.action answered; the plugin’s log says why if one threw'

type Asked = { ok: true; answers: unknown[] } | { ok: false; error: PluginViewError }

function cut(text: string): string {
  return text.slice(0, PLUGIN_VIEW_LIMITS.error)
}

/** What a failed request to a plugin means for the view that asked. */
function failure(error: unknown): PluginViewError {
  if (error instanceof PluginRequestError) {
    switch (error.code) {
      case 'invalid':
      case 'not_declared':
        return { code: 'not_found' }
      case 'disabled':
        return { code: 'disabled' }
      case 'crashed':
        return { code: 'crashed' }
      case 'timeout':
        return { code: 'timeout' }
      case 'unavailable':
      case 'not_active':
        return { code: 'unavailable' }
      case 'too_large':
        return { code: 'invalid', detail: cut(error.message) }
      default:
        return { code: 'failed', detail: cut(error.message) }
    }
  }
  return { code: 'failed', detail: cut(error instanceof Error ? error.message : String(error)) }
}

export class PluginViews {
  constructor(private readonly deps: PluginViewsDeps) {}

  /** The data of a view as its script gives it now. */
  async data(
    pluginId: string,
    viewId: string,
    params: PluginViewParams,
  ): Promise<PluginViewResult> {
    const decls = this.deps.views(pluginId)
    const decl = decls.find((view) => view.id === viewId)
    if (!decl) return { ok: false, error: { code: 'not_found' } }
    const request: PluginViewDataRequest = {
      view: viewId,
      params,
      locale: this.deps.locale(),
    }
    const asked = await this.ask(pluginId, viewId, 'view.data', request)
    if (!asked.ok) return asked
    const answer = asked.answers.find((item) => item !== null && item !== undefined)
    if (answer === undefined) {
      return {
        ok: false,
        error: { code: 'failed', detail: NO_VIEW },
      }
    }
    try {
      const check = { views: new Set(decls.map((view) => view.id)) }
      return { ok: true, view: parseViewContent(decl.kind, answer, check) }
    } catch (error) {
      if (!(error instanceof ViewDataError)) throw error
      this.deps.log('warn', `${pluginId} gave a view ${viewId} that does not fit: ${error.message}`)
      return { ok: false, error: { code: 'invalid', detail: cut(error.message) } }
    }
  }

  /** Tells the script of a view that one of its actions ran, and says what it answered. */
  async act(
    pluginId: string,
    viewId: string,
    params: PluginViewParams,
    input: PluginViewActionInput,
  ): Promise<PluginViewActionResult> {
    const decls = this.deps.views(pluginId)
    if (!decls.some((view) => view.id === viewId))
      return { ok: false, error: { code: 'not_found' } }
    const request: PluginViewActionRequest = {
      view: viewId,
      params,
      locale: this.deps.locale(),
      action: input.action,
      ...(input.row === undefined ? {} : { row: input.row }),
      ...(input.values === undefined ? {} : { values: input.values }),
    }
    const asked = await this.ask(pluginId, viewId, 'view.action', request)
    if (!asked.ok) return asked
    if (asked.answers.length === 0) {
      return {
        ok: false,
        error: { code: 'failed', detail: NO_ACTION },
      }
    }
    try {
      const check = { views: new Set(decls.map((view) => view.id)) }
      return parseActionResult(
        asked.answers.find((item) => item !== null && item !== undefined),
        check,
      )
    } catch (error) {
      if (!(error instanceof ViewDataError)) throw error
      this.deps.log('warn', `${pluginId} answered an action of ${viewId} badly: ${error.message}`)
      return { ok: false, error: { code: 'invalid', detail: cut(error.message) } }
    }
  }

  private async ask(
    pluginId: string,
    viewId: string,
    event: 'view.data' | 'view.action',
    payload: unknown,
  ): Promise<Asked> {
    try {
      await this.deps.client.activate(pluginId, viewTrigger(viewId))
      return { ok: true, answers: await this.deps.client.hook(pluginId, event, payload, 'call') }
    } catch (error) {
      const out = failure(error)
      this.deps.log(
        'warn',
        `${pluginId} did not answer ${event} for ${viewId}: ${out.code}${out.detail ? `: ${out.detail}` : ''}`,
      )
      return { ok: false, error: out }
    }
  }
}
