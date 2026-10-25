// Many cases follow cc-switch's tests, https://github.com/farion1231/cc-switch/blob/7da2553/src-tauri/src/services/session_usage_codex.rs
// Copyright (c) 2025 Jason Young. MIT License.

import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LogReader } from '../model'
import { memoryContext, type MemoryContext } from '../testing'
import { codexReader, createCodexReader } from './codex'

const PARENT = '00000000-0000-4000-8000-000000000001'
const CHILD_A = '00000000-0000-4000-8000-000000000002'
const CHILD_B = '00000000-0000-4000-8000-000000000003'
const PARENT_PAGE = '00000000-0000-4000-8000-000000000004'
const CHILD_A_PAGE = '00000000-0000-4000-8000-000000000005'
const CHILD_A_PAGE_2 = '00000000-0000-4000-8000-000000000006'

let home: string
let codex: string
let day: string
let archive: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'usage-codex-'))
  codex = join(home, '.codex')
  day = join(codex, 'sessions', '2026', '07', '10')
  archive = join(codex, 'archived_sessions')
  mkdirSync(day, { recursive: true })
  mkdirSync(archive)
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

type Line = Record<string, unknown>
type Usage = [input: number, cached: number, output: number]

const pad = (value: number) => String(value).padStart(2, '0')
const T = (seconds: number, minutes = 0) => `2026-07-10T03:${pad(minutes)}:${pad(seconds)}Z`

function meta(
  id: string,
  options: {
    at?: string
    forkedFrom?: string
    spawnedFrom?: string
    paginated?: boolean
    historyBase?: string
  } = {},
): Line {
  const payload: Line = {
    id,
    forked_from_id: options.forkedFrom ?? null,
    source: options.spawnedFrom
      ? { subagent: { thread_spawn: { parent_thread_id: options.spawnedFrom } } }
      : 'cli',
    cwd: '/work/app',
  }
  if (options.paginated) payload.history_mode = 'paginated'
  if (options.historyBase) {
    payload.history_base = {
      thread_id: options.historyBase,
      end_ordinal_exclusive: 100,
      end_byte_offset: 5000,
    }
  }
  return { timestamp: options.at ?? T(0), type: 'session_meta', payload }
}

const turn = (model = 'gpt-5.6-sol', at = T(1)): Line => ({
  timestamp: at,
  type: 'turn_context',
  payload: { model },
})

const settings = (model: unknown, at = T(1)): Line => ({
  timestamp: at,
  type: 'event_msg',
  payload: { type: 'thread_settings_applied', thread_settings: { model } },
})

const usage = ([input, cached, output]: Usage) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
  reasoning_output_tokens: 0,
  total_tokens: input + output,
})

function countWith(info: Line, at = T(2), limit?: string): Line {
  const payload: Line = { type: 'token_count', info }
  if (limit) payload.rate_limits = { limit_id: limit }
  return { timestamp: at, type: 'event_msg', payload }
}

function tokenCount(
  total: Usage | null,
  at = T(2),
  options: { last?: Usage; limit?: string } = {},
): Line {
  const info: Line = {}
  if (total) info.total_token_usage = usage(total)
  if (options.last) info.last_token_usage = usage(options.last)
  return countWith(info, at, options.limit)
}

const lane = (total: Usage, last: Usage, limit: string, at: string) =>
  tokenCount(total, at, { last, limit })

const record = (responseId: string, used: Usage, at = T(2)): Line => ({
  timestamp: at,
  type: 'token_usage_record',
  payload: { response_id: responseId, usage: { ...usage(used), cache_write_input_tokens: 0 } },
})

const rollout = (dir: string, id: string, stamp = '2026-07-10T03-00-00') =>
  join(dir, `rollout-${stamp}-${id}.jsonl`)

const text = (line: Line | string) => (typeof line === 'string' ? line : JSON.stringify(line))

function write(file: string, lines: (Line | string)[]): string {
  writeFileSync(file, lines.map(text).join('\n') + '\n')
  return file
}

function append(file: string, lines: (Line | string)[]): void {
  appendFileSync(file, lines.map(text).join('\n') + '\n')
}

function compress(file: string): string {
  const zst = `${file}.zst`
  writeFileSync(zst, zstdCompressSync(readFileSync(file)))
  unlinkSync(file)
  return zst
}

function inflate(zst: string): string {
  const plain = zst.slice(0, -4)
  writeFileSync(plain, zstdDecompressSync(readFileSync(zst)))
  unlinkSync(zst)
  return plain
}

type Context = MemoryContext & { committed: string[] }

function context(options: { env?: Record<string, string>; signal?: AbortSignal } = {}): Context {
  const ctx = memoryContext({ home, ...options })
  const committed: string[] = []
  const commit = ctx.commit
  ctx.commit = (rows, cursor) => {
    committed.push(...rows.map((row) => row.key))
    commit(rows, cursor)
  }
  return Object.assign(ctx, { committed })
}

async function scanOnce(options?: Parameters<typeof context>[0]): Promise<Context> {
  const ctx = context(options)
  expect(await createCodexReader().scan(ctx)).toBe(true)
  return ctx
}

/** Scans again and resolves with the number of files this scan planned to read. */
async function rescan(reader: LogReader, ctx: Context): Promise<number> {
  const before = ctx.planned.files
  await reader.scan(ctx)
  return ctx.planned.files - before
}

function sorted(ctx: MemoryContext, sessionId?: string) {
  return [...ctx.rows.values()]
    .filter((row) => sessionId === undefined || row.sessionId === sessionId)
    .sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true }))
}

/** Each row as [key, input without cache, cache read, output]. */
function table(ctx: MemoryContext, sessionId?: string) {
  return sorted(ctx, sessionId).map((row) => [row.key, row.input, row.cacheRead, row.output])
}

/** Each row's input as Codex counts it, cache included. */
function inputs(ctx: MemoryContext) {
  return sorted(ctx).map((row) => row.input + row.cacheRead + row.cacheWrite)
}

