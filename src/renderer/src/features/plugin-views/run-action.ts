// Running an action a plugin declares for Search: the host asks the plugin's script, and what it
// answers is a notice to show, an error, or a pane to open beside the session in view.

import type { PluginViewParams } from '@shared/plugin-views'
import { toast } from '@renderer/components/ui/toast'
import { focusedPane } from '@renderer/features/split/layout'
import { errorMessage, hostAt } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { i18n } from '@renderer/lib/i18n'
import { openPluginPane, panelOf, sessionsShown, useViewStore } from '@renderer/stores/view'

export interface PluginActionTarget {
  /** The host the plugin is on, null being this computer. */
  hostId: string | null
  pluginId: string
  actionId: string
  /** The action's title, which its failures name. */
  label: string
}

/** Opens a pane in the side panel of the session in view, when it is on the plugin's host. */
function showPane(
  target: PluginActionTarget,
  pane: { view: string; params?: PluginViewParams },
): boolean {
  const state = useViewStore.getState()
  const view = focusedPane(state.layout).view
  const panel = panelOf(view)
  if (!panel || view.projectPath === null || !sessionsShown(state.main)) return false
  if (hostOfPath(view.projectPath) !== target.hostId) return false
  openPluginPane(panel, { pluginId: target.pluginId, viewId: pane.view, params: pane.params })
  return true
}

/** Runs the action. Nothing throws: a failure is a toast that names the action. */
export async function runPluginAction(target: PluginActionTarget): Promise<void> {
  const { label } = target
  const failed = (text: string) => toast(text, undefined, { tone: 'warning' })
  try {
    const result = await hostAt(target.hostId, 'plugins.actionRun', {
      pluginId: target.pluginId,
      actionId: target.actionId,
    })
    if (!result.ok) {
      const { code, detail } = result.error
      const text = i18n.t(`plugin-views:actionError.${code}`, { label })
      return failed(detail ? `${text}: ${detail}` : text)
    }
    if (result.notice) toast(result.notice, undefined, { tone: 'success' })
    if (result.open && !showPane(target, result.open)) {
      failed(i18n.t('plugin-views:actionNoPanel', { label }))
    }
  } catch (error) {
    failed(errorMessage(error))
  }
}
