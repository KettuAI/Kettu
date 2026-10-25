// Many cases follow cc-switch's tests, https://github.com/farion1231/cc-switch/blob/7da2553/src-tauri/src/services/session_usage.rs
// Copyright (c) 2025 Jason Young. MIT License.

import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Platform } from '@shared/platform'
import { rowTotal } from '../model'
import { memoryContext, type MemoryContext } from '../testing'
import { claudeReader } from './claude'

const platform: Platform = process.platform

let home: string
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'usage-claude-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const projects = (config = path.join(home, '.claude')): string => path.join(config, 'projects')
const context = (env: Record<string, string> = {}): MemoryContext =>
  memoryContext({ env, home, platform })

function write(relative: string, lines: string[], root = projects()): string {
  const file = path.join(root, relative)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, lines.map((line) => `${line}\n`).join(''))
  return file
}

let tick = 0
/** Moves the file's time on, since two writes in a test can land in one tick. */
function touch(file: string): void {
  tick += 10
  const time = new Date(Date.now() + tick * 1000)
  utimesSync(file, time, time)
}

interface Block {
  id: string
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  cacheWrite1h?: number
  stop?: string | null
  model?: string
  timestamp?: string
  sessionId?: string
}

function assistant(block: Block): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    message: {
      model: block.model ?? 'claude-opus-4-8',
      id: block.id,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      stop_reason: block.stop === undefined ? 'end_turn' : block.stop,
      usage: {
        input_tokens: block.input ?? 10,
        output_tokens: block.output ?? 5,
        cache_read_input_tokens: block.cacheRead ?? 100,
        cache_creation_input_tokens: block.cacheWrite ?? 50,
        cache_creation: {
          ephemeral_5m_input_tokens: (block.cacheWrite ?? 50) - (block.cacheWrite1h ?? 0),
          ephemeral_1h_input_tokens: block.cacheWrite1h ?? 0,
        },
      },
    },
    requestId: `req_${block.id}`,
    type: 'assistant',
    timestamp: block.timestamp ?? '2026-06-07T13:01:23Z',
    cwd: '/work/app',
    sessionId: block.sessionId ?? 'session-x',
  })
}

const total = (ctx: MemoryContext): number =>
  [...ctx.rows.values()].reduce((sum, row) => sum + rowTotal(row), 0)
const keys = (ctx: MemoryContext): string[] => [...ctx.rows.keys()].sort()