const cursorOf = (ctx: MemoryContext, file: string) =>
  ctx.cursors.get(basename(file).replace(/\.zst$/, ''))

/** A parent written up to 03:00:02 and a subagent forked from it at 03:00:05. */
function parentAndChild(): { parent: string; child: string } {
  const parent = write(rollout(day, PARENT), [
    meta(PARENT),
    tokenCount([1_000, 900, 100], T(1)),
    turn(undefined, T(2)),
  ])
  const child = write(rollout(day, CHILD_A), [
    meta(CHILD_A, { spawnedFrom: PARENT, at: T(5) }),
    turn(),
    tokenCount([1_000, 900, 100], T(6)),
    tokenCount([1_300, 1_050, 150], T(7)),
  ])
  return { parent, child }
}

describe('finding the logs', () => {
  it('looks in CODEX_HOME, else in ~/.codex', () => {
    expect(codexReader.agentId).toBe('codex')
    expect(codexReader.locations({}, '/u')).toEqual([
      join('/u', '.codex', 'sessions'),
      join('/u', '.codex', 'archived_sessions'),
    ])
    expect(codexReader.locations({ CODEX_HOME: '/c' }, '/u')).toEqual([
      join('/c', 'sessions'),
      join('/c', 'archived_sessions'),
    ])
  })

  it('reports no logs when neither folder exists', async () => {
    rmSync(codex, { recursive: true })
    expect(await createCodexReader().scan(context())).toBe(false)
    mkdirSync(join(codex, 'sessions'), { recursive: true })
    expect(await createCodexReader().scan(context())).toBe(true)
    const elsewhere = { env: { CODEX_HOME: join(home, 'missing') } }
    expect(await createCodexReader().scan(context(elsewhere))).toBe(false)
  })

  it('reads CODEX_HOME instead of ~/.codex when it is set', async () => {
    write(rollout(day, PARENT), [meta(PARENT), turn(), tokenCount([100, 50, 10])])
    const other = join(home, 'other', 'sessions', '2026', '07', '11')
    mkdirSync(other, { recursive: true })
    write(rollout(other, CHILD_A), [meta(CHILD_A), turn(), tokenCount([200, 50, 10])])
    const ctx = await scanOnce({ env: { CODEX_HOME: join(home, 'other') } })
    expect(table(ctx)).toEqual([[`codex:${CHILD_A}:1`, 150, 50, 10]])
  })

  it('reads dated and archived rollouts, plain and compressed, and nothing else', async () => {
    const plain = write(rollout(day, PARENT), [
      meta(PARENT),
      turn('GPT-5.6-Sol'),
      tokenCount([100, 40, 10], T(2), { last: [100, 40, 10] }),
    ])
    compress(write(rollout(day, CHILD_A), [meta(CHILD_A), turn(), tokenCount([200, 100, 20])]))
    write(rollout(archive, CHILD_B), [meta(CHILD_B), turn(), tokenCount([300, 100, 30])])
    const ignored = [meta(PARENT_PAGE), turn(), tokenCount([1, 0, 1])]
    write(join(day, 'notes.jsonl'), ignored)
    write(join(day, 'rollout-2026-07-10T03-00-00-not-a-uuid.jsonl'), ignored)
    mkdirSync(join(day, 'deeper'))
    write(rollout(join(day, 'deeper'), PARENT_PAGE), ignored)

    const ctx = await scanOnce()
    expect(sorted(ctx)[0]).toEqual({
      key: `codex:${PARENT}:1`,
      source: 'log',
      agentId: 'codex',
      sessionId: PARENT,
      project: '/work/app',
      model: 'gpt-5.6-sol',
      at: Date.parse(T(2)),
      input: 60,
      output: 10,
      reasoning: null,
      cacheRead: 40,
      cacheWrite: 0,
      cacheWrite1h: 0,
      turn: 0,
    })
    expect(table(ctx)).toEqual([
      [`codex:${PARENT}:1`, 60, 40, 10],
      [`codex:${CHILD_A}:1`, 100, 100, 20],
      [`codex:${CHILD_B}:1`, 200, 100, 30],
    ])
    expect(ctx.planned.files).toBe(3)
    expect(ctx.doneBytes).toBe(ctx.planned.bytes)
    expect(cursorOf(ctx, plain)).toMatchObject({
      agentId: 'codex',
      offset: readFileSync(plain).length,
    })
  })
})

