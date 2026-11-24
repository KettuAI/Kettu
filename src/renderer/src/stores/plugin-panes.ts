import { closeDoc, docKey, useViewStore, type DocTab } from './view'

/** The keys of the plugin tabs whose pane is not among `present`, as `pluginPaneId` names panes. */
export function gonePluginTabs(docs: readonly DocTab[], present: ReadonlySet<string>): string[] {
  return docs.flatMap((tab) => (tab.kind === 'plugin' && !present.has(tab.id) ? [docKey(tab)] : []))
}

// The panels whose restored tabs were checked in this run.
const checked = new Set<string>()

/**
 * A restart brings back a panel's plugin tabs as they were saved; this takes off those whose
 * plugin is no longer installed and on, or no longer has the pane. It acts once per panel and
 * run: a plugin turned off while its tab is open leaves the tab to show that the view is gone.
 */
export function dropGonePluginPanes(panel: string, present: ReadonlySet<string>): void {
  if (checked.has(panel)) return
  checked.add(panel)
  for (const key of gonePluginTabs(useViewStore.getState().sideDocs[panel] ?? [], present)) {
    closeDoc(panel, key)
  }
}
