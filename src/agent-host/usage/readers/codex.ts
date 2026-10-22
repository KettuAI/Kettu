// Codex's usage from its rollout logs. Codex writes running totals, so each request's own usage
// is worked out here, and the history a forked or subagent rollout replays from its parent is
// left out.
// Ported from cc-switch, https://github.com/farion1231/cc-switch/blob/7da2553/src-tauri/src/services/session_usage_codex.rs
// Copyright (c) 2025 Jason Young. MIT License.

import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { eachLine, openLog, resumeOffset, tailHash, unchanged } from '../lines'
import { normalizeModel, type LogReader, type ScanContext, type UsageRow } from '../model'

type Json = Record<string, unknown>

interface Tokens {
  /** Codex's input, which includes the cached part and the cache writes. */
  input: number
  cached: number
  cacheWrite: number
  output: number
}

const ZERO: Tokens = { input: 0, cached: 0, cacheWrite: 0, output: 0 }

type ParentResolution =
  | { kind: 'none' }
  | { kind: 'parent'; id: string }
  | { kind: 'continuation' }
  | { kind: 'deferred'; reason: string }

interface PendingUsage {
  key: string
  usage: Tokens
  at: number
  model: string
}

const STATE_VERSION = 1

/** What reading a rollout carries from one scan to the next, kept in its cursor. */
interface RolloutState {
  v: typeof STATE_VERSION
  metaSeen: boolean
  threadId: string | null
  project: string | null
  /** ns since the epoch of the first session_meta, where a fork's replayed history ends. */
  cutoff: string | null
  parent: ParentResolution
  historyBaseId: string | null
  model: string
  /** Counted events so far, replayed ones included: the n in their keys. */
  n: number
  highWater: Tokens | null
  /** The latest full snapshot per `rate_limits.limit_id`, '' for none. */
  bySource: Record<string, string>
  previous: string | null
  pending: PendingUsage | null
  /** A fork's progress through its parent's events, while its own still match them. */
  replay: { open: boolean; pos: number } | null
  /** ms of the latest time read, for an event without its own. */
  lastAt: number | null
}

interface Rollout {
  path: string
  /** The file name without `.zst`: the cursor id, the same when Codex compresses or archives it. */
  name: string
  rolloutId: string
  /** The thread id before `_` in a page's name, `<thread>_<rollout>`. */
  leadingId: string | null
  compressed: boolean
  size: number
  mtimeNs: bigint
  ino: bigint
}

interface Timeline {
  events: { at: bigint; sig: string }[]
  maxAt: bigint | null
  /** A token count without a time, which leaves a fork's cutoff undecidable. */
  untimed: boolean
  highWater: Tokens | null
}

interface Scan {
  readonly ctx: ScanContext
  readonly index: ReadonlyMap<string, readonly Rollout[]>
  timeline(file: Rollout): Promise<Timeline>
}

interface TokenEvent {
  sig: string
  delta: Tokens
  n: number | null
  model: string
  at: number
  replay: boolean
}

interface UsageEvent {
  key: string
  delta: Tokens
  model: string
  at: number
}

/** A rollout that cannot be read correctly yet; it is tried again at a later scan. */
class Deferral extends Error {
  /** Thread ids whose files decide the outcome; null to try again at every scan. */
  readonly deps: readonly (string | null)[] | null

  constructor(reason: string, deps: readonly (string | null)[] | null) {
    super(reason)
    this.deps = deps
  }
}

interface Deferred {
  size: number
  mtimeNs: bigint
  ino: bigint
  deps: readonly (string | null)[]
  fingerprint: string
}