describe('per-request usage', () => {
  it("uses each request's own usage while running totals interleave", async () => {
    // A plain difference of these totals counted 6 to 8 times too much.
    const bengal = lane(
      [87_709_262, 83_563_008, 240_919],
      [151_258, 147_200, 87],
      'codex_bengalfox',
      T(3),
    )
    write(rollout(day, PARENT), [
      meta(PARENT),
      turn(),
      lane([76_780_408, 73_010_432, 243_036], [175_074, 169_728, 6_827], 'codex', T(2)),
      bengal,
      lane([76_962_538, 73_180_160, 243_258], [182_130, 169_728, 222], 'codex', T(4)),
      bengal,
    ])
    const ctx = await scanOnce()
    expect(table(ctx)).toEqual([
      [`codex:${PARENT}:1`, 175_074 - 169_728, 169_728, 6_827],
      [`codex:${PARENT}:2`, 151_258 - 147_200, 147_200, 87],
      [`codex:${PARENT}:3`, 182_130 - 169_728, 169_728, 222],
    ])
  })

  const x = (limit: string, at: string) => lane([1_000, 0, 10], [100, 0, 10], limit, at)
  const cases: [string, Line[], number[]][] = [
    ['a snapshot repeated under another limit_id', [x('codex', T(2)), x('bengal', T(3))], [100]],
    [
      'a burst of repeats across limit_ids',
      [x('codex', T(2)), x('bengal', T(3)), x('spark', T(4))],
      [100],
    ],
    [
      'a repeat with a turn_context between',
      [x('codex', T(2)), turn(undefined, T(3)), x('bengal', T(4))],
      [100],
    ],
    [
      'a repeat of the same limit_id after another one advanced',
      [x('codex', T(2)), lane([2_000, 0, 20], [100, 0, 10], 'bengal', T(3)), x('codex', T(4))],
      [100, 100],
    ],
    [
      'a reset back to a snapshot another limit_id still holds',
      [
        x('codex', T(2)),
        x('bengal', T(3)),
        lane([2_000, 0, 20], [100, 0, 10], 'codex', T(4)),
        x('codex', T(5)),
      ],
      [100, 100, 100],
    ],
    [
      'a counter reset after a full snapshot advanced',
      [
        lane([100, 50, 10], [100, 50, 10], 'codex', T(2)),
        lane([100, 50, 10], [100, 50, 10], 'codex', T(2)),
        lane([200, 100, 20], [100, 50, 10], 'codex', T(4)),
        lane([100, 50, 10], [50, 25, 5], 'codex', T(5)),
      ],
      [100, 100, 50],
    ],
    [
      'an empty last usage, which falls back to the total',
      [countWith({ total_token_usage: usage([100, 0, 10]), last_token_usage: {} })],
      [100],
    ],
    [
      'an empty total, which marks no repeats',
      [
        countWith({ total_token_usage: {}, last_token_usage: usage([100, 0, 10]) }, T(2), 'codex'),
        countWith({ total_token_usage: {}, last_token_usage: usage([100, 0, 10]) }, T(3), 'b'),
      ],
      [100, 100],
    ],
    [
      'totals across a model switch',
      [
        turn('model-a', T(1)),
        tokenCount([100, 50, 10], T(2)),
        turn('model-b', T(3)),
        tokenCount([150, 75, 15], T(4)),
      ],
      [100, 50],
    ],
    [
      'a total that went down',
      [tokenCount([100, 50, 30], T(2)), tokenCount([80, 40, 20], T(3))],
      [100],
    ],
  ]

  it.each(cases)('counts %s', async (_, events, expected) => {
    write(rollout(day, PARENT), [meta(PARENT), turn(), ...events])
    expect(inputs(await scanOnce())).toEqual(expected)
  })

  it('keeps cached input within the input', async () => {
    write(rollout(day, PARENT), [
      meta(PARENT),
      turn(),
      tokenCount([100, 0, 50], T(2)),
      tokenCount([110, 80, 60], T(3)),
    ])
    expect(table(await scanOnce())).toEqual([
      [`codex:${PARENT}:1`, 100, 0, 50],
      [`codex:${PARENT}:2`, 0, 10, 10],
    ])
  })

  it('takes cache writes out of the input', async () => {
    const used = {
      input_tokens: 1_000,
      cached_input_tokens: 300,
      cache_write_input_tokens: 600,
      output_tokens: 50,
      reasoning_output_tokens: 0,
      total_tokens: 1_050,
    }
    write(rollout(day, PARENT), [
      meta(PARENT),
      turn(),
      countWith({ total_token_usage: used, last_token_usage: used }),
    ])
    expect(sorted(await scanOnce())[0]).toMatchObject({
      input: 100,
      cacheRead: 300,
      cacheWrite: 600,
      output: 50,
    })
  })

  it('takes the model from turn_context, thread_settings_applied and the event', async () => {
    write(rollout(day, PARENT), [
      meta(PARENT),
      settings('gpt-6.1-sol'),
      ...[null, 42, '', ' \t '].map((model) => settings(model, T(2))),
      { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: {} } },
      // The text filter alone is no proof of a setting.
      { ...settings('wrong-model', T(2)), type: 'response_item' },
      tokenCount([100, 50, 10]),
      turn('gpt-6-astra', T(3)),
      tokenCount([150, 75, 15], T(4)),
      countWith({ total_token_usage: usage([200, 100, 20]), model: 'custom-model' }, T(5)),
    ])
    expect(sorted(await scanOnce()).map((row) => row.model)).toEqual([
      'gpt-6.1-sol',
      'gpt-6-astra',
      'custom-model',
    ])
  })

  it('switches the model between scans without counting a repeated snapshot', async () => {
    const first = tokenCount([100, 50, 10], T(2))
    const file = write(rollout(day, PARENT), [meta(PARENT), turn('gpt-6-astra'), first])
    const reader = createCodexReader()
    const ctx = context()
    await reader.scan(ctx)
    append(file, [
      settings('OpenAI/GPT-6.1-SOL-20261001', T(3)),
      first,
      tokenCount([150, 75, 15], T(4)),
    ])
    await reader.scan(ctx)
    expect(sorted(ctx).map((row) => [row.key, row.model, row.input, row.cacheRead])).toEqual([
      [`codex:${PARENT}:1`, 'gpt-6-astra', 50, 50],
      [`codex:${PARENT}:2`, 'gpt-6.1-sol', 25, 25],
    ])
  })

  it('reads lines whose keys are in another order', async () => {
    const lines = (id: string) => [
      meta(id),
      turn(),
      record('', [500, 0, 40], T(2)),
      tokenCount([0, 0, 0], T(2), { last: [0, 0, 0] }),
      settings('gpt-6-astra', T(3)),
      tokenCount([100, 50, 10], T(4)),
    ]
    const reorder = (value: unknown): unknown =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([key, item]) => [key, reorder(item)]),
          )
        : value
    write(rollout(day, PARENT), lines(PARENT))
    write(
      rollout(day, CHILD_A),
      lines(CHILD_A).map((line) => reorder(line) as Line),
    )
    const ctx = await scanOnce()
    const rows = (id: string) =>
      sorted(ctx, id).map(({ key, ...rest }) => ({ ...rest, key: key.replace(id, '<id>') }))
    expect(rows(PARENT)).toHaveLength(2)
    expect(rows(CHILD_A)).toEqual(rows(PARENT).map((row) => ({ ...row, sessionId: CHILD_A })))
  })
})

