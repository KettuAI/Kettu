import type { StopReason, ToolEntry, ToolKind } from '@shared/thread'
import { basename, duration, plural, relativePath } from '@renderer/lib/format'
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
    searches ? (searches === 1 ? 'searched once' : `searched ${searches} times`) : null,
    fetches ? (fetches === 1 ? 'fetched a page' : `fetched ${fetches} pages`) : null,
  ].filter((p): p is string => p !== null)
  const text = parts.join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** A step of a folded run, as its summary counts it. */
export type RunStep =
  | { kind: 'thought'; durationMs?: number; streaming?: boolean }
  | { kind: 'tool'; toolKind: ToolKind; status: ToolEntry['status']; path?: string }

type RunPart =
  'thought' | 'execute' | 'read' | 'edit' | 'delete' | 'move' | 'search' | 'fetch' | 'other'

const FILE_PAST: Partial<Record<RunPart, string>> = {
  read: 'read',
  edit: 'edited',
  delete: 'deleted',
  move: 'moved',
}

function partOf(step: RunStep): RunPart {
  if (step.kind === 'thought') return 'thought'
  switch (step.toolKind) {
    case 'execute':
    case 'read':
    case 'edit':
    case 'delete':
    case 'move':
    case 'search':
    case 'fetch':
      return step.toolKind
    default:
      return 'other'
  }
}

/**
 * A folded run's summary, "Ran 3 commands, read 2 files, edited ui.md": one part per kind in the
 * order it first appears. `editAt` is the edit part's index, where the diff stats follow.
 */
export function runSummary(steps: RunStep[]): {
  parts: string[]
  editAt: number
  failed: number
  running: boolean
} {
  const byPart = new Map<RunPart, RunStep[]>()
  for (const step of steps) {
    const part = partOf(step)
    byPart.set(part, [...(byPart.get(part) ?? []), step])
  }
  const parts = [...byPart].map(([part, group]) => {
    const n = group.length
    switch (part) {
      case 'thought': {
        const ms = group.reduce(
          (sum, s) => sum + (s.kind === 'thought' ? (s.durationMs ?? 0) : 0),
          0,
        )
        return ms >= 1000 ? `thought for ${duration(ms)}` : 'thought'
      }
      case 'execute':
        return n === 1 ? 'ran a command' : `ran ${n} commands`
      case 'search':
        return n === 1 ? 'searched once' : `searched ${n} times`
      case 'fetch':
        return n === 1 ? 'fetched a page' : `fetched ${n} pages`
      case 'other':
        return n === 1 ? 'used a tool' : `used ${n} tools`
      default: {
        // Files, not calls: the same file read twice counts once.
        const paths = group.map((s) => (s.kind === 'tool' ? s.path : undefined))
        const known = new Set(paths.filter((p) => p !== undefined))
        const files = known.size + paths.filter((p) => p === undefined).length
        const [only] = known
        return files === 1 && only
          ? `${FILE_PAST[part]} ${basename(only)}`
          : `${FILE_PAST[part]} ${plural(files, 'file')}`
      }
    }
  })
  if (parts[0]) parts[0] = parts[0].charAt(0).toUpperCase() + parts[0].slice(1)
  return {
    parts,
    editAt: [...byPart.keys()].indexOf('edit'),
    failed: steps.filter((s) => s.kind === 'tool' && s.status === 'failed').length,
    running: steps.some((s) =>
      s.kind === 'thought' ? !!s.streaming : s.status === 'pending' || s.status === 'in_progress',
    ),
  }
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
