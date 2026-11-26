import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { FileCursor, ScanContext, UsageRow } from '../model'
import { antigravityReader, decodeWorkspaceUri, parseWorkspaceUris } from './antigravity'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function varint(value: number | bigint): Buffer {
  let n = typeof value === 'bigint' ? value : BigInt(value)
  const out: number[] = []
  do {
    let b = Number(n & 0x7fn)
    n >>= 7n
    if (n > 0n) b |= 0x80
    out.push(b)
  } while (n > 0n)
  return Buffer.from(out)
}

const fVarint = (field: number, value: number | bigint): Buffer =>
  Buffer.concat([varint((BigInt(field) << 3n) | 0n), varint(value)])
const fBytes = (field: number, payload: Buffer): Buffer =>
  Buffer.concat([varint((BigInt(field) << 3n) | 2n), varint(payload.length), payload])
const fStr = (field: number, text: string): Buffer => fBytes(field, Buffer.from(text, 'utf8'))

function makeStepMeta(opts: {
  sec: number
  stepIndex: number
  genIdx?: number
  originCid: string
  model?: number
  input: number
  output: number
  cacheRead: number
  thinking?: number
}): Buffer {
  const usage = Buffer.concat([
    ...(opts.model ? [fVarint(1, opts.model)] : []),
    fVarint(2, opts.input),
    fVarint(3, opts.output),
    fVarint(5, opts.cacheRead),
    ...(opts.thinking ? [fVarint(9, opts.thinking)] : []),
  ])
  const info = Buffer.concat([
    fVarint(2, opts.stepIndex),
    ...(opts.genIdx !== undefined ? [fVarint(3, opts.genIdx)] : []),
    fStr(4, opts.originCid),
  ])
  return Buffer.concat([fBytes(1, fVarint(1, opts.sec)), fBytes(9, usage), fBytes(20, info)])
}

function makeGenMeta(responseModel: string): Buffer {
  return fBytes(1, fStr(19, responseModel))
}

function createScanHarness(home: string) {
  const cursors = new Map<string, FileCursor>()
  const committed = new Map<string, UsageRow>()
  const context: ScanContext = {
    env: {},
    home,
    platform: 'darwin',
    signal: new AbortController().signal,
    cursor: (id) => cursors.get(id) ?? null,
    commit: (rows, cursor) => {
      cursors.set(cursor.id, cursor)
      for (const row of rows) committed.set(row.key, row)
    },
    plan: () => {},
    done: () => {},
    log: () => {},
  }
  return { context, cursors, committed }
}