describe('compaction', () => {
  it('counts a usage record followed by a token count of zero', async () => {
    write(rollout(day, PARENT), [
      meta(PARENT),
      turn(),
      record('resp_compact', [26_705, 0, 491]),
      tokenCount([0, 0, 0], T(2), { last: [0, 0, 0], limit: 'default' }),
    ])
    expect(table(await scanOnce())).toEqual([['codex:usage:resp_compact', 26_705, 0, 491]])
  })

  it('does not count a usage record its token count already covers', async () => {
    write(rollout(day, PARENT), [
      meta(PARENT),
      turn(),
      record('resp_turn', [26_705, 1_000, 491]),
      tokenCount([26_705, 1_000, 491], T(3), { last: [26_705, 1_000, 491], limit: 'default' }),
    ])
    expect(table(await scanOnce())).toEqual([[`codex:${PARENT}:1`, 25_705, 1_000, 491]])
  })

  it('keys a record without a response id by its rollout and place', async () => {
    write(rollout(day, PARENT), [
      meta(PARENT),
      record('', [500, 0, 40]),
      tokenCount([0, 0, 0], T(2), { last: [0, 0, 0] }),
    ])
    const [row] = sorted(await scanOnce())
    expect(row?.key).toMatch(new RegExp(`^codex:usage:${PARENT}:\\d+$`))
  })

  it('counts a record whose token count arrives in the next scan', async () => {
    const file = write(rollout(day, PARENT), [meta(PARENT), turn(), record('resp_x', [500, 0, 40])])
    const reader = createCodexReader()
    const ctx = context()
    await reader.scan(ctx)
    expect(ctx.rows.size).toBe(0)
    append(file, [tokenCount([0, 0, 0], T(3), { last: [0, 0, 0] })])
    await reader.scan(ctx)
    expect(table(ctx)).toEqual([['codex:usage:resp_x', 500, 0, 40]])
  })
})

describe('scanning again', () => {
  it('continues the numbering of a file that grew', async () => {
    const file = write(rollout(day, PARENT), [meta(PARENT), turn(), tokenCount([100, 50, 10])])
    const reader = createCodexReader()
    const ctx = context()
    await reader.scan(ctx)
    append(file, [tokenCount([250, 100, 30], T(3))])
    await reader.scan(ctx)
    expect(ctx.committed).toEqual([`codex:${PARENT}:1`, `codex:${PARENT}:2`])
    expect(table(ctx)).toEqual([
      [`codex:${PARENT}:1`, 50, 50, 10],
      [`codex:${PARENT}:2`, 100, 50, 20],
    ])
  })

  it('reads an append that kept the modification time', async () => {
    const file = write(rollout(day, PARENT), [meta(PARENT), turn(), tokenCount([100, 50, 10])])
    utimesSync(file, 1_700_000_000, 1_700_000_000)
    const reader = createCodexReader()
    const ctx = context()
    await reader.scan(ctx)
    append(file, [tokenCount([250, 100, 30], T(3))])
    utimesSync(file, 1_700_000_000, 1_700_000_000)
    expect(await rescan(reader, ctx)).toBe(1)
    expect(ctx.rows.size).toBe(2)
  })

  it('skips a file that did not change', async () => {
    write(rollout(day, PARENT), [meta(PARENT), turn(), tokenCount([100, 50, 10])])
    const reader = createCodexReader()
    const ctx = context()
    expect(await rescan(reader, ctx)).toBe(1)
    expect(await rescan(reader, ctx)).toBe(0)
    expect(ctx.committed).toEqual([`codex:${PARENT}:1`])
  })

  it('leaves a half-written last line for the next scan', async () => {
    const file = write(rollout(day, PARENT), [meta(PARENT), turn(), tokenCount([100, 50, 10])])
    const complete = readFileSync(file).length
    const next = `${text(tokenCount([250, 100, 30], T(3)))}\n`
    appendFileSync(file, next.slice(0, 40))
    const reader = createCodexReader()
    const ctx = context()
    await reader.scan(ctx)
    expect(cursorOf(ctx, file)?.offset).toBe(complete)
    expect(ctx.rows.size).toBe(1)
    appendFileSync(file, next.slice(40))
    await reader.scan(ctx)
    expect(ctx.committed).toEqual([`codex:${PARENT}:1`, `codex:${PARENT}:2`])
  })

  it('reads a rewritten file from the start without counting twice', async () => {
    const file = write(rollout(day, PARENT), [
      meta(PARENT),
      turn(),
      tokenCount([100, 50, 10]),
      tokenCount([250, 100, 30], T(3)),
    ])
    const reader = createCodexReader()
    const ctx = context()
    await reader.scan(ctx)
    write(file, [
      meta(PARENT),
      turn('gpt-6-astra'),
      tokenCount([100, 50, 10]),
      tokenCount([250, 100, 30], T(3)),
      tokenCount([400, 150, 50], T(4)),
    ])
    await reader.scan(ctx)
    expect(ctx.committed.slice(2)).toEqual([1, 2, 3].map((n) => `codex:${PARENT}:${n}`))
    expect(ctx.rows.size).toBe(3)
  })

  it('logs a file it cannot read and reads the others', async () => {
    writeFileSync(`${rollout(day, CHILD_B)}.zst`, 'not zstd')
    write(rollout(day, PARENT), [meta(PARENT), turn(), tokenCount([100, 50, 10])])
    const ctx = await scanOnce()
    expect(table(ctx)).toEqual([[`codex:${PARENT}:1`, 50, 50, 10]])
    expect(ctx.logs).toEqual([{ level: 'warn', message: expect.stringContaining(CHILD_B) }])
    expect(cursorOf(ctx, rollout(day, CHILD_B))).toBeUndefined()
  })

  it('stops when the scan is aborted', async () => {
    write(rollout(day, PARENT), [meta(PARENT), turn(), tokenCount([100, 50, 10])])
    const controller = new AbortController()
    controller.abort()
    await expect(createCodexReader().scan(context({ signal: controller.signal }))).rejects.toThrow()
  })
})