export function createCodexReader(): LogReader {
  // A deferred rollout is read again only once it or the files it waits on change.
  const deferred = new Map<string, Deferred>()
  return {
    agentId: 'codex',
    locations: (env, home) => {
      const root = codexHome(env, home)
      return [path.join(root, 'sessions'), path.join(root, 'archived_sessions')]
    },
    async scan(ctx) {
      const root = codexHome(ctx.env, ctx.home)
      const files = await listRollouts(root, ctx)
      if (!files) return false
      const index = indexRollouts(files)
      const listed = new Set(files.map((file) => file.path))
      for (const key of deferred.keys()) if (!listed.has(key)) deferred.delete(key)

      const toRead = pickRollouts(files).filter((file) => {
        if (unchanged(ctx.cursor(file.name), file.size, file.mtimeNs)) return false
        const memo = deferred.get(file.path)
        return !(
          memo &&
          memo.size === file.size &&
          memo.mtimeNs === file.mtimeNs &&
          memo.ino === file.ino &&
          memo.fingerprint === fingerprint(index, memo.deps)
        )
      })
      ctx.plan(
        toRead.length,
        toRead.reduce((sum, file) => sum + file.size, 0),
      )

      const timelines = new Map<string, Promise<Timeline>>()
      const scan: Scan = {
        ctx,
        index,
        timeline(file) {
          let timeline = timelines.get(file.path)
          if (!timeline) {
            timeline = loadTimeline(file.path, ctx.signal)
            timelines.set(file.path, timeline)
          }
          return timeline
        },
      }
      for (const file of toRead) {
        ctx.signal.throwIfAborted()
        try {
          await readRollout(file, scan)
          deferred.delete(file.path)
        } catch (error) {
          if (error instanceof Deferral) {
            if (error.deps) {
              const { size, mtimeNs, ino } = file
              const memo = { size, mtimeNs, ino, deps: error.deps }
              deferred.set(file.path, { ...memo, fingerprint: fingerprint(index, error.deps) })
            } else deferred.delete(file.path)
            ctx.log('info', `Codex rollout ${file.path} is left for a later scan: ${error.message}`)
          } else {
            if (ctx.signal.aborted) throw error
            ctx.log('warn', `Cannot read Codex rollout ${file.path}: ${message(error)}`)
          }
        }
        ctx.done(file.size)
      }
      return true
    },
  }
}

export const codexReader: LogReader = createCodexReader()

function codexHome(env: ScanContext['env'], home: string): string {
  const value = env.CODEX_HOME
  return value && value.trim() ? value : path.join(home, '.codex')
}

// Finding the rollouts

/** sessions/YYYY/MM/DD */
const SESSION_LEVELS = 3

/** Every rollout under `sessions` and `archived_sessions`; null when neither folder exists. */
async function listRollouts(root: string, ctx: ScanContext): Promise<Rollout[] | null> {
  const paths: string[] = []
  const sessions = await rootEntries(path.join(root, 'sessions'))
  const archived = await rootEntries(path.join(root, 'archived_sessions'))
  if (!sessions && !archived) return null
  if (sessions) await addEntries(sessions, SESSION_LEVELS, paths, ctx)
  if (archived) await addEntries(archived, 0, paths, ctx)
  paths.sort()
  // While Codex compresses or inflates a rollout both forms exist; the plain one is the newer.
  const all = new Set(paths)
  const kept = paths.filter((file) => !file.endsWith('.zst') || !all.has(file.slice(0, -4)))
  const stats = await Promise.all(
    kept.map((file) =>
      stat(file, { bigint: true }).then(
        (info) => info,
        () => null,
      ),
    ),
  )
  const files: Rollout[] = []
  kept.forEach((file, i) => {
    const info = stats[i]
    const name = rolloutName(path.basename(file))
    const rolloutId = name && trailingId(name)
    if (!info?.isFile() || !name || !rolloutId) return
    files.push({
      path: file,
      name,
      rolloutId,
      leadingId: leadingId(name),
      compressed: file.endsWith('.zst'),
      size: Number(info.size),
      mtimeNs: info.mtimeNs,
      ino: info.ino,
    })
  })
  return files
}

