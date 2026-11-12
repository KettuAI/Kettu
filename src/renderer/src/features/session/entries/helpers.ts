import { ALREADY_ANSWERED } from '@shared/agent-host'
import {
  entryMessageId,
  type FormValues,
  type FromDevice,
  type PermissionKind,
  type QuestionAnswer,
  type SessionStatus,
  type StopReason,
  type ToolContent,
  type ToolEntry,
  type ToolKind,
} from '@shared/thread'
import { basename, duration, relativePath } from '@renderer/lib/format'
import { errorCode, host } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'
import { nameHints } from '../project-names'

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

/**
 * What the header names: a verb with a path or command, or the agent's own title. A finished
 * call's verb is in the past tense ("Edited", "Ran").
 */
export function toolLabel(
  entry: Pick<ToolEntry, 'toolKind' | 'title' | 'locations' | 'rawInput'>,
  projectPath: string,
  done = false,
): { verb: string | null; target: string | null; kind: 'path' | 'command' | 'title' } {
  const verbs = done ? 'session:tool.verbDone' : 'session:tool.verb'
  const fileKind = FILE_KINDS[entry.toolKind]
  const location = entry.locations[0]?.path
  if (fileKind && location) {
    return {
      verb: i18n.t(`${verbs}.${fileKind}`),
      target: relativePath(location, projectPath),
      kind: 'path',
    }
  }
  if (entry.toolKind === 'execute') {
    // Without the input, the title is the agent's own label and may already say "Run".
    const target = entry.rawInput ?? entry.title.replace(/^run\s+/i, '')
    return { verb: i18n.t(`${verbs}.run`), target, kind: 'command' }
  }
  return { verb: null, target: entry.title, kind: 'title' }
}

/** An option's answer; `note` goes with an option that takes one, such as keeping on planning. */
export function respondToPermission(
  sessionId: string,
  requestId: string,
  optionId: string,
  note?: string,
) {
  return host('permissions.respond', {
    sessionId,
    requestId,
    optionId,
    ...(note ? { note } : {}),
  })
}

/** An MCP server's form, submitted with its values. */
export function respondWithValues(sessionId: string, requestId: string, values: FormValues) {
  return host('permissions.respond', { sessionId, requestId, values })
}

/** The answers to an ask's questions, only those given; none at all skips every one. */
export function respondToQuestions(
  sessionId: string,
  requestId: string,
  answers: QuestionAnswer[],
) {
  return host('permissions.respond', { sessionId, requestId, answers })
}

/**
 * Where the request a late answer went to was answered first: that device, or null for one of the
 * host's windows; undefined when the error says something else.
 */
export function answeredBy(error: unknown): FromDevice | null | undefined {
  if (errorCode(error) !== 'not_found') return undefined
  const data = (error as { data?: { reason?: unknown; device?: unknown } }).data
  if (data?.reason !== ALREADY_ANSWERED) return undefined
  const device = data.device as Partial<FromDevice> | null | undefined
  return typeof device?.id === 'string' && typeof device.name === 'string'
    ? { id: device.id, name: device.name }
    : null
}

/** The usual answer to a request: allowing it once, else the agent's first option. */
export function primaryOption(options: readonly { kind: PermissionKind }[]): number {
  return Math.max(
    0,
    options.findIndex((o) => o.kind === 'allow_once'),
  )
}

/** An option's name in parts, the `code` spans apart; an unpaired backtick reads as written. */
export function codeSpans(name: string): { text: string; code: boolean }[] {
  const parts = name.split('`')
  if (parts.length % 2 === 0) return [{ text: name, code: false }]
  return parts.map((text, i) => ({ text, code: i % 2 === 1 })).filter((part) => part.text !== '')
}

const FENCED = /^(`{3,})[^\n`]*\n([\s\S]*?)\n?\1$/

/**
 * What a command printed, when its result is one fenced block of text, as agents send a shell's
 * output; null for anything else, which shows as Markdown.
 */