describe('files that move', () => {
  it('does not read a rollout again once Codex compresses or inflates it', async () => {
    let file = write(rollout(day, PARENT), [meta(PARENT), turn(), tokenCount([100, 50, 10])])
    const reader = createCodexReader()
    const ctx = context()
    await reader.scan(ctx)
    // Usage the last scan missed, then compressed before the next one.
    append(file, [tokenCount([200, 100, 20], T(3))])
    file = compress(file)
    await reader.scan(ctx)
    expect(await rescan(reader, ctx)).toBe(0)
    file = inflate(file)
    append(file, [tokenCount([300, 150, 30], T(4))])
    await reader.scan(ctx)
    expect(ctx.committed).toEqual([1, 2, 3].map((n) => `codex:${PARENT}:${n}`))
    expect(table(ctx).map((row) => row.slice(1))).toEqual([
      [50, 50, 10],
      [50, 50, 10],
      [50, 50, 10],
    ])
  })

  it('reads only what an archived rollout gained', async () => {
    const file = write(rollout(day, PARENT), [meta(PARENT), turn(), tokenCount([100, 50, 10])])
    const reader = createCodexReader()
    const ctx = context()
    await reader.scan(ctx)
    const archived = rollout(archive, PARENT)
    renameSync(file, archived)
    append(archived, [tokenCount([200, 100, 20], T(3))])
    await reader.scan(ctx)
    expect(ctx.committed).toEqual([`codex:${PARENT}:1`, `codex:${PARENT}:2`])
  })

  it('reads one of two copies of a rollout, once', async () => {
    const file = write(rollout(day, PARENT), [meta(PARENT), turn(), tokenCount([100, 50, 10])])
    cpSync(file, rollout(archive, PARENT))
    const reader = createCodexReader()
    const ctx = context()
    expect(await rescan(reader, ctx)).toBe(1)
    expect(await rescan(reader, ctx)).toBe(0)
  })

  it('reads the plain form while both forms are on disk', async () => {
    const file = write(rollout(day, PARENT), [meta(PARENT), turn(), tokenCount([100, 50, 10])])
    compress(file)
    write(file, [meta(PARENT), turn(), tokenCount([100, 50, 10]), tokenCount([200, 100, 20], T(3))])
    const ctx = await scanOnce()
    expect(ctx.planned.files).toBe(1)
    expect(ctx.rows.size).toBe(2)
  })
})

