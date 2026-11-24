import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  PluginFormValues,
  PluginViewAction,
  PluginViewContent,
  PluginViewError,
  PluginViewParams,
  PluginViewResult,
} from '@shared/plugin-views'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage, type HostRequest } from '@renderer/lib/host'

export interface ViewEntry {
  view: string
  params: PluginViewParams
}

export type ViewState =
  | { status: 'loading' }
  // A new `revision` is a new read, which a form starts over from.
  | { status: 'ready'; view: PluginViewContent; revision: number }
  | { status: 'error'; error: PluginViewError }

export interface ActionExtra {
  /** The row whose action it is. */
  row?: string
  /** A form's values. */
  values?: PluginFormValues
}

/** What a view's parts take to run an action. */
export interface ActionHandle {
  run(action: PluginViewAction, extra?: ActionExtra): void
  /** The action that is running, as `busyKey` names it. */
  busy: string | null
}

export function busyKey(action: PluginViewAction, extra: ActionExtra = {}): string {
  return `${action.id}:${extra.row ?? ''}`
}

interface Shown {
  entry: ViewEntry
  state: Exclude<ViewState, { status: 'loading' }>
}

/**
 * A view of a plugin as its host gives it: the data of the view on top of a stack that an action
 * that opens another view pushes onto, a refresh, and the actions that run the plugin's script.
 * A failure of the plugin, or of the request, is a state of the view and never a throw.
 */
export function usePluginView(request: HostRequest, pluginId: string, first: ViewEntry) {
  const { t } = useTranslation('plugin-views')
  const requestRef = useRef(request)
  useEffect(() => {
    requestRef.current = request
  })
  const [stack, setStack] = useState<ViewEntry[]>([first])
  const entry = stack[stack.length - 1]!
  const [shown, setShown] = useState<Shown | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  // Only the newest read counts, so an answer that comes late never replaces a newer one.
  const newest = useRef(0)

  const read = useCallback(
    async (target: ViewEntry) => {
      const mine = ++newest.current
      let result: PluginViewResult
      try {
        result = await requestRef.current('plugins.viewData', {
          pluginId,
          viewId: target.view,
          params: target.params,
        })
      } catch (error) {
        result = { ok: false, error: { code: 'request_failed', detail: errorMessage(error) } }
      }
      if (mine !== newest.current) return
      setRefreshing(false)
      setShown({
        entry: target,
        state: result.ok
          ? { status: 'ready', view: result.view, revision: mine }
          : { status: 'error', error: result.error },
      })
    },
    [pluginId],
  )

  useEffect(() => {
    void read(entry)
  }, [read, entry])

  const state: ViewState = shown?.entry === entry ? shown.state : { status: 'loading' }

  const open = useCallback((target: ViewEntry) => setStack((s) => [...s, target]), [])
  const back = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), [])
  const reload = useCallback(() => {
    setRefreshing(true)
    void read(entry)
  }, [read, entry])

  const execute = useCallback(
    async (action: PluginViewAction, extra: ActionExtra) => {
      setBusy(busyKey(action, extra))
      const failed = (text: string) => toast(text, undefined, { tone: 'warning' })
      try {
        const result = await requestRef.current('plugins.viewAction', {
          pluginId,
          viewId: entry.view,
          params: entry.params,
          action: action.id,
          ...extra,
        })
        if (!result.ok) {
          const { code, detail } = result.error
          const text = t(`actionError.${code}`, { label: action.label })
          failed(detail ? `${text}: ${detail}` : text)
        } else {
          if (result.notice) toast(result.notice, undefined, { tone: 'success' })
          if (result.open) open({ view: result.open.view, params: result.open.params ?? {} })
          else reload()
        }
      } catch (error) {
        failed(
          `${t('actionError.request_failed', { label: action.label })}: ${errorMessage(error)}`,
        )
      } finally {
        setBusy(null)
      }
    },
    [pluginId, entry, open, reload, t],
  )

  return { entry, depth: stack.length, state, refreshing, busy, open, back, reload, execute }
}