describe('antigravity usage log reader', () => {
  it('解码跨平台 file:// 工作区 URI', () => {
    expect(decodeWorkspaceUri('file:///Users/me/Dev%20App', 'darwin')).toBe('/Users/me/Dev App')
    expect(decodeWorkspaceUri('file:///C:/Users/me/Repo', 'win32')).toBe('C:\\Users\\me\\Repo')
    expect(parseWorkspaceUris('["file:///repo/a","file:///repo/b"]', 'linux')).toBe('/repo/a')
  })

  it('扫描本地 SQLite 轨迹库，过滤分叉父步骤、推断压缩步模型，并回退读取 transcript.jsonl', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kettu-agy-usage-'))
    dirs.push(home)

    const cliRoot = path.join(home, '.gemini', 'antigravity-cli')
    const convDir = path.join(cliRoot, 'conversations')
    await mkdir(convDir, { recursive: true })

    const cidDb = '11111111-1111-1111-1111-111111111111'
    const cidParent = '99999999-9999-9999-9999-999999999999'
    const cidFallback = '22222222-2222-2222-2222-222222222222'

    // 1. 写入 conversation_summaries.db 提供工作区映射。
    const sumDb = new DatabaseSync(path.join(cliRoot, 'conversation_summaries.db'))
    try {
      sumDb.exec(`
        CREATE TABLE conversation_summaries (
          conversation_id TEXT PRIMARY KEY,
          workspace_uris TEXT NOT NULL DEFAULT ''
        );
      `)
      sumDb
        .prepare('INSERT INTO conversation_summaries VALUES (?, ?)')
        .run(cidDb, '["file:///Users/me/project-a"]')
      sumDb
        .prepare('INSERT INTO conversation_summaries VALUES (?, ?)')
        .run(cidFallback, '["file:///Users/me/project-b"]')
    } finally {
      sumDb.close()
    }

    // 2. 写入 conversations/<cidDb>.db：含 1 条正常步、1 条分叉自父会话的步骤（应过滤）、1 条无模型名压缩步（应推断）。
    const convDb = new DatabaseSync(path.join(convDir, `${cidDb}.db`))
    try {
      convDb.exec(`
        CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
        CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB);
      `)
      convDb
        .prepare('INSERT INTO gen_metadata VALUES (?, ?)')
        .run(1, makeGenMeta('gemini-4-argon-high'))
      const ins = convDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)')
      ins.run(
        1,
        15,
        3,
        makeStepMeta({
          sec: 1_760_000_000,
          stepIndex: 1,
          genIdx: 1,
          originCid: cidDb,
          model: 1418,
          input: 1200,
          output: 400,
          cacheRead: 8000,
          thinking: 150,
        }),
      )
      ins.run(
        2,
        15,
        3,
        makeStepMeta({
          sec: 1_760_000_010,
          stepIndex: 2,
          originCid: cidParent,
          model: 1418,
          input: 9999,
          output: 9999,
          cacheRead: 0,
        }),
      )
      ins.run(
        3,
        23,
        3,
        makeStepMeta({
          sec: 1_760_000_020,
          stepIndex: 3,
          originCid: cidDb,
          input: 500,
          output: 300,
          cacheRead: 5000,
        }),
      )
    } finally {
      convDb.close()
    }

    // 3. 写入仅有 transcript.jsonl 的回退会话（模拟旧加密 .pb 会话）。
    const fallbackLog = path.join(
      cliRoot,
      'brain',
      cidFallback,
      '.system_generated',
      'logs',
      'transcript.jsonl',
    )
    await mkdir(path.dirname(fallbackLog), { recursive: true })
    await writeFile(
      fallbackLog,
      [
        JSON.stringify({
          step_index: 5,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-25T10:00:00Z',
          model: 'claude-opus-5-5-max',
          input_tokens: 700,
          cache_read_tokens: 2000,
          output_tokens: 250,
        }),
      ].join('\n') + '\n',
    )

    const harness = createScanHarness(home)
    expect(await antigravityReader.scan(harness.context)).toBe(true)

    expect([...harness.committed.keys()].sort()).toEqual([
      `antigravity:${cidDb}:1`,
      `antigravity:${cidDb}:3`,
      `antigravity:${cidFallback}:5`,
    ])

    expect(harness.committed.get(`antigravity:${cidDb}:1`)).toMatchObject({
      agentId: 'antigravity',
      source: 'log',
      sessionId: cidDb,
      project: '/Users/me/project-a',
      model: 'gemini-4-argon-high',
      input: 1200,
      output: 400,
      reasoning: null,
      cacheRead: 8000,
    })
    // CHECKPOINT 自动压缩步继承前一步的模型名。
    expect(harness.committed.get(`antigravity:${cidDb}:3`)).toMatchObject({
      model: 'gemini-4-argon-high',
      input: 500,
      output: 300,
      cacheRead: 5000,
    })
    // transcript.jsonl 回退会话也正确入库。
    expect(harness.committed.get(`antigravity:${cidFallback}:5`)).toMatchObject({
      project: '/Users/me/project-b',
      model: 'claude-opus-5-5-max',
      input: 700,
      output: 250,
      cacheRead: 2000,
    })

    // 未发生变更时再次扫描应直接命中游标跳过。
    let commits = 0
    const secondContext: ScanContext = {
      ...harness.context,
      commit: () => {
        commits++
      },
    }
    expect(await antigravityReader.scan(secondContext)).toBe(true)
    expect(commits).toBe(0)
  })
})