describe('forks and subagents', () => {
  it("leaves out a subagent's replay of its parent and keeps its own usage", async () => {
    parentAndChild()
    append(rollout(day, PARENT), [turn(undefined, T(10))])
    const ctx = await scanOnce()
    expect(table(ctx, CHILD_A)).toEqual([[`codex:${CHILD_A}:2`, 150, 150, 50]])
    expect(table(ctx, PARENT)).toEqual([[`codex:${PARENT}:1`, 100, 900, 100]])
  })

  it("matches the replay against the parent's events in order", async () => {
    write(rollout(day, PARENT), [
      meta(PARENT),
      tokenCount([100, 50, 10], T(1)),
      tokenCount([200, 100, 20], T(2)),
      tokenCount([300, 150, 30], T(3)),
      turn(undefined, T(10)),
    ])
    write(rollout(day, CHILD_A), [
      meta(CHILD_A, { forkedFrom: PARENT, at: T(5) }),
      tokenCount([100, 50, 10], T(6)),
      tokenCount([300, 150, 30], T(7)),
      tokenCount([450, 220, 45], T(8)),
    ])
    expect(table(await scanOnce(), CHILD_A)).toEqual([[`codex:${CHILD_A}:3`, 80, 70, 15]])
  })

  it('counts nothing for a fork that only replays', async () => {
    write(rollout(day, PARENT), [
      meta(PARENT),
      tokenCount([100, 50, 10], T(1)),
      tokenCount([200, 100, 20], T(2)),
      turn(undefined, T(10)),
    ])
    write(rollout(day, CHILD_A), [
      meta(CHILD_A, { forkedFrom: PARENT, at: T(5) }),
      tokenCount([100, 50, 10], T(6)),
      tokenCount([200, 100, 20], T(7)),
      { timestamp: T(8), type: 'event_msg', payload: { type: 'thread_settings_applied' } },
    ])
    const ctx = await scanOnce()
    expect(table(ctx, CHILD_A)).toEqual([])
    expect(cursorOf(ctx, rollout(day, CHILD_A))).toBeDefined()
  })

  it("does not take the parent's events after the fork as replay", async () => {
    write(rollout(day, PARENT), [
      meta(PARENT),
      tokenCount([100, 50, 10], T(1)),
      tokenCount([200, 100, 20], T(6)),
    ])
    write(rollout(day, CHILD_A), [
      meta(CHILD_A, { forkedFrom: PARENT, at: T(5) }),
      tokenCount([200, 100, 20], T(7)),
    ])
    expect(table(await scanOnce(), CHILD_A)).toEqual([[`codex:${CHILD_A}:1`, 100, 100, 20]])
  })

  it('counts a compaction record a fork replays once', async () => {
    write(rollout(day, PARENT), [
      meta(PARENT),
      turn(),
      record('resp_c', [500, 0, 50]),
      tokenCount([0, 0, 0], T(2), { last: [0, 0, 0] }),
      turn(undefined, T(10)),
    ])
    write(rollout(day, CHILD_A), [
      meta(CHILD_A, { spawnedFrom: PARENT, at: T(5) }),
      record('resp_c', [500, 0, 50], T(6)),
      tokenCount([0, 0, 0], T(6), { last: [0, 0, 0] }),
      tokenCount([200, 100, 20], T(7), { last: [200, 100, 20] }),
    ])
    expect(table(await scanOnce())).toEqual([
      [`codex:${CHILD_A}:1`, 100, 100, 20],
      ['codex:usage:resp_c', 500, 0, 50],
    ])
  })

  it('leaves out a compaction record without a response id that a fork replays', async () => {
    write(rollout(day, PARENT), [
      meta(PARENT),
      turn(),
      record('', [500, 0, 50]),
      tokenCount([0, 0, 0], T(2), { last: [0, 0, 0] }),
      turn(undefined, T(10)),
    ])
    write(rollout(day, CHILD_A), [
      meta(CHILD_A, { spawnedFrom: PARENT, at: T(5) }),
      record('', [500, 0, 50], T(6)),
      tokenCount([0, 0, 0], T(6), { last: [0, 0, 0] }),
      tokenCount([200, 100, 20], T(7), { last: [200, 100, 20] }),
    ])
    const ctx = await scanOnce()
    expect(table(ctx, CHILD_A)).toEqual([[`codex:${CHILD_A}:1`, 100, 100, 20]])
    expect(table(ctx, PARENT)).toEqual([
      [expect.stringMatching(new RegExp(`^codex:usage:${PARENT}:\\d+$`)), 500, 0, 50],
    ])
  })

  it('waits on a fork whose two parent ids disagree', async () => {
    const child = write(rollout(day, CHILD_A), [
      meta(CHILD_A, { forkedFrom: PARENT, spawnedFrom: CHILD_B, at: T(5) }),
      tokenCount([100, 50, 10], T(6)),
    ])
    const ctx = await scanOnce()
    expect(ctx.rows.size).toBe(0)
    expect(cursorOf(ctx, child)).toBeUndefined()
  })

  it('waits on a missing parent and reads the child once the parent appears', async () => {
    const child = write(rollout(day, CHILD_A), [
      meta(CHILD_A, { spawnedFrom: PARENT, at: T(5) }),
      tokenCount([900, 400, 90], T(6)),
    ])
    const reader = createCodexReader()
    const ctx = context()
    expect(await rescan(reader, ctx)).toBe(1)
    expect(cursorOf(ctx, child)).toBeUndefined()
    expect(await rescan(reader, ctx)).toBe(0)
    write(rollout(day, PARENT), [
      meta(PARENT),
      tokenCount([100, 50, 10], T(1)),
      turn(undefined, T(10)),
    ])
    expect(await rescan(reader, ctx)).toBe(2)
    expect(table(ctx, CHILD_A)).toEqual([[`codex:${CHILD_A}:1`, 500, 400, 90]])
  })

  it('waits until the parent is written up to the fork', async () => {
    const { parent } = parentAndChild()
    const reader = createCodexReader()
    const ctx = context()
    expect(await rescan(reader, ctx)).toBe(2)
    expect(table(ctx, CHILD_A)).toEqual([])
    // Neither file changed, so the child is not read again.
    expect(await rescan(reader, ctx)).toBe(0)
    append(parent, [turn(undefined, T(10))])
    expect(await rescan(reader, ctx)).toBe(2)
    expect(table(ctx, CHILD_A)).toEqual([[`codex:${CHILD_A}:2`, 150, 150, 50]])
    expect(await rescan(reader, ctx)).toBe(0)
  })

  it('reads a fork of a parent that was last written before the fork', async () => {
    const { parent } = parentAndChild()
    const finished = Date.parse(T(3)) / 1000
    utimesSync(parent, finished, finished)
    expect(table(await scanOnce(), CHILD_A)).toEqual([[`codex:${CHILD_A}:2`, 150, 150, 50]])
  })

  it('reads a waiting child again when it changes', async () => {
    const { parent, child } = parentAndChild()
    const reader = createCodexReader()
    const ctx = context()
    await reader.scan(ctx)
    append(child, [tokenCount([1_600, 1_200, 200], T(8))])
    expect(await rescan(reader, ctx)).toBe(1)
    expect(await rescan(reader, ctx)).toBe(0)
    append(parent, [turn(undefined, T(10))])
    await reader.scan(ctx)
    expect(table(ctx, CHILD_A)).toEqual([
      [`codex:${CHILD_A}:2`, 150, 150, 50],
      [`codex:${CHILD_A}:3`, 150, 150, 50],
    ])
  })

  it('waits on a parent with a token count without a time', async () => {
    const { parent } = parentAndChild()
    const untimed = tokenCount([500, 400, 50])
    delete untimed.timestamp
    append(parent, [untimed, turn(undefined, T(10))])
    expect(table(await scanOnce(), CHILD_A)).toEqual([])
  })

  it('waits on a parent whose copies disagree', async () => {
    const name = '2026-07-10T03-00-01'
    write(rollout(archive, PARENT, name), [
      meta(PARENT),
      tokenCount([1_000, 900, 100], T(1)),
      turn(undefined, T(10)),
    ])
    write(rollout(day, PARENT, name), [
      meta(PARENT),
      tokenCount([1_000, 900, 100], T(1)),
      tokenCount([500, 400, 50], T(2)),
      turn(undefined, T(10)),
    ])
    write(rollout(day, CHILD_A), [
      meta(CHILD_A, { spawnedFrom: PARENT, at: T(5) }),
      tokenCount([1_500, 1_000, 200], T(6)),
    ])
    expect(table(await scanOnce(), CHILD_A)).toEqual([])
  })

  it("joins a paginated parent's pages before the cutoff", async () => {
    write(rollout(day, PARENT), [meta(PARENT), tokenCount([1_000, 900, 100], T(1))])
    write(join(day, `rollout-2026-07-10T03-00-20-${PARENT}_${PARENT_PAGE}.jsonl`), [
      meta(PARENT, { at: T(20) }),
      tokenCount([2_000, 1_800, 200], T(21)),
      turn(undefined, T(40)),
    ])
    write(rollout(day, CHILD_A), [
      meta(CHILD_A, { forkedFrom: PARENT, spawnedFrom: PARENT, at: T(30) }),
      turn(),
      tokenCount([1_000, 900, 100], T(31)),
      tokenCount([2_000, 1_800, 200], T(32)),
      tokenCount([2_300, 1_950, 250], T(33)),
    ])
    expect(table(await scanOnce(), CHILD_A)).toEqual([[`codex:${CHILD_A}:3`, 150, 150, 50]])
  })

  type Malformed = [name: string, prefix: string | Buffer, suffix: string | Buffer, drop: boolean]
  const malformed: Malformed[] = [
    ['a bad first line and no last newline', Buffer.from([0xff, 0x0a]), '', true],
    ['a bad last line', '', Buffer.from([0xff, 0x0a]), false],
    ['a bad partial last line', '', Buffer.from([0xff]), false],
    ['malformed JSON and blank lines', '{malformed\n \t\r\n', '{malformed', false],
  ]
  const malformedCases = malformed.flatMap(([name, prefix, suffix, drop]) =>
    [false, true].map((zst): [string, boolean, string | Buffer, string | Buffer, boolean] => [
      name,
      zst,
      prefix,
      suffix,
      drop,
    ]),
  )
  it.each(malformedCases)(
    'reads a parent with %s (compressed: %s)',
    async (_, zst, prefix, suffix, dropNewline) => {
      const { parent } = parentAndChild()
      append(parent, [turn(undefined, T(10))])
      let contents = readFileSync(parent)
      if (dropNewline) contents = contents.subarray(0, -1)
      writeFileSync(parent, Buffer.concat([Buffer.from(prefix), contents, Buffer.from(suffix)]))
      if (zst) compress(parent)
      expect(table(await scanOnce(), CHILD_A)).toEqual([[`codex:${CHILD_A}:2`, 150, 150, 50]])
    },
  )

  it('compares the cutoff below the millisecond', async () => {
    write(rollout(day, PARENT), [
      meta(PARENT),
      tokenCount([100, 50, 10], '2026-07-10T03:00:00.000000500Z'),
      turn(undefined, '2026-07-10T03:00:00.000000900Z'),
    ])
    write(rollout(day, CHILD_A), [
      meta(CHILD_A, { forkedFrom: PARENT, at: '2026-07-10T03:00:00.000000300Z' }),
      tokenCount([100, 50, 10], T(6)),
    ])
    write(rollout(day, CHILD_B), [
      meta(CHILD_B, { forkedFrom: PARENT, at: '2026-07-10T03:00:00.000000700Z' }),
      tokenCount([100, 50, 10], T(6)),
    ])
    const ctx = await scanOnce()
    expect(table(ctx, CHILD_A)).toEqual([[`codex:${CHILD_A}:1`, 50, 50, 10]])
    expect(table(ctx, CHILD_B)).toEqual([])
  })
})

