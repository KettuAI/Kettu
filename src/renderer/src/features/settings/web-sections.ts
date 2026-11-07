import { isHosted } from '@renderer/lib/platform'
import type { SectionDef } from './model'

/**
 * What the web client's Settings leave out, by section and row: only what a browser cannot do.
 * The built-in browser runs in the desktop app, so only how links from agents open is left of
 * it; a page neither holds the app open nor starts at login, has no badge on a Dock or taskbar,
 * and the browser zooms it itself. Of the web clients, only the hosted one signs in to a Kettu
 * account.
 */
const LEFT_OUT: Partial<Record<SectionDef['id'], readonly string[] | 'all'>> = {
  browser: ['open-links-in', 'clear-data', 'allowed-sites'],
  // It drives the apps of the computer the desktop app runs on.
  'computer-use': 'all',
  ...(isHosted ? {} : { account: 'all' as const }),
  general: ['confirm-quit', 'background', 'open-at-login'],
  appearance: ['zoom'],
  notifications: ['badge'],
}

/**
 * The list's groups without what the web client leaves out; a section left without rows goes,
 * and so does a group left empty.
 */
export function webClusters(clusters: SectionDef[][]): SectionDef[][] {
  return clusters
    .map((cluster) =>
      cluster.flatMap((section) => {
        const rows = LEFT_OUT[section.id]
        if (!rows) return [section]
        if (rows === 'all') return []
        const kept = section.rows.filter((row) => !rows.includes(row.id))
        return kept.length > 0 ? [{ ...section, rows: kept }] : []
      }),
    )
    .filter((cluster) => cluster.length > 0)
}
