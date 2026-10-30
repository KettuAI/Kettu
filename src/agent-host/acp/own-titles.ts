// How an agent titles its own sessions, read from the name and version it gives in `initialize`.

import type { OwnTitles } from '../connection'
import { compareVersions } from '../versions'

interface OwnTitlesRow {
  since: string // the first version seen to title its sessions itself
  kind: OwnTitles
}

// The first version of each adapter seen to title its sessions. Each comment names the version
// that was read.
const OWN_TITLES: ReadonlyMap<string, OwnTitlesRow> = new Map([
  // fake-agent 0.1.0 sends its title as an update.
  ['fake-agent', { since: '0.1.0', kind: 'sent' }],
  // OpenCode 2.0.32 titles a root session but sends no update for it, only `session/list`.
  ['OpenCode', { since: '2.0.32', kind: 'listed' }],
])

/**
 * How the agent `initialize` names titles its sessions, or null when it titles none itself: an
 * unknown name, a version before the one that titles, or no `agentInfo` at all.
 */
export function ownTitles(
  info: { name: string; version: string } | null | undefined,
): OwnTitles | null {
  if (!info) return null
  const row = OWN_TITLES.get(info.name)
  if (!row) return null
  return compareVersions(info.version, row.since) >= 0 ? row.kind : null
}