describe('pages that continue a thread', () => {
  it('reads a resumed rollout under its thread id and keys it by its rollout id', async () => {
    write(join(day, `rollout-2026-08-26T17-18-13-${PARENT}_${CHILD_A}.jsonl`), [
      meta(PARENT),
      turn(),
      tokenCount([100, 50, 10]),
    ])
    expect(table(await scanOnce(), PARENT)).toEqual([[`codex:${CHILD_A}:1`, 50, 50, 10]])
  })

  it("continues the totals of a branch thread's first page", async () => {
    write(rollout(day, CHILD_A), [
      meta(CHILD_A, { forkedFrom: PARENT, at: '2026-08-26T09:18:00Z' }),
      tokenCount([50, 25, 10], '2026-08-26T09:18:05Z'),
    ])
    write(join(day, `rollout-2026-08-26T17-18-13-${CHILD_A}_${CHILD_A_PAGE}.jsonl`), [
      meta(CHILD_A, {
        forkedFrom: PARENT,
        paginated: true,
        historyBase: CHILD_A,
        at: '2026-08-26T09:18:20Z',
      }),
      turn(),
      tokenCount([100, 50, 20], '2026-08-26T09:18:21Z'),
    ])
    // The first page waits on its missing parent; the next page is no fork.
    expect(table(await scanOnce(), CHILD_A)).toEqual([[`codex:${CHILD_A_PAGE}:1`, 25, 25, 10]])
  })

  it('chains several pages and a subagent forked from the last one', async () => {
    write(rollout(day, PARENT), [
      meta(PARENT),
      tokenCount([1_000, 900, 100], T(1)),
      turn(undefined, T(20)),
    ])
    write(rollout(day, CHILD_A, '2026-07-10T03-00-15'), [
      meta(CHILD_A, { forkedFrom: PARENT, at: T(15) }),
      turn(),
      tokenCount([1_000, 900, 100], T(16)),
      tokenCount([1_500, 1_300, 150], T(20)),
    ])
    const page = (id: string, minute: number, historyBase: string) =>
      write(join(day, `rollout-2026-07-10T03-0${minute}-00-${CHILD_A}_${id}.jsonl`), [
        meta(CHILD_A, { forkedFrom: PARENT, paginated: true, historyBase, at: T(0, minute) }),
        turn(undefined, T(1, minute)),
      ])
    append(page(CHILD_A_PAGE, 1, CHILD_A), [tokenCount([1_700, 1_450, 200], T(5, 1))])
    // Its history base is the page before it.
    append(page(CHILD_A_PAGE_2, 2, CHILD_A_PAGE), [
      tokenCount([2_000, 1_650, 250], T(10, 2)),
      turn(undefined, T(30, 2)),
    ])
    write(rollout(day, CHILD_B, '2026-07-10T03-02-30'), [
      meta(CHILD_B, { forkedFrom: CHILD_A, spawnedFrom: CHILD_A, at: T(30, 2) }),
      turn(),
      tokenCount([1_000, 900, 100], T(31, 2)),
      tokenCount([1_500, 1_300, 150], T(32, 2)),
      tokenCount([1_700, 1_450, 200], T(33, 2)),
      tokenCount([2_000, 1_650, 250], T(34, 2)),
      tokenCount([2_150, 1_750, 280], T(40, 2)),
    ])
    const ctx = await scanOnce()
    expect(table(ctx, CHILD_A)).toEqual([
      [`codex:${CHILD_A}:2`, 100, 400, 50],
      [`codex:${CHILD_A_PAGE}:1`, 50, 150, 50],
      [`codex:${CHILD_A_PAGE_2}:1`, 100, 200, 50],
    ])
    expect(table(ctx, CHILD_B)).toEqual([[`codex:${CHILD_B}:5`, 50, 100, 30]])
  })

  it('treats a single-name fork with a history base as a fork, not a page', async () => {
    write(rollout(day, PARENT), [
      meta(PARENT),
      tokenCount([1_000, 900, 100], T(1)),
      turn(undefined, T(5)),
    ])
    const child = write(rollout(day, CHILD_A, '2026-07-10T03-00-20'), [
      meta(CHILD_A, { forkedFrom: PARENT, paginated: true, historyBase: PARENT, at: T(20) }),
      turn(undefined, T(21)),
      tokenCount([1_200, 1_000, 120], T(25)),
    ])
    const ctx = await scanOnce()
    expect(table(ctx, CHILD_A)).toEqual([])
    expect(cursorOf(ctx, child)).toBeUndefined()
  })

  const lonePage = () => join(day, `rollout-2026-07-10T03-01-00-${CHILD_A}_${CHILD_A_PAGE}.jsonl`)
  const pageMeta = meta(CHILD_A, {
    forkedFrom: PARENT,
    paginated: true,
    historyBase: CHILD_A,
    at: T(0, 1),
  })

  it("uses a page's last usage without the page before it", async () => {
    write(lonePage(), [
      pageMeta,
      turn(undefined, T(1, 1)),
      tokenCount([1_700, 1_450, 200], T(5, 1), { last: [120, 80, 30], limit: 'codex' }),
    ])
    expect(table(await scanOnce())).toEqual([[`codex:${CHILD_A_PAGE}:1`, 40, 80, 30]])
  })

  it('waits on a page with only totals while the page before it is missing', async () => {
    const page = write(lonePage(), [
      pageMeta,
      turn(undefined, T(1, 1)),
      tokenCount([1_700, 1_450, 200], T(5, 1)),
    ])
    const ctx = await scanOnce()
    expect(ctx.rows.size).toBe(0)
    expect(cursorOf(ctx, page)).toBeUndefined()
  })

  it('reads a page again after a scan aborted while reading the page before it', async () => {
    write(rollout(day, CHILD_A), [meta(CHILD_A), tokenCount([1_500, 1_300, 150], T(20))])
    write(lonePage(), [
      pageMeta,
      turn(undefined, T(1, 1)),
      tokenCount([1_700, 1_450, 200], T(5, 1)),
    ])
    const expected = [
      [`codex:${CHILD_A}:1`, 200, 1_300, 150],
      [`codex:${CHILD_A_PAGE}:1`, 50, 150, 50],
    ]
    expect(table(await scanOnce())).toEqual(expected)
    // Aborts at each check in turn, until a scan runs to its end.
    for (let at = 1; ; at++) {
      const controller = new AbortController()
      let checks = 0
      const signal = controller.signal
      signal.throwIfAborted = () => {
        if (++checks === at) controller.abort()
        AbortSignal.prototype.throwIfAborted.call(signal)
      }
      const reader = createCodexReader()
      const ctx = context({ signal })
      const finished = await reader.scan(ctx).then(
        () => !controller.signal.aborted,
        () => false,
      )
      if (finished) break
      Object.assign(ctx, { signal: new AbortController().signal })
      await reader.scan(ctx)
      expect(table(ctx), `aborted at check ${at}`).toEqual(expected)
    }
  })

  it('counts a page whose counter restarted from its own totals', async () => {
    write(rollout(day, CHILD_A), [meta(CHILD_A), tokenCount([1_500, 1_300, 150], T(20))])
    write(lonePage(), [
      meta(CHILD_A, { paginated: true, historyBase: CHILD_A, at: T(0, 1) }),
      turn(undefined, T(1, 1)),
      tokenCount([180, 100, 25], T(5, 1)),
    ])
    expect(table(await scanOnce())).toEqual([
      [`codex:${CHILD_A}:1`, 200, 1_300, 150],
      [`codex:${CHILD_A_PAGE}:1`, 80, 100, 25],
    ])
  })
})

