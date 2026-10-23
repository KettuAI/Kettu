import { entryMessageId, type StopReason, type ToolEntry, type ToolKind } from '@shared/thread'
import { basename, duration, relativePath } from '@renderer/lib/format'
import { host } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'

/** A Collapsible panel animating its height, the one layout animation the design allows. */
export const PANEL =
  'h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-(--duration-base) ease-out-expo data-ending-style:h-0 data-starting-style:h-0'

type FileKind = 'read' | 'edit' | 'delete' | 'move'

const FILE_KINDS: Partial<Record<ToolKind, FileKind>> = {
  read: 'read',
  edit: 'edit',
  delete: 'delete',
  move: 'move',
}

/** What the header names: a verb with a path or command, or the agent's own title. */
export function toolLabel(
  entry: Pick<ToolEntry, 'toolKind' | 'title' | 'locations' | 'rawInput'>,
  projectPath: string,
): { verb: string | null; target: string | null; kind: 'path' | 'command' | 'title' } {
  const fileKind = FILE_KINDS[entry.toolKind]
  const location = entry.locations[0]?.path
  if (fileKind && location) {
    return {
      verb: i18n.t(`session:tool.verb.${fileKind}`),
      target: relativePath(location, projectPath),
      kind: 'path',
    }
  }
  if (entry.toolKind === 'execute') {
    // Without the input, the title is the agent's own label and may already say "Run".
    const target = entry.rawInput ?? entry.title.replace(/^run\s+/i, '')
    return { verb: i18n.t('session:tool.verb.run'), target, kind: 'command' }
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
    reads ? i18n.t('session:summary.explored', { count: reads }) : null,
    searches ? i18n.t('session:summary.search', { count: searches }) : null,
    fetches ? i18n.t('session:summary.fetch', { count: fetches }) : null,
  ].filter((p): p is string => p !== null)
  return capitalize(parts.join(i18n.t('session:summary.separator')))
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** A step of a folded run, as its summary counts it. */
export type RunStep =
  | { kind: 'thought'; durationMs?: number; streaming?: boolean }
  | { kind: 'tool'; toolKind: ToolKind; status: ToolEntry['status']; path?: string }
  | { kind: 'plan' }
  | { kind: 'compaction'; running: boolean }

type RunPart =
  | 'thought'
  | 'plan'
  | 'compaction'
  | 'execute'
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'fetch'
  | 'other'

function partOf(step: RunStep): RunPart {
  if (step.kind !== 'tool') return step.kind
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
        return ms >= 1000
          ? i18n.t('session:summary.thoughtFor', { duration: duration(ms) })
          : i18n.t('session:summary.thought')
      }
      case 'plan':
        return i18n.t('session:summary.plan')
      case 'compaction':
        return i18n.t('session:summary.compaction')
      case 'execute':
        return i18n.t('session:summary.execute', { count: n })
      case 'search':
        return i18n.t('session:summary.search', { count: n })
      case 'fetch':
        return i18n.t('session:summary.fetch', { count: n })
      case 'other':
        return i18n.t('session:summary.tool', { count: n })
      default: {
        // Files, not calls: the same file read twice counts once.
        const paths = group.map((s) => (s.kind === 'tool' ? s.path : undefined))
        const known = new Set(paths.filter((p) => p !== undefined))
        const files = known.size + paths.filter((p) => p === undefined).length
        const [only] = known
        return files === 1 && only
          ? i18n.t(`session:summary.${part}Named`, { name: basename(only) })
          : i18n.t(`session:summary.${part}`, { count: files })
      }
    }
  })
  if (parts[0]) parts[0] = capitalize(parts[0])
  return {
    parts,
    editAt: [...byPart.keys()].indexOf('edit'),
    failed: steps.filter((s) => s.kind === 'tool' && s.status === 'failed').length,
    running: steps.some((s) => {
      if (s.kind === 'thought') return !!s.streaming
      if (s.kind === 'compaction') return s.running
      if (s.kind === 'plan') return false
      return s.status === 'pending' || s.status === 'in_progress'
    }),
  }
}

export function stopReasonText(stopReason: StopReason, durationMs: number): string {
  switch (stopReason) {
    case 'end_turn':
      return i18n.t('session:stopReason.endTurn', { duration: duration(durationMs) })
    case 'cancelled':
      return i18n.t('session:stopReason.cancelled')
    case 'max_tokens':
      return i18n.t('session:stopReason.maxTokens')
    case 'max_turn_requests':
      return i18n.t('session:stopReason.maxTurnRequests')
    case 'refusal':
      return i18n.t('session:stopReason.refusal')
  }
}

/**
 * The agent message a reply's Fork starts the new session at, or null when it offers none. The
 * latest reply forks the whole session, which any agent with `session/fork` can; an earlier one
 * needs an agent that forks at a message, and a message the agent gave an id.
 */
export function forkEntry(
  reply: { latest: boolean; agentIds: readonly string[] },
  agent: { forkSession: boolean; forkAtMessage: boolean } | undefined,
): string | null {
  const last = reply.agentIds.at(-1)
  if (last === undefined || !agent?.forkSession) return null
  if (reply.latest) return last
  return agent.forkAtMessage && entryMessageId(last) !== null ? last : null
}