async function rootEntries(dir: string): Promise<{ dir: string; entries: Dirent[] } | null> {
  try {
    return { dir, entries: await readdir(dir, { withFileTypes: true }) }
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

async function addEntries(
  { dir, entries }: { dir: string; entries: Dirent[] },
  levels: number,
  paths: string[],
  ctx: ScanContext,
): Promise<void> {
  await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name)
      const isDir = entry.isSymbolicLink()
        ? await stat(full).then(
            (info) => info.isDirectory(),
            () => false,
          )
        : entry.isDirectory()
      if (!isDir) {
        if (rolloutName(entry.name)) paths.push(full)
        return
      }
      if (levels <= 0) return
      try {
        const children = await readdir(full, { withFileTypes: true })
        await addEntries({ dir: full, entries: children }, levels - 1, paths, ctx)
      } catch (error) {
        if (!isMissing(error)) ctx.log('warn', `Cannot list ${full}: ${message(error)}`)
      }
    }),
  )
}

/** One file per rollout name: copies left in both folders would otherwise share one cursor. */
function pickRollouts(files: readonly Rollout[]): Rollout[] {
  const picked = new Map<string, Rollout>()
  for (const file of files) {
    const other = picked.get(file.name)
    if (
      !other ||
      (other.compressed && !file.compressed) ||
      (other.compressed === file.compressed && file.mtimeNs > other.mtimeNs)
    ) {
      picked.set(file.name, file)
    }
  }
  return [...picked.values()].sort((a, b) => compare(a.path, b.path))
}

/** The files of each thread id: a page `<thread>_<rollout>` is listed under both ids. */
function indexRollouts(files: readonly Rollout[]): Map<string, Rollout[]> {
  const index = new Map<string, Rollout[]>()
  const add = (id: string, file: Rollout) => {
    const list = index.get(id)
    if (list) list.push(file)
    else index.set(id, [file])
  }
  for (const file of files) {
    add(file.rolloutId, file)
    if (file.leadingId && file.leadingId !== file.rolloutId) add(file.leadingId, file)
  }
  return index
}

function fingerprint(
  index: ReadonlyMap<string, readonly Rollout[]>,
  ids: readonly (string | null)[],
): string {
  return ids
    .map((id) =>
      (id === null ? [] : (index.get(id) ?? []))
        .map((file) => `${file.path}\0${file.size}\0${file.mtimeNs}\0${file.ino}`)
        .join('\n'),
    )
    .join('\t')
}