export function commandOutput(content: readonly ToolContent[]): string | null {
  const first = content[0]
  if (first?.type !== 'markdown') return null
  const match = FENCED.exec(first.markdown.trim())
  if (!match) return null
  const [, fence, body] = match
  // A fence as long inside would have closed the block there.
  if (body!.split('\n').some((line) => line.trimStart().startsWith(fence!))) return null
  return body!
}

/** A run of completed lookups as one line: "Read a.ts, b.ts and 2 more · Searched 3 times". */
export function groupLabel(steps: RunStep[]): string {
  return runSummary(steps)
    .parts.map((part) => part.text)
    .join(i18n.t('session:summary.separator'))
}

type Diff = Extract<ToolContent, { type: 'diff' }>

/** A step of a folded run, as its summary counts it. */
export type RunStep =
  | { kind: 'thought'; durationMs?: number; streaming?: boolean }
  | {
      kind: 'tool'
      toolKind: ToolKind
      status: ToolEntry['status']
      /** The files it touched: an edit's from its diffs, else its first location. */
      paths: string[]
      /** An edit's diffs, which tell a created file and give the stats. */
      diffs?: Diff[]
      description?: string
      /** The agent's own name for the work this call is part of. */
      label?: string
    }

/** A tool call as a step of a folded run. */
export function toolStep(entry: ToolEntry): RunStep {
  const base = { kind: 'tool' as const, toolKind: entry.toolKind, status: entry.status }
  const description = {
    ...(entry.description !== undefined ? { description: entry.description } : {}),
    ...(entry.label !== undefined ? { label: entry.label } : {}),
  }
  if (entry.toolKind !== 'edit') {
    const first = entry.locations[0]?.path
    return { ...base, paths: first !== undefined ? [first] : [], ...description }
  }
  // Codex sends a patch's files only in its diffs, and locations only with a permission request.
  const diffs = entry.content.filter((c) => c.type === 'diff')
  const paths = diffs.length > 0 ? diffs.map((d) => d.path) : entry.locations.map((l) => l.path)
  return { ...base, paths: [...new Set(paths)], diffs, ...description }
}

/** A part of a fold line, with the diffs whose stats follow it. */
export interface SummaryPart {
  text: string
  /** What the part counts: a tool kind, a thought, a plan. */
  kind?: RunPart
  /** The file names inside `text`, which the fold line sets apart. */
  names?: string
  diffs?: Diff[]
}

type FilePart = 'read' | 'create' | 'edit' | 'delete' | 'move'

type RunPart = FilePart | 'thought' | 'plan' | 'execute' | 'search' | 'fetch' | 'other'

/** What a step adds to a part: an edit adds one unit per file it touched. */
interface Unit {
  part: RunPart
  step: RunStep
  path?: string
  diffs?: Diff[]
}

function unitsOf(step: RunStep, created: Set<string>): Unit[] {
  if (step.kind !== 'tool') return [{ part: step.kind, step }]
  switch (step.toolKind) {
    case 'edit':
      if (step.paths.length === 0) return [{ part: 'edit', step, diffs: step.diffs }]
      // A file the run created stays Created through the edits that follow.
      return step.paths.map((path) => ({
        part: created.has(path) ? 'create' : 'edit',
        step,
        path,
        diffs: step.diffs?.filter((d) => d.path === path),
      }))
    case 'read':
    case 'delete':
    case 'move':
      return [{ part: step.toolKind, step, path: step.paths[0] }]
    case 'execute':
    case 'search':
    case 'fetch':
      return [{ part: step.toolKind, step }]
    default:
      return [{ part: 'other', step }]
  }
}

/** "Read a.ts", "Read a.ts, b.ts and 6 more", or "Read 3 files" when none has a path. */
function filesText(part: FilePart, paths: (string | undefined)[]): SummaryPart {
  const known = [...new Set(paths.filter((p) => p !== undefined))]
  // Files, not calls: the same file read twice counts once.
  const files = known.length + paths.filter((p) => p === undefined).length
  if (known.length === 0) return { text: i18n.t(`session:summary.${part}`, { count: files }) }
  const shown = known.slice(0, 2)
  // Two shown files that share a name add the folders that tell them apart.
  const hints = nameHints(shown)
  const names = shown
    .map((path) => {
      const hint = hints.get(path)
      return hint ? `${hint}/${basename(path)}` : basename(path)
    })
    .join(i18n.t('session:summary.nameSeparator'))
  const more = files - shown.length
  const text =
    more === 0
      ? i18n.t(`session:summary.${part}Named`, { names })
      : i18n.t(`session:summary.${part}More`, { names, more })
  return { text, names }
}

