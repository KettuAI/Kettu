import type { StopReason, ToolEntry, ToolKind } from '@shared/thread'
import { duration, plural, relativePath } from '@renderer/lib/format'
import { host } from '@renderer/lib/host'

/** A Collapsible panel animating its height, the one layout animation the design allows. */
export const PANEL =
  'h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-(--duration-base) ease-out-expo data-ending-style:h-0 data-starting-style:h-0'

const FILE_VERB: Partial<Record<ToolKind, string>> = {
  read: 'Read',
  edit: 'Edit',
  delete: 'Delete',
  move: 'Move',
}

/** What the header names: a verb with a path or command, or the agent's own title. */
export function toolLabel(
  entry: Pick<ToolEntry, 'toolKind' | 'title' | 'locations' | 'rawInput'>,
  projectPath: string,
): { verb: string | null; target: string | null; kind: 'path' | 'command' | 'title' } {
  const verb = FILE_VERB[entry.toolKind]
  const location = entry.locations[0]?.path
  if (verb && location) {
    return { verb, target: relativePath(location, projectPath), kind: 'path' }
  }
  if (entry.toolKind === 'execute') {
    // Without the input, the title is the agent's own label and may already say "Run".
    const target = entry.rawInput ?? entry.title.replace(/^run\s+/i, '')
    return { verb: 'Run', target, kind: 'command' }
  }
  return { verb: null, target: entry.title, kind: 'title' }
}

export function respondToPermission(sessionId: string, requestId: string, optionId: string) {
  return host('permissions.respond', { sessionId, requestId, optionId })
}

/** "Explored 4 files", "Searched 3 times", or both, for a run of completed lookups. */
export function groupLabel(kinds: ToolKind[]): string {
  const reads = kinds.filter((k) => k === 'read').length
  const searches = kinds.filter((k) => k === 'search').length
  const fetches = kinds.filter((k) => k === 'fetch').length
  const parts = [
    reads ? `explored ${plural(reads, 'file')}` : null,
    searches ? `searched ${plural(searches, 'time')}` : null,
    fetches ? `fetched ${plural(fetches, 'page')}` : null,
  ].filter((p): p is string => p !== null)
  const text = parts.join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function stopReasonText(stopReason: StopReason, durationMs: number): string {
  switch (stopReason) {
    case 'end_turn':
      return `Worked for ${duration(durationMs)}`
    case 'cancelled':
      return 'Cancelled'
    case 'max_tokens':
      return 'Stopped at the token limit'
    case 'max_turn_requests':
      return 'Stopped at the request limit'
    case 'refusal':
      return 'Declined'
  }
}
