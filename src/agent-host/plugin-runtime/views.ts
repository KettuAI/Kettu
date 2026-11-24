// Opening a plugin's view and running its actions: the host wakes the plugin's script for the view,
// asks it for the view's data or tells it the action, checks the answer against the format and
// hands a window either the view or why it did not come out. The actions a plugin declares for
// Search run the same way. Nothing here throws for what a plugin does: a script that fails, hangs
// or answers badly gives an error that one view or one action shows.

import {
  actionTrigger,
  PLUGIN_VIEW_LIMITS,
  viewTrigger,
  type PluginActionDecl,
  type PluginActionRunRequest,
  type PluginViewActionInput,
  type PluginViewActionRequest,
  type PluginViewActionResult,
  type PluginViewDataRequest,
  type PluginViewDecl,
  type PluginViewError,
  type PluginViewParams,
  type PluginViewResult,
} from '@shared/plugin-views'
import { PluginRequestError, type PluginDeadline, type PluginHookReply } from '@shared/plugin-host'
import { parseActionResult, parseViewContent, ViewDataError } from './view-data'

/** The plugin host, as the views use it. */
export interface ViewClient {
  activate(pluginId: string, trigger: string): Promise<void>
  hookReply(
    pluginId: string,
    name: string,
    payload: unknown,
    deadline?: PluginDeadline,
  ): Promise<PluginHookReply>
}

export interface PluginViewsDeps {
  client: ViewClient
  /** The views of a plugin that is installed and on; none for one that is off or has no script. */
  views(pluginId: string): PluginViewDecl[]
  /** The Search actions of a plugin that is installed and on; none for one that is off. */
  actions(pluginId: string): PluginActionDecl[]
  locale(): string
  log(level: 'info' | 'warn', message: string): void
}

const NO_VIEW = 'No listener of view.data gave a view'
const NO_ACTION = 'No listener of view.action answered'
const NO_RUN = 'No listener of action.run answered'

type Asked = { ok: true; reply: PluginHookReply } | { ok: false; error: PluginViewError }

export function cut(text: string): string {
  return text.slice(0, PLUGIN_VIEW_LIMITS.error)
}

/**
 * Why no listener answered: what the first one that threw said, as the script wrote it without the
 * name a plain Error carries, else `none` for a script with no listener for the event.
 */
export function silence(reply: PluginHookReply, none: string): PluginViewError {
  const thrown = reply.errors[0]
  return {
    code: 'failed',
    detail: cut(thrown === undefined ? none : thrown.replace(/^Error: /, '')),
  }
}

/** What a failed request to a plugin means for the view that asked. */
export function failure(error: unknown): PluginViewError {
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
    const asked = await this.ask(pluginId, viewTrigger(viewId), 'view.data', request)
    if (!asked.ok) return asked
    const answer = asked.reply.answers.find((item) => item !== null && item !== undefined)
    if (answer === undefined) return { ok: false, error: silence(asked.reply, NO_VIEW) }
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
    const asked = await this.ask(pluginId, viewTrigger(viewId), 'view.action', request)
    if (!asked.ok) return asked
    if (asked.reply.answers.length === 0) {
      return { ok: false, error: silence(asked.reply, NO_ACTION) }
    }
    try {
      const check = { views: new Set(decls.map((view) => view.id)) }
      return parseActionResult(
        asked.reply.answers.find((item) => item !== null && item !== undefined),
        check,
      )
    } catch (error) {
      if (!(error instanceof ViewDataError)) throw error
      this.deps.log('warn', `${pluginId} answered an action of ${viewId} badly: ${error.message}`)
      return { ok: false, error: { code: 'invalid', detail: cut(error.message) } }
    }
  }

  /**
   * Runs one of the actions a plugin declares for Search. The answer may open a pane of the
   * plugin, which is the only view it may name.
   */
  async run(pluginId: string, actionId: string): Promise<PluginViewActionResult> {
    if (!this.deps.actions(pluginId).some((action) => action.id === actionId)) {
      return { ok: false, error: { code: 'not_found' } }
    }
    const request: PluginActionRunRequest = { action: actionId, locale: this.deps.locale() }
    const asked = await this.ask(pluginId, actionTrigger(actionId), 'action.run', request)
    if (!asked.ok) return asked
    if (asked.reply.answers.length === 0) {
      return { ok: false, error: silence(asked.reply, NO_RUN) }
    }
    try {
      const panes = this.deps.views(pluginId).filter((view) => view.pane)
      return parseActionResult(
        asked.reply.answers.find((item) => item !== null && item !== undefined),
        { views: new Set(panes.map((view) => view.id)) },
      )
    } catch (error) {
      if (!(error instanceof ViewDataError)) throw error
      this.deps.log('warn', `${pluginId} answered the action ${actionId} badly: ${error.message}`)
      return { ok: false, error: { code: 'invalid', detail: cut(error.message) } }
    }
  }

  private async ask(
    pluginId: string,
    trigger: string,
    event: 'view.data' | 'view.action' | 'action.run',
    payload: unknown,
  ): Promise<Asked> {
    const { client } = this.deps
    try {
      await client.activate(pluginId, trigger)
      try {
        return { ok: true, reply: await client.hookReply(pluginId, event, payload, 'call') }
      } catch (error) {
        // A request that ran first stopped the script before this one reached it: start it again.
        if (!(error instanceof PluginRequestError && error.code === 'not_active')) throw error
        await client.activate(pluginId, trigger)
        return { ok: true, reply: await client.hookReply(pluginId, event, payload, 'call') }
      }
    } catch (error) {
      const out = failure(error)
      this.deps.log(
        'warn',
        `${pluginId} did not answer ${event} for ${trigger}: ${out.code}${out.detail ? `: ${out.detail}` : ''}`,
      )
      return { ok: false, error: out }
    }
  }
}
