import type { SectionDef } from './model'

/**
 * What the web client's Settings leave out, by section and row: only what a browser cannot do.
 * The built-in browser runs in the desktop app; a page neither holds the app open nor starts at
 * login, and the browser zooms it itself. Third-party notices ship with the desktop app only.
 */
const LEFT_OUT: Partial<Record<SectionDef['id'], readonly string[] | 'all'>> = {
  browser: 'all',
  general: ['confirm-quit', 'background', 'open-at-login'],
  appearance: ['zoom'],
  about: ['notices'],
}

/** The list's groups without what the web client leaves out; a group left empty goes. */
export function webClusters(clusters: SectionDef[][]): SectionDef[][] {
  return clusters
    .map((cluster) =>
      cluster.flatMap((section) => {
        const rows = LEFT_OUT[section.id]
        if (!rows) return [section]
        if (rows === 'all') return []
        return [{ ...section, rows: section.rows.filter((row) => !rows.includes(row.id)) }]
      }),
    )
    .filter((cluster) => cluster.length > 0)
}