/** The cursor id of a rollout's file name, or null when it is not one. */
function rolloutName(fileName: string): string | null {
  const name = fileName.endsWith('.jsonl.zst') ? fileName.slice(0, -4) : fileName
  return name.startsWith('rollout-') && name.endsWith('.jsonl') && trailingId(name) ? name : null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function trailingId(name: string): string | null {
  const id = name.slice(0, -'.jsonl'.length).slice(-36)
  return UUID.test(id) ? id.toLowerCase() : null
}

function leadingId(name: string): string | null {
  const stem = name.slice(0, -'.jsonl'.length)
  if (stem.length < 73 || stem[stem.length - 37] !== '_') return null
  const id = stem.slice(-73, -37)
  return UUID.test(id) ? id.toLowerCase() : null
}

/** A UUID in its hyphenated lower-case form, from any of the forms Codex's uuid crate reads. */
function uuid(value: string): string | null {
  let id = value
  if (/^urn:uuid:/i.test(id)) id = id.slice(9)
  else if (id.startsWith('{') && id.endsWith('}')) id = id.slice(1, -1)
  if (/^[0-9a-f]{32}$/i.test(id)) {
    id = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`
  }
  return UUID.test(id) ? id.toLowerCase() : null
}

// Reading one rollout

async function readRollout(file: Rollout, scan: Scan): Promise<void> {
  const { ctx } = scan
  const cursor = ctx.cursor(file.name)
  const log = await openLog(file.path)
  let start = await resumeOffset(log.source, cursor)
  let state = start > 0 ? restoreState(cursor?.state ?? null) : null
  if (!state) {
    start = 0
    state = newState()
  }
  const records: { value: Json; end: number }[] = []
  const end = await eachLine(
    log.source,
    start,
    (text, lineEnd) => {
      const value = wanted(text) ? parseObject(text) : null
      if (value) records.push({ value, end: lineEnd })
    },
    { signal: ctx.signal },
  )
  const fallbackAt = Number(log.mtimeNs / 1_000_000n)
  const { tokens, usage } = await readRecords(records, state, file, scan, fallbackAt)

  const billable = usage.length > 0 || tokens.some((event) => event.n !== null)
  if (billable && !state.metaSeen) throw new Deferral('it has usage but no session_meta', [])
  if (billable && state.parent.kind === 'deferred') {
    throw new Deferral(state.parent.reason, [state.threadId, state.historyBaseId])
  }
  if (state.parent.kind === 'parent' && state.replay?.open && tokens.length > 0) {
    if (state.cutoff === null) throw new Deferral('the fork has no session_meta time', [])
    const parent = await parentSignatures(state.parent.id, BigInt(state.cutoff), scan)
    matchReplay(tokens, parent, state.replay)
  }

  const session = { sessionId: state.threadId ?? file.rolloutId, project: state.project }
  const rows: UsageRow[] = []
  for (const event of tokens) {
    if (event.n !== null && !event.replay) {
      rows.push(toRow(`codex:${file.rolloutId}:${event.n}`, event, session))
    }
  }
  for (const event of usage) rows.push(toRow(event.key, event, session))
  ctx.commit(rows, {
    id: file.name,
    agentId: 'codex',
    size: log.size,
    mtimeNs: log.mtimeNs,
    offset: end,
    tail: await tailHash(log.source, end),
    state: JSON.stringify(state),
  })
}

function toRow(
  key: string,
  event: { delta: Tokens; model: string; at: number },
  session: { sessionId: string; project: string | null },
): UsageRow {
  const { input, cached, cacheWrite, output } = event.delta
  return {
    key,
    source: 'log',
    agentId: 'codex',
    ...session,
    model: event.model,
    at: event.at,
    input: input - cached - cacheWrite,
    output,
    reasoning: null,
    cacheRead: cached,
    cacheWrite,
  }
}

function newState(): RolloutState {
  return {
    v: STATE_VERSION,
    metaSeen: false,
    threadId: null,
    project: null,
    cutoff: null,
    parent: { kind: 'none' },
    historyBaseId: null,
    model: '',
    n: 0,
    highWater: null,
    bySource: {},
    previous: null,
    pending: null,
    replay: null,
    lastAt: null,
  }
}

function restoreState(text: string | null): RolloutState | null {
  if (!text) return null
  try {
    const value: unknown = JSON.parse(text)
    return asObject(value)?.v === STATE_VERSION ? (value as RolloutState) : null
  } catch {
    return null
  }
}

async function readRecords(
  records: readonly { value: Json; end: number }[],
  state: RolloutState,
  file: Rollout,
  scan: Scan,
  fallbackAt: number,
): Promise<{ tokens: TokenEvent[]; usage: UsageEvent[] }> {
  const tokens: TokenEvent[] = []
  const usage: UsageEvent[] = []
  for (const { value, end } of records) {
    const time = parseTime(value.timestamp)
    const at = time === null ? (state.lastAt ?? fallbackAt) : Number(time / 1_000_000n)
    if (time !== null) state.lastAt = at
    const payload = asObject(value.payload)
    switch (value.type) {
      case 'session_meta':
        if (!state.metaSeen) readMeta(state, value, file)
        break
      case 'turn_context': {
        if (!payload) break
        const model = Object.hasOwn(payload, 'model')
          ? payload.model
          : asObject(payload.info)?.model
        if (typeof model === 'string') state.model = normalizeModel(model)
        break
      }
      case 'token_usage_record': {
        state.pending = null
        const used = payload && readTokens(payload.usage)
        if (!used || isZero(used)) break
        const responseId = typeof payload.response_id === 'string' ? payload.response_id : ''
        const key = responseId
          ? `codex:usage:${responseId}`
          : `codex:usage:${file.rolloutId}:${end}`
        state.pending = { key, usage: used, at, model: state.model }
        break
      }
      case 'event_msg': {
        if (payload?.type === 'thread_settings_applied') {
          // Resumed threads may change models without another turn_context.
          const model = asObject(payload.thread_settings)?.model
          if (typeof model === 'string' && model.trim()) state.model = normalizeModel(model.trim())
          break
        }
        if (payload?.type !== 'token_count') break
        const info = asObject(payload.info)
        const sig = info && signature(info)
        if (!info || !sig) break
        const model = field([info, 'model'], [info, 'model_name'], [payload, 'model'])
        if (typeof model === 'string') state.model = normalizeModel(model)

        const source = nonEmpty(asObject(payload.rate_limits)?.limit_id) ?? ''
        const total = readTokens(info.total_token_usage)
        const last = readTokens(info.last_token_usage)
        const pending = state.pending
        state.pending = null
        // Remote compaction writes its usage only in the record, then a token count of zero.
        if (pending && last && isZero(last)) {
          const delta = clampTokens(pending.usage)
          if (counts(delta))
            usage.push({ key: pending.key, delta, model: pending.model, at: pending.at })
        }
        if (!total && !last) break

        // A rate-limit refresh can repeat a snapshot under another limit_id: a repeat matches
        // that source's latest full snapshot or the event just before it, never older ones.
        const repeat = total !== null && (state.bySource[source] === sig || state.previous === sig)
        if (total) state.bySource[source] = sig
        state.previous = sig

        let delta = ZERO
        if (!repeat && last) delta = last
        else if (!repeat && total) {
          if (state.parent.kind === 'continuation' && !state.highWater) {
            const baseline = await continuationBaseline(file, state, scan)
            // A page whose counter restarted below the baseline counts from zero.
            if (baseline && total.input >= baseline.input) state.highWater = { ...baseline }
          }
          delta = difference(state.highWater, total)
        }
        // The totals run across models and rate-limit lanes; exact `last` usage is preferred.
        if (total) state.highWater = state.highWater ? highest(state.highWater, total) : total
        const clamped = clampTokens(delta)
        const counted = counts(clamped)
        if (counted) state.n += 1
        tokens.push({
          sig,
          delta: clamped,
          n: counted ? state.n : null,
          model: state.model,
          at,
          replay: false,
        })
        break
      }
    }
  }
  return { tokens, usage }
}

function readMeta(state: RolloutState, value: Json, file: Rollout): void {
  state.metaSeen = true
  const time = parseTime(value.timestamp)
  state.cutoff = time === null ? null : time.toString()
  const payload = asObject(value.payload) ?? {}
  let parent = explicitParent(payload)

  const rawId = nonEmpty(field([payload, 'id'], [payload, 'thread_id'], [payload, 'threadId']))
  const threadId = rawId === null ? null : (uuid(rawId) ?? rawId)
  // A page `<thread>_<rollout>` keeps its thread's id in session_meta.
  if (threadId !== null && threadId !== file.rolloutId && threadId !== file.leadingId) {
    parent = {
      kind: 'deferred',
      reason: `its name says ${file.rolloutId} but its session_meta says ${threadId}`,
    }
  }

  const rawBase = nonEmpty(asObject(payload.history_base)?.thread_id)
  const historyBaseId = rawBase === null ? null : (uuid(rawBase) ?? rawBase)
  // A page that continues a thread keeps the forked_from_id of its first page, but holds only
  // new events: it is not a fork and replays nothing.
  const continuation =
    file.leadingId !== null && file.leadingId === threadId
      ? payload.history_mode === 'paginated' || historyBaseId !== null || parent.kind === 'parent'
      : historyBaseId !== null && historyBaseId === threadId
  if (continuation) parent = { kind: 'continuation' }

  if (parent.kind === 'parent') {
    const id = uuid(parent.id)
    if (id === null) parent = { kind: 'deferred', reason: `its parent id ${parent.id} is no UUID` }
    else if (id === file.rolloutId)
      parent = { kind: 'deferred', reason: 'it names itself as parent' }
    else parent = { kind: 'parent', id }
  }

  state.threadId = threadId
  state.project = nonEmpty(payload.cwd)
  state.parent = parent
  state.historyBaseId = historyBaseId
  state.replay = parent.kind === 'parent' ? { open: true, pos: 0 } : null
}

function explicitParent(payload: Json): ParentResolution {
  const forked = nonEmpty(payload.forked_from_id)
  const spawn = asObject(asObject(asObject(payload.source)?.subagent)?.thread_spawn)
  const spawned = nonEmpty(spawn?.parent_thread_id)
  const id = forked ?? spawned
  if (id === null) return { kind: 'none' }
  if (forked !== null && spawned !== null && forked !== spawned) {
    return {
      kind: 'deferred',
      reason: `forked_from_id ${forked} and thread_spawn.parent_thread_id ${spawned} disagree`,
    }
  }
  return { kind: 'parent', id }
}

/**
 * The totals where the page before this one ended, for a page whose token counts carry no
 * `last` usage; without them its first total would count the whole thread again.
 */
async function continuationBaseline(
  file: Rollout,
  state: RolloutState,
  scan: Scan,
): Promise<Tokens | null> {
  const deps = [state.threadId, state.historyBaseId]
  const name = path.basename(file.path)
  const earlier = async (id: string): Promise<Tokens | null> => {
    for (const page of [...(scan.index.get(id) ?? [])].reverse()) {
      if (path.basename(page.path) >= name) continue
      let timeline: Timeline
      try {
        timeline = await scan.timeline(page)
      } catch (error) {
        throw new Deferral(`cannot read the page before it, ${page.path}: ${message(error)}`, deps)
      }
      if (timeline.highWater) return timeline.highWater
    }
    return null
  }
  const own = await earlier(state.threadId ?? '')
  if (own) return own
  if (state.historyBaseId !== null && state.historyBaseId !== state.threadId) {
    const base = await earlier(state.historyBaseId)
    if (base) return base
  }
  if (state.historyBaseId !== null) throw new Deferral('the page it continues is not on disk', deps)
  return null
}

// A fork's replayed history

/** Marks the fork's events that replay its parent's, in order, up to the first that does not. */
function matchReplay(
  events: TokenEvent[],
  parent: readonly string[],
  replay: { open: boolean; pos: number },
): void {
  for (const event of events) {
    const at = parent.indexOf(event.sig, replay.pos)
    if (at < 0) {
      replay.open = false
      return
    }
    replay.pos = at + 1
    event.replay = true
  }
}

/**
 * The parent's token events up to the fork's cutoff, its pages joined in order. Copies of one
 * rollout must agree, and the parent must have been written up to the cutoff.
 */
async function parentSignatures(parentId: string, cutoff: bigint, scan: Scan): Promise<string[]> {
  const deps = [parentId]
  const candidates = scan.index.get(parentId) ?? []
  if (candidates.length === 0) throw new Deferral(`its parent ${parentId} is not on disk`, deps)
  const ordered = [...candidates].sort((a, b) =>
    compare(path.basename(a.path), path.basename(b.path)),
  )
  const segments: { rolloutId: string; timeline: Timeline; maxAt: bigint | null }[] = []
  let untimed = false
  for (const candidate of ordered) {
    let timeline: Timeline
    try {
      timeline = await scan.timeline(candidate)
    } catch (error) {
      throw new Deferral(`cannot read its parent ${candidate.path}: ${message(error)}`, null)
    }
    untimed ||= timeline.untimed
    const copy = segments.find((segment) => segment.rolloutId === candidate.rolloutId)
    if (!copy) {
      segments.push({ rolloutId: candidate.rolloutId, timeline, maxAt: timeline.maxAt })
      continue
    }
    const a = before(copy.timeline, cutoff)
    const b = before(timeline, cutoff)
    if (a.length !== b.length || a.some((sig, i) => sig !== b[i])) {
      throw new Deferral(`the copies of its parent ${parentId} differ`, deps)
    }
    // Every copy must have reached the cutoff.
    copy.maxAt =
      copy.maxAt !== null && timeline.maxAt !== null
        ? copy.maxAt < timeline.maxAt
          ? copy.maxAt
          : timeline.maxAt
        : null
  }
  if (untimed) throw new Deferral(`its parent ${parentId} has a token count without a time`, deps)
  let reached: bigint | null = null
  for (const { maxAt } of segments)
    if (maxAt !== null && (reached === null || maxAt > reached)) reached = maxAt
  // A parent last written before the fork holds all it will ever hold up to it, as when a
  // finished thread is forked; cc-switch waits on such a fork forever.
  const settled = ordered.every((file) => file.mtimeNs < cutoff)
  if (!settled && (reached === null || reached < cutoff)) {
    throw new Deferral(`its parent ${parentId} has not been written up to the fork yet`, deps)
  }
  return segments.flatMap((segment) => before(segment.timeline, cutoff))
}

function before(timeline: Timeline, cutoff: bigint): string[] {
  return timeline.events.filter((event) => event.at <= cutoff).map((event) => event.sig)
}

/** A parent's token events and its latest time, read in full since times need not be in order. */
async function loadTimeline(file: string, signal: AbortSignal): Promise<Timeline> {
  const { source } = await openLog(file)
  const timeline: Timeline = { events: [], maxAt: null, untimed: false, highWater: null }
  const end = await eachLine(source, 0, (text) => addToTimeline(timeline, text, false), { signal })
  // A complete last record without its newline counts here, as in cc-switch.
  if (end < source.length) {
    addToTimeline(timeline, (await source.read(end, source.length - end)).toString('utf8'), true)
  }
  return timeline
}

function addToTimeline(timeline: Timeline, text: string, strict: boolean): void {
  const head = strict ? null : envelope(text)
  if (head && (head.type !== 'event_msg' || (head.event && head.event !== 'token_count'))) {
    reach(timeline, parseTime(head.timestamp))
    return
  }
  const value = parseObject(text)
  if (!value) return
  const at = parseTime(value.timestamp)
  reach(timeline, at)
  const payload = asObject(value.payload)
  if (value.type !== 'event_msg' || payload?.type !== 'token_count') return
  const info = asObject(payload.info)
  const sig = info && signature(info)
  if (!info || !sig) return
  if (at === null) {
    timeline.untimed = true
    return
  }
  timeline.events.push({ at, sig })
  const total = readTokens(info.total_token_usage)
  if (total) timeline.highWater = timeline.highWater ? highest(timeline.highWater, total) : total
}

function reach(timeline: Timeline, at: bigint | null): void {
  if (at !== null && (timeline.maxAt === null || at > timeline.maxAt)) timeline.maxAt = at
}

// Lines

interface Envelope {
  type: string
  /** The payload's own type, when it comes first in the payload. */
  event: string | null
  timestamp: string | null
}

const HEAD_CHARS = 512
const PAYLOAD_KEY = '"payload":'
const TYPE_FIELD = /"type":"([^"\\]*)"/
const TIMESTAMP_FIELD = /"timestamp":"([^"\\]*)"/
const PAYLOAD_TYPE = /^\{"type":"([^"\\]*)"/

/**
 * The plain fields ahead of the payload, the way Codex writes a line; null for any other layout,
 * which is then searched in full.
 */
function envelope(text: string): Envelope | null {
  if (text.charCodeAt(0) !== 0x7b) return null
  const payload = text.indexOf(PAYLOAD_KEY, 1)
  if (payload < 0 || payload > HEAD_CHARS) return null
  const head = text.slice(1, payload)
  if (head.includes('{') || head.includes('[')) return null
  const type = TYPE_FIELD.exec(head)?.[1]
  if (type === undefined) return null
  const start = payload + PAYLOAD_KEY.length
  const event = PAYLOAD_TYPE.exec(text.slice(start, start + 64))?.[1] ?? null
  return { type, event, timestamp: TIMESTAMP_FIELD.exec(head)?.[1] ?? null }
}

const RECORD_TYPES = new Set(['session_meta', 'turn_context', 'token_usage_record'])
const EVENT_TYPES = new Set(['token_count', 'thread_settings_applied'])
const NEEDED =
  /"(?:session_meta|turn_context|token_usage_record|token_count|thread_settings_applied)"/

/** Whether a line can matter, so that tool output and messages are never parsed. */
function wanted(text: string): boolean {
  const head = envelope(text)
  if (head && head.type !== 'event_msg') return RECORD_TYPES.has(head.type)
  if (head?.event) return EVENT_TYPES.has(head.event)
  return NEEDED.test(text)
}

function parseObject(text: string): Json | null {
  try {
    return asObject(JSON.parse(text))
  } catch {
    return null
  }
}

function asObject(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null
}

/** The first of these fields that is present, even as null, as serde's `get().or_else()` does. */
function field(...candidates: [Json, string][]): unknown {
  for (const [object, key] of candidates) if (Object.hasOwn(object, key)) return object[key]
  return undefined
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

const RFC3339 = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/

/** ns since the epoch: a fork's cutoff is compared exactly, below the millisecond. */
function parseTime(value: unknown): bigint | null {
  if (typeof value !== 'string') return null
  const match = RFC3339.exec(value)
  if (!match) return null
  const ms = Date.parse(`${match[1]}T${match[2]}${match[4]?.toUpperCase()}`)
  if (Number.isNaN(ms)) return null
  return BigInt(ms) * 1_000_000n + BigInt((match[3] ?? '').slice(0, 9).padEnd(9, '0'))
}

// Tokens

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function cachedField(usage: Json): unknown {
  return field([usage, 'cached_input_tokens'], [usage, 'cache_read_input_tokens'])
}

const USAGE_FIELDS = [
  'input_tokens',
  'cached_input_tokens',
  'cache_read_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens',
]

/** A usage object's counts; null when it has none of the usage fields, as `{}` in old logs. */
function readTokens(value: unknown): Tokens | null {
  const usage = asObject(value)
  if (!usage || !USAGE_FIELDS.some((key) => Object.hasOwn(usage, key))) return null
  return {
    input: count(usage.input_tokens) ?? 0,
    cached: count(cachedField(usage)) ?? 0,
    cacheWrite: count(usage.cache_write_input_tokens) ?? 0,
    output: count(usage.output_tokens) ?? 0,
  }
}

function counters(value: unknown): string | null {
  const usage = asObject(value)
  if (!usage) return null
  const fields = [
    usage.input_tokens,
    cachedField(usage),
    usage.output_tokens,
    usage.reasoning_output_tokens,
    usage.total_tokens,
  ]
  return fields.map((value) => count(value) ?? '').join(',')
}

/** A token count's totals and last usage as one comparable string. */
function signature(info: Json): string | null {
  const total = counters(info.total_token_usage)
  const last = counters(info.last_token_usage)
  return total === null && last === null ? null : `${total ?? '-'}/${last ?? '-'}`
}

function isZero(tokens: Tokens): boolean {
  return tokens.input === 0 && tokens.cached === 0 && tokens.cacheWrite === 0 && tokens.output === 0
}

/** Whether an event counts as a request; cc-switch leaves cache writes out of this test. */
function counts(tokens: Tokens): boolean {
  return tokens.input !== 0 || tokens.cached !== 0 || tokens.output !== 0
}

/** Cache reads and writes are disjoint parts of the input. */
function clampTokens({ input, cached, cacheWrite, output }: Tokens): Tokens {
  const read = Math.min(cached, input)
  return { input, cached: read, cacheWrite: Math.min(cacheWrite, input - read), output }
}

function difference(previous: Tokens | null, current: Tokens): Tokens {
  if (!previous) return { ...current }
  return {
    input: Math.max(0, current.input - previous.input),
    cached: Math.max(0, current.cached - previous.cached),
    cacheWrite: Math.max(0, current.cacheWrite - previous.cacheWrite),
    output: Math.max(0, current.output - previous.output),
  }
}

function highest(high: Tokens, current: Tokens): Tokens {
  return {
    input: Math.max(high.input, current.input),
    cached: Math.max(high.cached, current.cached),
    cacheWrite: Math.max(high.cacheWrite, current.cacheWrite),
    output: Math.max(high.output, current.output),
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function isMissing(error: unknown): boolean {
  const code = asObject(error)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
