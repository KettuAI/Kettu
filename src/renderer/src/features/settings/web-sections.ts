import type { SectionDef } from './model'

/**
 * What the web client's Settings keep, by section and row: this device's own settings, which stay
 * in the browser, and what it reads from the host as any client does. The host's own settings
 * need its owner's desktop app or CLI.
 */
const WEB_ROWS: Partial<Record<SectionDef['id'], readonly string[] | 'all'>> = {
  general: ['language', 'send-key', 'default-agent', 'restore', 'confirm-links'],
  appearance: ['color-mode', 'text-size', 'reduce-motion'],
  terminal: ['font-size'],
  archived: 'all',
  about: ['source', 'license', 'issues'],
}

/** The list's groups with only what the web client keeps; a group left empty goes. */
export function webClusters(clusters: SectionDef[][]): SectionDef[][] {
  return clusters
    .map((cluster) =>
      cluster.flatMap((section) => {
        const rows = WEB_ROWS[section.id]
        if (!rows) return []
        if (rows === 'all') return [section]
        return [{ ...section, rows: section.rows.filter((row) => rows.includes(row.id)) }]
      }),
    )
    .filter((cluster) => cluster.length > 0)
}