describe('session_meta', () => {
  it('waits on a rollout whose name and session_meta disagree', async () => {
    const file = write(rollout(day, PARENT), [meta(CHILD_B), turn(), tokenCount([1, 1, 1])])
    const ctx = await scanOnce()
    expect(ctx.rows.size).toBe(0)
    expect(cursorOf(ctx, file)).toBeUndefined()
  })

  it('waits on usage before any session_meta', async () => {
    const file = write(rollout(day, CHILD_A), [turn(), tokenCount([100, 50, 10])])
    const reader = createCodexReader()
    const ctx = context()
    await reader.scan(ctx)
    expect(cursorOf(ctx, file)).toBeUndefined()
    write(file, [turn(), tokenCount([100, 50, 10]), meta(CHILD_A, { at: T(3) })])
    await reader.scan(ctx)
    expect(table(ctx)).toEqual([[`codex:${CHILD_A}:1`, 50, 50, 10]])
  })

  it('moves on past a rollout without session_meta or usage', async () => {
    const file = write(rollout(day, CHILD_A), [turn(), tokenCount([0, 0, 0])])
    const ctx = await scanOnce()
    expect(ctx.rows.size).toBe(0)
    expect(cursorOf(ctx, file)?.offset).toBe(readFileSync(file).length)
  })
})