describe('claudeReader', () => {
  it('looks in CLAUDE_CONFIG_DIR, else in ~/.claude', () => {
    expect(claudeReader.locations({}, home)).toEqual([projects()])
    const moved = path.join(home, 'moved')
    expect(claudeReader.locations({ CLAUDE_CONFIG_DIR: moved }, home)).toEqual([projects(moved)])
  })

  it('resolves false when there are no logs', async () => {
    const ctx = context()
    expect(await claudeReader.scan(ctx)).toBe(false)
    expect(ctx.planned).toEqual({ files: 0, bytes: 0 })
  })

  it('honors CLAUDE_CONFIG_DIR', async () => {
    const moved = path.join(home, 'moved')
    write('p/s.jsonl', [assistant({ id: 'msg_home' })])
    write('p/s.jsonl', [assistant({ id: 'msg_moved' })], projects(moved))
    const ctx = context({ CLAUDE_CONFIG_DIR: moved })
    expect(await claudeReader.scan(ctx)).toBe(true)
    expect(keys(ctx)).toEqual(['claude:msg_moved'])
  })

  it("reads a message's tokens, model, time, session and folder", async () => {
    write('p/s.jsonl', [
      '{"type":"assistant","message":{"id":"msg_test123","model":"claude-opus-4-6","usage":{"input_tokens":3,"output_tokens":150,"cache_read_input_tokens":5000,"cache_creation_input_tokens":10000},"stop_reason":"end_turn"},"timestamp":"2026-04-05T12:00:00Z","sessionId":"session-abc","cwd":"/work/app"}',
    ])
    const ctx = context()
    await claudeReader.scan(ctx)
    expect([...ctx.rows.values()]).toEqual([
      {
        key: 'claude:msg_test123',
        source: 'log',
        agentId: 'claude-code',
        sessionId: 'session-abc',
        project: '/work/app',
        model: 'claude-opus-4-6',
        at: Date.parse('2026-04-05T12:00:00Z'),
        input: 3,
        output: 150,
        reasoning: null,
        cacheRead: 5000,
        cacheWrite: 10000,
        cacheWrite1h: 0,
        turn: 0,
      },
    ])
  })

  it("reads the hour's cache writes apart, with the total still in cacheWrite", async () => {
    write('p/s.jsonl', [
      assistant({ id: 'msg_hour', cacheWrite: 10_000, cacheWrite1h: 4_000 }),
      // A log without the split, or with an unusable one, keeps the hour at 0.
      assistant({ id: 'msg_flat' }).replace(/"cache_creation":\{[^}]*\},/, ''),
    ])
    const ctx = context()
    await claudeReader.scan(ctx)
    expect(ctx.rows.get('claude:msg_hour')).toMatchObject({
      cacheWrite: 10_000,
      cacheWrite1h: 4_000,
    })
    expect(ctx.rows.get('claude:msg_flat')).toMatchObject({ cacheWrite: 50, cacheWrite1h: 0 })
  })

  it('normalizes the model and leaves it empty when unknown', async () => {
    write('p/s.jsonl', [
      assistant({ id: 'msg_dated', model: 'claude-haiku-4-5-20251001' }),
      assistant({ id: 'msg_none' }).replace('"model":"claude-opus-4-8",', ''),
    ])
    const ctx = context()
    await claudeReader.scan(ctx)
    expect(ctx.rows.get('claude:msg_dated')?.model).toBe('claude-haiku-4-5')
    expect(ctx.rows.get('claude:msg_none')?.model).toBe('')
  })

  it('keeps one row per message: the line with a stop_reason, else the most output', async () => {
    write('p/s.jsonl', [
      assistant({ id: 'msg_1', output: 26, stop: null }),
      assistant({ id: 'msg_1', output: 1349, stop: 'end_turn' }),
      assistant({ id: 'msg_1', output: 2000, stop: null }),
      assistant({ id: 'msg_2', output: 3, stop: null }),
      assistant({ id: 'msg_2', output: 40, stop: null, timestamp: '2026-06-07T13:02:00Z' }),
      assistant({ id: 'msg_2', output: 7, stop: null }),
      assistant({ id: 'msg_3', output: 10, stop: 'tool_use' }),
      assistant({ id: 'msg_3', output: 12, stop: 'tool_use' }),
    ])
    const ctx = context()
    await claudeReader.scan(ctx)
    expect(keys(ctx)).toEqual(['claude:msg_1', 'claude:msg_2', 'claude:msg_3'])
    expect(ctx.rows.get('claude:msg_1')?.output).toBe(1349)
    expect(ctx.rows.get('claude:msg_2')).toMatchObject({
      output: 40,
      at: Date.parse('2026-06-07T13:02:00Z'),
    })
    expect(ctx.rows.get('claude:msg_3')?.output).toBe(12)
  })

  it('counts a message without a stop_reason that used tokens, and skips one that used none', async () => {
    write('p/s/subagents/workflows/wf_1/agent-wf.jsonl', [
      '{"type":"assistant","message":{"id":"msg_nostop","model":"claude-opus-4-8","usage":{"input_tokens":2,"output_tokens":1,"cache_read_input_tokens":48719,"cache_creation_input_tokens":2061}},"timestamp":"2026-06-07T13:01:23Z","sessionId":"session-wf"}',
      '{"type":"assistant","message":{"id":"msg_empty","model":"claude-opus-4-8","usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}},"timestamp":"2026-06-07T13:01:24Z","sessionId":"session-wf"}',
    ])
    const ctx = context()
    await claudeReader.scan(ctx)
    expect(keys(ctx)).toEqual(['claude:msg_nostop'])
    expect(ctx.rows.get('claude:msg_nostop')).toMatchObject({
      input: 2,
      output: 1,
      cacheRead: 48719,
      cacheWrite: 2061,
    })
  })

  it('skips lines that carry no assistant usage, and counters that are not counts', async () => {
    write('p/s.jsonl', [
      '{"type":"assistant","message":{"id":"msg_cut","usage":{"input_tokens":',
      '"usage"',
      '{"type":"user","message":{"role":"user","content":"x"},"toolUseResult":{"usage":{"input_tokens":5,"output_tokens":5}}}',
      '{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":5}}}',
      '{"type":"assistant","message":{"id":"msg_null","usage":null}}',
      '{"type":"assistant","message":{"id":"msg_odd","model":"claude-opus-4-8","usage":{"input_tokens":"12","output_tokens":-3,"cache_read_input_tokens":1.5,"cache_creation_input_tokens":7}},"timestamp":"2026-06-07T13:01:23Z"}',
    ])
    const ctx = context()
    await claudeReader.scan(ctx)
    expect(keys(ctx)).toEqual(['claude:msg_odd'])
    expect(ctx.rows.get('claude:msg_odd')).toMatchObject({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 7,
      sessionId: null,
      project: null,
    })
  })

  it('reads subagent and workflow subagent logs, and nothing elsewhere', async () => {
    write('p/main.jsonl', [assistant({ id: 'msg_main' })])
    write('p/s/subagents/agent-plain.jsonl', [assistant({ id: 'msg_plain' })])
    write('p/s/subagents/workflows/wf_test123/agent-wf.jsonl', [assistant({ id: 'msg_wf' })])
    write('p/s/subagents/workflows/wf_test123/journal.jsonl', ['{"type":"workflow_started"}'])
    write('top.jsonl', [assistant({ id: 'msg_top' })])
    write('p/notes.txt', [assistant({ id: 'msg_notes' })])
    write('p/s/tool-results/x.jsonl', [assistant({ id: 'msg_tool' })])
    write('p/s/subagents/other/x.jsonl', [assistant({ id: 'msg_other' })])
    mkdirSync(path.join(projects(), 'p', 'folder.jsonl'))
    const ctx = context()
    await claudeReader.scan(ctx)
    expect(keys(ctx)).toEqual(['claude:msg_main', 'claude:msg_plain', 'claude:msg_wf'])
    expect([...ctx.cursors.keys()].sort()).toEqual(
      [
        path.join(projects(), 'p', 'main.jsonl'),
        path.join(projects(), 'p', 's', 'subagents', 'agent-plain.jsonl'),
        path.join(projects(), 'p', 's', 'subagents', 'workflows', 'wf_test123', 'agent-wf.jsonl'),
        path.join(projects(), 'p', 's', 'subagents', 'workflows', 'wf_test123', 'journal.jsonl'),
      ].sort(),
    )
    expect(ctx.logs).toEqual([])
  })

  it('reads only what was appended, and reports its progress', async () => {
    const file = write('p/s.jsonl', [
      assistant({ id: 'msg_a', output: 5 }),
      assistant({ id: 'msg_b', output: 6 }),
    ])
    const ctx = context()
    await claudeReader.scan(ctx)
    const first = statSync(file).size
    expect(keys(ctx)).toEqual(['claude:msg_a', 'claude:msg_b'])
    expect(ctx.cursors.get(file)?.offset).toBe(first)
    expect(ctx.planned).toEqual({ files: 1, bytes: first })
    expect(ctx.doneBytes).toBe(first)

    appendFileSync(file, `${assistant({ id: 'msg_c', output: 7 })}\n`)
    const commit = vi.spyOn(ctx, 'commit')
    await claudeReader.scan(ctx)
    const second = statSync(file).size
    expect(commit).toHaveBeenCalledOnce()
    expect(commit.mock.calls[0]?.[0].map((row) => row.key)).toEqual(['claude:msg_c'])
    expect(ctx.cursors.get(file)?.offset).toBe(second)
    expect(ctx.planned).toEqual({ files: 2, bytes: second })
    expect(ctx.doneBytes).toBe(second)
  })

  it('leaves a last line without its newline for the next scan', async () => {
    const head = `${assistant({ id: 'msg_a' })}\n`
    const partial = assistant({ id: 'msg_partial' })
    const complete = assistant({ id: 'msg_tail' })
    const cut = Math.floor(partial.length / 2)
    const half = path.join(projects(), 'p', 'half.jsonl')
    const whole = path.join(projects(), 'p', 'whole.jsonl')
    mkdirSync(path.dirname(half), { recursive: true })
    writeFileSync(half, head + partial.slice(0, cut))
    writeFileSync(whole, head.replace('msg_a', 'msg_b') + complete)
    const ctx = context()
    await claudeReader.scan(ctx)
    expect(keys(ctx)).toEqual(['claude:msg_a', 'claude:msg_b'])
    expect(ctx.cursors.get(half)?.offset).toBe(head.length)
    expect(ctx.cursors.get(whole)?.offset).toBe(head.length)

    appendFileSync(half, `${partial.slice(cut)}\n`)
    appendFileSync(whole, '\n')
    await claudeReader.scan(ctx)
    expect(keys(ctx)).toEqual([
      'claude:msg_a',
      'claude:msg_b',
      'claude:msg_partial',
      'claude:msg_tail',
    ])
  })

  it('completes a message read half-written when a later scan finds the rest', async () => {
    const firstBlock = assistant({ id: 'msg_s', output: 5, stop: null })
    const finalBlock = assistant({
      id: 'msg_s',
      output: 4660,
      stop: 'tool_use',
      timestamp: '2026-06-07T13:00:30Z',
    })
    const file = write('p/s/subagents/agent-a.jsonl', [firstBlock])
    const ctx = context()
    await claudeReader.scan(ctx)
    expect(ctx.rows.get('claude:msg_s')?.output).toBe(5)

    appendFileSync(file, `${finalBlock}\n`)
    await claudeReader.scan(ctx)
    const moved = path.join(home, 'whole')
    write('p/s/subagents/agent-a.jsonl', [firstBlock, finalBlock], projects(moved))
    const whole = context({ CLAUDE_CONFIG_DIR: moved })
    await claudeReader.scan(whole)
    expect(ctx.rows.get('claude:msg_s')).toEqual(whole.rows.get('claude:msg_s'))
    expect(ctx.rows.get('claude:msg_s')).toMatchObject({
      output: 4660,
      at: Date.parse('2026-06-07T13:00:30Z'),
    })

    touch(file)
    const commit = vi.spyOn(ctx, 'commit')
    await claudeReader.scan(ctx)
    expect(commit.mock.calls[0]?.[0]).toEqual([])
    expect(ctx.rows.get('claude:msg_s')?.output).toBe(4660)
  })

  it('counts a message once when a resumed or forked session copies it into a new file', async () => {
    const copied = [
      assistant({ id: 'msg_1', output: 100 }),
      assistant({ id: 'msg_2', output: 200 }),
    ]
    write('p/original.jsonl', copied)
    const ctx = context()
    await claudeReader.scan(ctx)
    const before = total(ctx)

    write('p/fork.jsonl', [
      ...copied.map((line) => line.replace('session-x', 'session-fork')),
      assistant({ id: 'msg_3', output: 300, sessionId: 'session-fork' }),
    ])
    write('q/resumed.jsonl', copied)
    await claudeReader.scan(ctx)
    expect(keys(ctx)).toEqual(['claude:msg_1', 'claude:msg_2', 'claude:msg_3'])
    expect(total(ctx)).toBe(before + 10 + 300 + 100 + 50)
  })

  it('reads a rewritten file again from the start without counting twice', async () => {
    const file = write('p/s.jsonl', [assistant({ id: 'msg_a', output: 5 })])
    const ctx = context()
    await claudeReader.scan(ctx)
    const size = statSync(file).size

    // The same length, so only the tail shows the change.
    writeFileSync(file, `${assistant({ id: 'msg_x', output: 5 })}\n`)
    touch(file)
    expect(statSync(file).size).toBe(size)
    await claudeReader.scan(ctx)
    expect(keys(ctx)).toEqual(['claude:msg_a', 'claude:msg_x'])
    expect(ctx.cursors.get(file)?.offset).toBe(size)

    appendFileSync(file, `${assistant({ id: 'msg_c', output: 7 })}\n`)
    const commit = vi.spyOn(ctx, 'commit')
    await claudeReader.scan(ctx)
    expect(commit.mock.calls[0]?.[0].map((row) => row.key)).toEqual(['claude:msg_c'])
  })

  it('reads a shortened file again from the start without counting twice', async () => {
    const file = write('p/s.jsonl', [
      assistant({ id: 'msg_a', output: 5 }),
      assistant({ id: 'msg_b', output: 6 }),
    ])
    const ctx = context()
    await claudeReader.scan(ctx)
    const before = total(ctx)

    writeFileSync(file, `${assistant({ id: 'msg_a', output: 5 })}\n`)
    touch(file)
    const commit = vi.spyOn(ctx, 'commit')
    await claudeReader.scan(ctx)
    expect(commit.mock.calls[0]?.[0].map((row) => row.key)).toEqual(['claude:msg_a'])
    expect(total(ctx)).toBe(before)
    expect(ctx.cursors.get(file)?.offset).toBe(statSync(file).size)

    appendFileSync(file, `${assistant({ id: 'msg_c', output: 7 })}\n`)
    await claudeReader.scan(ctx)
    expect(keys(ctx)).toEqual(['claude:msg_a', 'claude:msg_b', 'claude:msg_c'])
  })

  it('skips a file only while both its size and its time are unchanged', async () => {
    const file = write('p/s.jsonl', [assistant({ id: 'msg_a' })])
    utimesSync(file, 1_700_000_000, 1_700_000_000)
    const ctx = context()
    await claudeReader.scan(ctx)
    const commit = vi.spyOn(ctx, 'commit')

    await claudeReader.scan(ctx)
    expect(commit).not.toHaveBeenCalled()
    expect(ctx.planned.files).toBe(1)

    // An append within the same tick keeps the time.
    appendFileSync(file, `${assistant({ id: 'msg_b' })}\n`)
    utimesSync(file, 1_700_000_000, 1_700_000_000)
    await claudeReader.scan(ctx)
    expect(commit).toHaveBeenCalledOnce()
    expect(keys(ctx)).toEqual(['claude:msg_a', 'claude:msg_b'])
  })

  it.skipIf(platform === 'win32' || process.getuid?.() === 0)(
    'logs a file it cannot read, leaves it uncommitted and tries it again',
    async () => {
      write('p/good.jsonl', [assistant({ id: 'msg_good' })])
      const bad = write('p/bad.jsonl', [assistant({ id: 'msg_bad' })])
      chmodSync(bad, 0o000)
      const ctx = context()
      try {
        expect(await claudeReader.scan(ctx)).toBe(true)
        expect(keys(ctx)).toEqual(['claude:msg_good'])
        expect(ctx.cursors.has(bad)).toBe(false)
        expect(ctx.logs).toEqual([{ level: 'warn', message: expect.stringContaining(bad) }])
        expect(ctx.doneBytes).toBe(ctx.planned.bytes)
      } finally {
        chmodSync(bad, 0o644)
      }
      await claudeReader.scan(ctx)
      expect(keys(ctx)).toEqual(['claude:msg_bad', 'claude:msg_good'])
    },
  )

  it('stops when the scan is aborted', async () => {
    write('p/s.jsonl', [assistant({ id: 'msg_a' })])
    const controller = new AbortController()
    controller.abort()
    const ctx = memoryContext({ home, platform, signal: controller.signal })
    const commit = vi.spyOn(ctx, 'commit')
    await expect(claudeReader.scan(ctx)).rejects.toThrow()
    expect(commit).not.toHaveBeenCalled()
  })
})