/** What a kind's units add to a fold line: its words, without the kind they stand for. */
function partsOf(part: RunPart, units: Unit[]): Omit<SummaryPart, 'kind'>[] {
  const n = units.length
  switch (part) {
    case 'thought': {
      const ms = units.reduce(
        (sum, u) => sum + (u.step.kind === 'thought' ? (u.step.durationMs ?? 0) : 0),
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
    case 'execute': {
      const only = units[0]?.step
      const description = n === 1 && only?.kind === 'tool' ? only.description : undefined
      return [{ text: description ?? i18n.t('session:summary.execute', { count: n }) }]
    }
    case 'search':
      return [{ text: i18n.t('session:summary.search', { count: n }) }]
    case 'fetch':
      return [{ text: i18n.t('session:summary.fetch', { count: n }) }]
    case 'other':
      return [{ text: i18n.t('session:summary.tool', { count: n }) }]
    default: {
      const files = filesText(
        part,
        units.map((u) => u.path),
      )
      if (part !== 'create' && part !== 'edit') return [files]
      return [{ ...files, diffs: units.flatMap((u) => u.diffs ?? []) }]
    }
  }
}

/**
 * A folded run's summary, "Read README.md and 6 more · Created offload.py · Ran 5 commands": one
 * part per kind in the order it first appears; a lone command is named by its description.
 * Thoughts name a part only in a run of nothing else: "Thought for 25 s".
 */
export function runSummary(steps: RunStep[]): {
  parts: SummaryPart[]
  failed: number
  running: boolean
} {
  const created = new Set<string>()
  for (const step of steps) {
    if (step.kind !== 'tool') continue
    for (const diff of step.diffs ?? []) if (diff.oldText === null) created.add(diff.path)
  }
  const byPart = new Map<RunPart, Unit[]>()
  for (const unit of steps.flatMap((step) => unitsOf(step, created))) {
    byPart.set(unit.part, [...(byPart.get(unit.part) ?? []), unit])
  }
  const named = byPart.size > 1 ? [...byPart].filter(([part]) => part !== 'thought') : [...byPart]
  const parts = named.flatMap(([part, units]): SummaryPart[] =>
    partsOf(part, units).map((text) => ({ ...text, kind: part })),
  )
  return {
    parts,
    failed: steps.filter((s) => s.kind === 'tool' && s.status === 'failed').length,
    running: steps.some((s) => {
      if (s.kind === 'thought') return !!s.streaming
      return s.status === 'pending' || s.status === 'in_progress'
    }),
  }
}

/** The names an agent gave the work of a run's tool calls, each once, in order. */
export function runLabels(steps: RunStep[]): string[] {
  const labels = new Set<string>()
  for (const step of steps) if (step.kind === 'tool' && step.label) labels.add(step.label)
  return [...labels]
}

/** A thought's heading: its leading bold text, else its first sentence, as plain text. */
export function thoughtTitle(markdown: string): string | null {
  const text = markdown.trim()
  const bold = /^(?:\*\*|__)(.+?)(?:\*\*|__)/.exec(text)
  const first = bold?.[1] ?? text.split('\n', 1)[0]!.split(/(?<=[.!?\u3002\uff01\uff1f])\s*/, 1)[0]!
  const title = first.replace(/[*_`#>]/g, '').trim()
  return title === '' ? null : title
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

/** Whether a reply's Fork cannot start in this session status. A running turn does not stop it. */
export function forkBlocked(status: SessionStatus): boolean {
  return status === 'starting' || status === 'failed' || status === 'auth_required'
}
