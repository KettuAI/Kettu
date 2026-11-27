import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { McpCallRecord } from '@shared/mcp-insight'
import { McpCalls } from './calls'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function store(now: () => number) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kettu-mcp-calls-'))
  dirs.push(dir)
  return { dir, calls: new McpCalls(dir, () => {}, now) }
}

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 26, 12)

const call = (at: number, extra: Partial<McpCallRecord> = {}): McpCallRecord => ({
  at,
  serverId: 'manual:files',
  sessionId: 's1',
  agentId: 'codex',
  tool: 'read',
  ms: 12,
  bytes: 40,
  result: 'ok',
  ...extra,
})

describe('the MCP call record', () => {
  it("writes a call's metadata alone, whatever else the caller hands it", async () => {
    const { dir, calls } = await store(() => NOW)
    const record = {
      ...call(NOW),
      arguments: { path: '/secret/plan.md' },
      content: [{ type: 'text', text: 'the file says hunter2' }],
    } as McpCallRecord
    await calls.add(record)
    const text = await readFile(path.join(dir, '2026-11-26.jsonl'), 'utf8')
    expect(text).not.toContain('/secret/plan.md')
    expect(text).not.toContain('hunter2')
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(
      ['agentId', 'at', 'bytes', 'ms', 'result', 'serverId', 'sessionId', 'tool'].sort(),
    )
    expect(await calls.list({ serverId: 'manual:files' })).toEqual([call(NOW)])
  })

  it('removes the days past 30 and never lists a call older than that', async () => {
    let now = NOW
    const { dir, calls } = await store(() => now)
    await writeFile(
      path.join(dir, '2026-10-20.jsonl'),
      JSON.stringify(call(Date.UTC(2026, 9, 20))) + '\n',
    )
    await writeFile(
      path.join(dir, '2026-10-28.jsonl'),
      JSON.stringify(call(Date.UTC(2026, 9, 28))) + '\n',
    )
    await calls.add(call(NOW))
    expect((await readdir(dir)).sort()).toEqual(['2026-10-28.jsonl', '2026-11-26.jsonl'])
    now = NOW + 5 * DAY
    const listed = await calls.list({ serverId: 'manual:files' })
    expect(listed.map((record) => record.at)).toEqual([NOW])
    await calls.add(call(now))
    expect(await readdir(dir)).not.toContain('2026-10-28.jsonl')
  })

  it('lists failed calls alone when asked, and skips lines Kettu did not write', async () => {
    const { dir, calls } = await store(() => NOW)
    await calls.add(call(NOW - 2, { result: 'error', error: 'The server exited' }))
    await calls.add(call(NOW - 1))
    await writeFile(path.join(dir, '2026-11-25.jsonl'), 'not json\n{"at":"x"}\n')
    const failed = await calls.list({ serverId: 'manual:files', failed: true })
    expect(failed).toEqual([call(NOW - 2, { result: 'error', error: 'The server exited' })])
  })
})
