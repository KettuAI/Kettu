import {
  entryMessageId,
  type StopReason,
  type ToolContent,
  type ToolEntry,
  type ToolKind,
} from '@shared/thread'
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

/** A run of completed lookups as one line: "Read a.ts, b.ts and 2 more · Searched 3 times". */
export function groupLabel(steps: RunStep[]): string {
  return runSummary(steps)
    .parts.map((part) => part.text)
    .join(i18n.t('session:summary.separator'))
}

/** A step of a folded run, as its summary counts it. */
export type RunStep =
  | { kind: 'thought'; durationMs?: number; streaming?: boolean }
  | {
      kind: 'tool'
      toolKind: ToolKind
      status: ToolEntry['status']
      path?: string
      /** An edit's content, whose diffs tell a created file and give the stats. */
      content?: ToolContent[]
      description?: string
    }
  | { kind: 'plan' }
  | { kind: 'compaction'; running: boolean }

/** A tool call as a step of a folded run. */
export function toolStep(entry: ToolEntry): RunStep {
  const path = entry.locations[0]?.path
  return {
    kind: 'tool',
    toolKind: entry.toolKind,
    status: entry.status,
    ...(path !== undefined ? { path } : {}),
    ...(entry.toolKind === 'edit' ? { content: entry.content } : {}),
    ...(entry.description !== undefined ? { description: entry.description } : {}),
  }
}

/** A part of a fold line, with the diffs whose stats follow it. */
export interface SummaryPart {
  text: string
  diffs?: ToolContent[]
}

type FilePart = 'read' | 'create' | 'edit' | 'delete' | 'move'

type RunPart =
  FilePart | 'thought' | 'plan' | 'compaction' | 'execute' | 'search' | 'fetch' | 'other'

const creates = (step: Extract<RunStep, { kind: 'tool' }>): boolean =>
  !!step.content?.some(
    (c) =>
      c.type === 'diff' && c.oldText === null && (step.path === undefined || c.path === step.path),
  )

function partOf(step: RunStep, created: Set<string>): RunPart {
  if (step.kind !== 'tool') return step.kind
  switch (step.toolKind) {
    case 'edit':
      // A file the run created stays Created through the edits that follow.
      return creates(step) || (step.path !== undefined && created.has(step.path))
        ? 'create'
        : 'edit'
    case 'execute':
    case 'read':
    case 'delete':
    case 'move':
    case 'search':
    case 'fetch':
      return step.toolKind
    default:
      return 'other'
  }
}

/** "Read a.ts", "Read a.ts, b.ts and 6 more", or "Read 3 files" when none has a path. */
function filesText(part: FilePart, paths: (string | undefined)[]): string {
  const known = [...new Set(paths.filter((p) => p !== undefined))]
  // Files, not calls: the same file read twice counts once.
  const files = known.length + paths.filter((p) => p === undefined).length
  if (known.length === 0) return i18n.t(`session:summary.${part}`, { count: files })
  const shown = known.slice(0, 2)
  const names = shown.map(basename).join(i18n.t('session:summary.nameSeparator'))
  const more = files - shown.length
  return more === 0
    ? i18n.t(`session:summary.${part}Named`, { names })
    : i18n.t(`session:summary.${part}More`, { names, more })
}

/**
 * A folded run's summary, "Read README.md and 6 more · Created offload.py · Ran 5 commands": one
 * part per kind in the order it first appears, and a command's description after its part.
 */
export function runSummary(steps: RunStep[]): {
  parts: SummaryPart[]
  failed: number
  running: boolean
} {
  const created = new Set<string>()
  for (const step of steps) {
    if (step.kind === 'tool' && step.path !== undefined && creates(step)) created.add(step.path)
  }
  const byPart = new Map<RunPart, RunStep[]>()
  for (const step of steps) {
    const part = partOf(step, created)
    byPart.set(part, [...(byPart.get(part) ?? []), step])
  }
  const parts = [...byPart].flatMap(([part, group]): SummaryPart[] => {
    const n = group.length
    const tools = group.filter((s) => s.kind === 'tool')
    switch (part) {
      case 'thought': {
        const ms = group.reduce(
          (sum, s) => sum + (s.kind === 'thought' ? (s.durationMs ?? 0) : 0),
          0,
        )
        return [
          {
            text:
              ms >= 1000
                ? i18n.t('session:summary.thoughtFor', { duration: duration(ms) })
                : i18n.t('session:summary.thought'),
          },
        ]
      }
      case 'plan':
        return [{ text: i18n.t('session:summary.plan') }]
      case 'compaction':
        return [{ text: i18n.t('session:summary.compaction') }]
      case 'execute': {
        const description = tools.at(-1)?.description
        if (n === 1 && description) return [{ text: description }]
        const count = { text: i18n.t('session:summary.execute', { count: n }) }
        return description ? [count, { text: description }] : [count]
      }
      case 'search':
        return [{ text: i18n.t('session:summary.search', { count: n }) }]
      case 'fetch':
        return [{ text: i18n.t('session:summary.fetch', { count: n }) }]
      case 'other':
        return [{ text: i18n.t('session:summary.tool', { count: n }) }]
      default: {
        const text = filesText(
          part,
          tools.map((s) => s.path),
        )
        if (part !== 'create' && part !== 'edit') return [{ text }]
        const diffs = tools.flatMap((s) => s.content?.filter((c) => c.type === 'diff') ?? [])
        return [{ text, diffs }]
      }
    }
  })
  return {
    parts,
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
