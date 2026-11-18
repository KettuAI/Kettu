// What the Codex mapper makes of app-server items, against the same thread model ACP fills.

import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyPatches, threadEntries, threadFromSnapshot, type ThreadState } from '@shared/thread'
import { newTurnScope, type MapperContext, type MapperEffect } from '../session-updates'
import { commandFacts, diffHunks, fenced, stripShellPrefix, ThreadMapper } from './mapper'

function run(
  notifications: [string, unknown, number?][],
  options: { replaying?: boolean; title?: string } = {},
) {
  let thread: ThreadState = threadFromSnapshot({
    session: {
      id: 's',
      agentId: 'codex',
      projectPath: os.tmpdir(),
      acpSessionId: 'thread-1',
      status: 'running',
      title: options.title ?? null,
      config: [],
      commands: [],
      usage: null,
      error: null,
      turnStartedAt: null,
      turnStartUsed: null,
      createdAt: 0,
      updatedAt: 0,
      parentId: null,
      origin: 'user',
      subagent: null,
      routine: null,
      queue: [],
      queuePaused: false,
    },
    entries: [],
    seq: 0,
  })
  const mapper = new ThreadMapper()
  const scope = newTurnScope()
  const effects: MapperEffect[] = []
  let n = 0
  let now = 1_000
  const unknown: string[] = []
  for (const [method, params, time] of notifications) {
    if (time !== undefined) now = time
    const ctx: MapperContext = {
      thread,
      replaying: options.replaying ?? false,
      cancelling: false,
      scope,
      now,
      nextId: () => `e:${++n}`,
      sessionIdFor: () => null,
    }
    const out = mapper.notification(method, params, ctx)
    if (!out) unknown.push(method)
    else {
      thread = applyPatches(thread, out.patches)
      effects.push(...out.effects)
    }
    now += 100
  }
  return { thread, entries: threadEntries(thread), effects, unknown }
}

const at = { threadId: 'thread-1', turnId: 'turn-1' }
const started = (item: unknown): [string, unknown] => ['item/started', { ...at, item }]
const completed = (item: unknown): [string, unknown] => ['item/completed', { ...at, item }]

describe('output speed', () => {
  const usage = (output: number, reasoning = 0, time?: number): [string, unknown, number?] => {
    const last = {
      totalTokens: 1_000 + output,
      inputTokens: output === 0 ? 0 : 1_000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: output,
      reasoningOutputTokens: reasoning,
    }
    const tokenUsage = { total: last, last, modelContextWindow: 200_000 }
    return ['thread/tokenUsage/updated', { ...at, tokenUsage }, time]
  }
  const command = {
    type: 'commandExecution',
    id: 'x',
    command: 'ls',
    cwd: '/p',
    status: 'completed',
    commandActions: [],
    aggregatedOutput: '',
    exitCode: 0,
  }

  it('times streamed output from its first delta, and hidden reasoning from the request going out', () => {
    const user = { type: 'userMessage', id: 'u', content: [] }
    const { thread } = run([
      [...completed(user), 1_000],
      ['item/agentMessage/delta', { ...at, itemId: 'm', delta: 'Hi' }, 4_000],
      usage(300, 0, 6_000),
      [...completed(command), 8_000],
      ['item/agentMessage/delta', { ...at, itemId: 'm2', delta: 'Done' }, 15_000],
      usage(1_000, 700, 18_000),
      // A compaction counts nothing.
      usage(0, 0, 19_000),
    ])
    expect(thread.session.speed).toEqual({
      last: { tokens: 1_000, ms: 10_000, approx: true, firstTokenMs: null },
      recent: [
        { rate: 150, approx: false },
        { rate: 100, approx: true },
      ],
      turn: { since: null, tokens: 1_300, ms: 12_000, requests: 2, approx: 1 },
      session: { tokens: 1_300, ms: 12_000, requests: 2, approx: 1 },
    })
  })

  it('keeps the latest request with its input split from what came from the cache', () => {
    const last = {
      totalTokens: 41_210,
      inputTokens: 40_600,
      cachedInputTokens: 36_000,
      cacheWriteInputTokens: 2_000,
      outputTokens: 610,
      reasoningOutputTokens: 200,
    }
    const { thread } = run([
      [...completed({ type: 'userMessage', id: 'u', content: [] }), 1_000],
      [
        'thread/tokenUsage/updated',
        { ...at, tokenUsage: { total: last, last, modelContextWindow: 272_000 } },
        7_000,
      ],
    ])
    expect(thread.session.lastRequest).toEqual({
      at: 1_000,
      input: 2_600,
      cacheRead: 36_000,
      cacheWrite: 2_000,
      output: 610,
      ms: 6_000,
    })
  })

  it('times nothing in a replay', () => {
    const { thread } = run([usage(300, 0, 6_000)], { replaying: true })
    expect(thread.session.speed).toBeUndefined()
    expect(thread.session.lastRequest).toBeUndefined()
  })
})

describe('commands', () => {
  it('strips the shell Codex runs a command in', () => {
    expect(stripShellPrefix("/bin/zsh -lc 'touch a'")).toBe('touch a')
    expect(stripShellPrefix('bash -c ls')).toBe('ls')
    expect(stripShellPrefix('git status')).toBe('git status')
  })

  it('reads a file, a search and a listing as codex-acp showed them', () => {
    expect(
      commandFacts('cat a.ts', '/p', [
        { type: 'read', command: 'cat a.ts', name: 'a.ts', path: 'a.ts' },
      ]),
    ).toEqual({
      title: "Read file 'a.ts'",
      toolKind: 'read',
      locations: [{ path: path.resolve('/p', 'a.ts') }],
    })
    expect(
      commandFacts('rg x', '/p', [{ type: 'search', command: 'rg x', query: 'x', path: 'src' }]),
    ).toEqual({
      title: "Search for 'x' in src",
      toolKind: 'search',
      locations: [],
    })
    expect(
      commandFacts('ls', '/p', [{ type: 'listFiles', command: 'ls', path: null }]),
    ).toMatchObject({
      title: 'List files',
      toolKind: 'read',
    })
    // Several actions run as one command.
    expect(
      commandFacts("/bin/zsh -lc 'cat a && cat b'", '/p', [
        { type: 'read', command: 'cat a', name: 'a', path: 'a' },
        { type: 'read', command: 'cat b', name: 'b', path: 'b' },
      ]),
    ).toEqual({
      title: 'cat a && cat b',
      toolKind: 'execute',
      locations: [],
      rawInput: 'cat a && cat b',
    })
  })

  it('fences output with a fence longer than any inside, and shows the output of a read file not at all', () => {
    expect(fenced('a\n```\nb\n')).toBe('````\na\n```\nb\n````')
    const read = {
      type: 'commandExecution',
      id: 'x',
      command: 'cat a',
      cwd: '/p',
      status: 'completed',
      commandActions: [{ type: 'read', command: 'cat a', name: 'a', path: 'a' }],
      aggregatedOutput: 'secret file text',
      exitCode: 0,
    }
    const { entries } = run([completed(read)])
    expect(entries[0]).toMatchObject({ kind: 'tool', toolKind: 'read', content: [] })
  })

  it('keeps the end of a long output, and marks a declined command failed', () => {
    const item = {
      type: 'commandExecution',
      id: 'x',
      command: 'yes',
      cwd: '/p',
      status: 'inProgress',
      commandActions: [{ type: 'unknown', command: 'yes' }],
      aggregatedOutput: null,
      exitCode: null,
    }
    const { entries } = run([
      started(item),
      ['item/commandExecution/outputDelta', { ...at, itemId: 'x', delta: 'y\n'.repeat(40_000) }],
      completed({ ...item, status: 'declined' }),
    ])
    const tool = entries[0]
    expect(tool).toMatchObject({ status: 'failed' })
    const markdown =
      tool?.kind === 'tool' && tool.content[0]?.type === 'markdown' ? tool.content[0].markdown : ''
    expect(markdown.startsWith('```\n…\n')).toBe(true)
    expect(markdown.length).toBeLessThan(70 * 1024)
  })
})

describe('diffs', () => {
  it('reads each hunk of a unified diff as its old and new text', () => {
    expect(
      diffHunks('@@ -1,2 +1,2 @@\n a\n-b\n+c\n@@ -9 +9 @@\n-x\n+y\n\\ No newline at end of file\n'),
    ).toEqual([
      { oldText: 'a\nb', newText: 'a\nc' },
      { oldText: 'x', newText: 'y' },
    ])
    expect(diffHunks('not a diff')).toBeNull()
  })

  it('shows a moved file at its new path and a deleted one as all old text', () => {
    const { entries } = run([
      completed({
        type: 'fileChange',
        id: 'p',
        status: 'completed',
        changes: [
          {
            path: '/p/a',
            kind: { type: 'update', move_path: '/p/b' },
            diff: '@@ -1 +1 @@\n-1\n+2\n',
          },
          { path: '/p/c', kind: { type: 'delete' }, diff: 'gone\n' },
        ],
      }),
    ])
    expect(entries[0]).toMatchObject({
      locations: [{ path: '/p/b' }, { path: '/p/c' }],
      content: [
        { type: 'diff', path: '/p/b', oldText: '1', newText: '2' },
        { type: 'diff', path: '/p/c', oldText: 'gone\n', newText: '' },
      ],
    })
  })
})

describe('the plan tool', () => {
  const call = (id: string, server: string, tool: string) => ({
    type: 'mcpToolCall',
    id,
    server,
    tool,
    status: 'completed',
    arguments: {},
    result: null,
    error: null,
    durationMs: 1,
  })

  it('shows no row for its call, and one for another server with a tool of that name', () => {
    const { entries } = run([
      started({ ...call('a', 'kettu', 'set_plan'), status: 'inProgress' }),
      completed(call('a', 'kettu', 'set_plan')),
      completed(call('b', 'other', 'set_plan')),
    ])
    expect(entries.map((entry) => entry.id)).toEqual(['t:b'])
  })

  it('shows no row for a memory write, unless it failed and so wrote nothing', () => {
    const refused = { message: 'This looks like a secret' }
    const { entries } = run([
      completed(call('a', 'kettu', 'remember')),
      completed({ ...call('b', 'kettu', 'update_memory'), status: 'failed', error: refused }),
      completed({ ...call('c', 'kettu', 'set_plan'), status: 'failed', error: refused }),
    ])
    expect(entries.map((entry) => entry.id)).toEqual(['t:b'])
    expect(entries[0]).toMatchObject({ status: 'failed' })
  })

  it("keeps what a workflow tool returned for its card, and nothing from another server's", () => {
    const structuredContent = {
      accepted: false,
      checks: [{ check: 'outcome', ok: false, detail: 'Report one of its outcomes.' }],
      next: { kind: 'retry' },
      facts: null,
    }
    const result = { content: [{ type: 'text', text: 'Refused' }], structuredContent }
    const { entries } = run([
      completed({ ...call('a', 'kettu', 'report_step'), status: 'failed', result }),
      completed({ ...call('b', 'other', 'report_step'), result }),
    ])
    expect(entries[0]).toMatchObject({
      structured: {
        accepted: false,
        checks: structuredContent.checks,
        next: { kind: 'retry' },
      },
    })
    expect(entries[0]).not.toHaveProperty('structured.facts')
    expect(entries[1]).not.toHaveProperty('structured')
  })
})

describe('a question asked without waiting', () => {
  const asked = {
    type: 'agentMessage',
    id: 'call_1',
    text: 'Keep the vault?',
    phase: 'final_answer',
    delivery: 'async',
    questions: [{ title: 'Keep the vault?', options: ['Keep it', 'Delete it'] }],
  }
  const reply = (answer: string) => ({
    type: 'userMessage',
    id: 'u1',
    content: [
      {
        type: 'text',
        text:
          '<send_user_message_question_reply>\n' +
          JSON.stringify([
            {
              questionItemId: JSON.stringify(['request_user_input_async', 'call_1', 0]),
              question: 'Keep the vault?',
              answer,
            },
          ]) +
          '\n</send_user_message_question_reply>',
        text_elements: [],
      },
    ],
  })

  it('is a completed step that names the question, not an agent message', () => {
    const { entries } = run([completed(asked)])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      kind: 'tool',
      id: 't:call_1',
      status: 'completed',
      question: 'Keep the vault?',
      permission: null,
      permissionResult: null,
    })
  })

  it('lists every question with its choices in the step', () => {
    const { entries } = run([
      completed({
        ...asked,
        questions: [
          { title: 'Keep the vault?', options: ['Keep it', 'Delete it'] },
          { title: 'Why?', options: null },
        ],
      }),
    ])
    const entry = entries[0]
    expect(entry?.kind === 'tool' && entry.content).toEqual([
      {
        type: 'markdown',
        markdown: '1. Keep the vault?\n   - Keep it\n   - Delete it\n2. Why?',
      },
    ])
  })

  it('marks the question answered on a replay and draws no message for the reply', () => {
    const { entries } = run([completed(asked), completed(reply('Keep it'))], { replaying: true })
    expect(entries.map((entry) => entry.kind)).toEqual(['tool'])
    expect(entries[0]).toMatchObject({
      permissionResult: {
        kind: 'allow_once',
        questions: [{ question: 'Keep the vault?', answered: true, answer: 'Keep it' }],
      },
    })
  })

  it('keeps a message that only looks like a reply', () => {
    const lookalike = {
      type: 'userMessage',
      id: 'u2',
      content: [
        { type: 'text', text: '<send_user_message_question_reply>not json', text_elements: [] },
      ],
    }
    expect(run([completed(lookalike)], { replaying: true }).entries.map((e) => e.kind)).toEqual([
      'user',
    ])
  })
})

describe('other items', () => {
  it('maps plans, searches, MCP calls, compaction and a reroute', () => {
    const { entries } = run([
      [
        'turn/plan/updated',
        {
          ...at,
          explanation: null,
          plan: [
            { step: 'Read', status: 'completed' },
            { step: 'Fix', status: 'inProgress' },
          ],
        },
      ],
      [
        'turn/plan/updated',
        {
          ...at,
          explanation: null,
          plan: [
            { step: 'Read', status: 'completed' },
            { step: 'Fix', status: 'completed' },
          ],
        },
      ],
      completed({
        type: 'webSearch',
        id: 'w',
        query: 'vitest',
        action: { type: 'search', query: 'vitest', queries: null },
      }),
      completed({
        type: 'webSearch',
        id: 'o',
        query: '',
        action: { type: 'openPage', url: 'https://example.com' },
      }),
      completed({
        type: 'mcpToolCall',
        id: 'mcp',
        server: 'kettu',
        tool: 'create_artifact',
        status: 'completed',
        arguments: { title: 'Notes' },
        result: { content: [{ type: 'text', text: 'Created' }] },
        error: null,
      }),
      started({ type: 'contextCompaction', id: 'c' }),
      completed({ type: 'contextCompaction', id: 'c' }),
      ['model/rerouted', { ...at, fromModel: 'a', toModel: 'b', reason: 'x' }],
    ])
    expect(entries.map((e) => e.kind)).toEqual([
      'plan',
      'tool',
      'tool',
      'tool',
      'compaction',
      'notice',
    ])
    expect(entries[0]).toMatchObject({
      items: [
        { content: 'Read', status: 'completed', priority: 'medium' },
        { content: 'Fix', status: 'completed', priority: 'medium' },
      ],
    })
    expect(entries[1]).toMatchObject({ toolKind: 'search', title: 'Web search: vitest' })
    expect(entries[2]).toMatchObject({ toolKind: 'fetch', title: 'Open https://example.com' })
    expect(entries[3]).toMatchObject({
      toolKind: 'other',
      title: 'kettu: create_artifact',
      content: [{ type: 'markdown', markdown: 'Created' }],
    })
    expect(entries[4]).toMatchObject({ kind: 'compaction', status: 'completed' })
    expect(entries[5]).toMatchObject({ kind: 'notice', title: 'Codex switched from a to b' })
  })

  it('shows raw reasoning only while the thought has no summary', () => {
    const { entries } = run([
      started({ type: 'reasoning', id: 'r', summary: [], content: [] }),
      ['item/reasoning/textDelta', { ...at, itemId: 'r', contentIndex: 0, delta: 'raw' }],
      [
        'item/reasoning/summaryTextDelta',
        { ...at, itemId: 'r', summaryIndex: 0, delta: ' summary' },
      ],
      ['item/reasoning/textDelta', { ...at, itemId: 'r', contentIndex: 0, delta: ' more raw' }],
    ])
    expect(entries).toMatchObject([
      { kind: 'thought', markdown: 'raw' },
      { kind: 'thought', markdown: ' summary' },
    ])
  })

  it('keeps each reasoning summary part as a thought of its own', () => {
    const part = (index: number): [string, unknown] => [
      'item/reasoning/summaryPartAdded',
      { ...at, itemId: 'r', summaryIndex: index },
    ]
    const delta = (index: number, text: string): [string, unknown] => [
      'item/reasoning/summaryTextDelta',
      { ...at, itemId: 'r', summaryIndex: index, delta: text },
    ]
    const summary = ['**Verifying shared top bar**', '**Locating artifact import contract**']
    const { entries } = run([
      started({ type: 'reasoning', id: 'r', summary: [], content: [] }),
      part(0),
      delta(0, summary[0]!),
      part(1),
      delta(1, summary[1]!),
      completed({ type: 'reasoning', id: 'r', summary, content: [] }),
    ])
    expect(entries).toMatchObject([
      { kind: 'thought', id: 'm:r', markdown: summary[0], streaming: false },
      { kind: 'thought', id: 'm:r#part1', markdown: summary[1], streaming: false },
    ])
  })

  it('starts a new thought at each part Codex announces, even under one index', () => {
    const part: [string, unknown] = [
      'item/reasoning/summaryPartAdded',
      { ...at, itemId: 'r', summaryIndex: 0 },
    ]
    const delta = (text: string): [string, unknown] => [
      'item/reasoning/summaryTextDelta',
      { ...at, itemId: 'r', summaryIndex: 0, delta: text },
    ]
    const { entries } = run([
      started({ type: 'reasoning', id: 'r', summary: [], content: [] }),
      part,
      delta('**One**'),
      part,
      delta('**Two**'),
    ])
    expect(entries).toMatchObject([
      { kind: 'thought', markdown: '**One**' },
      { kind: 'thought', markdown: '**Two**' },
    ])
  })

  it('replays a reasoning item as one thought per summary part', () => {
    const { entries } = run(
      [completed({ type: 'reasoning', id: 'r', summary: ['**One**', '', '**Two**'], content: [] })],
      { replaying: true },
    )
    expect(entries).toMatchObject([
      { kind: 'thought', id: 'm:r', markdown: '**One**', streaming: false },
      { kind: 'thought', id: 'm:r#part1', markdown: '**Two**', streaming: false },
    ])
  })

  it('shows no thought that stays empty', () => {
    const item = { type: 'reasoning', id: 'r', summary: [], content: [] }
    expect(run([started(item), completed(item)]).entries).toEqual([])
    const { entries } = run([
      started(item),
      ['item/reasoning/summaryTextDelta', { ...at, itemId: 'r', summaryIndex: 0, delta: 'Hm' }],
      completed({ ...item, summary: ['Hm'] }),
    ])
    expect(entries).toEqual([
      { kind: 'thought', id: 'm:r', markdown: 'Hm', streaming: false, durationMs: 100 },
    ])
  })

  it('takes no notification it does not know', () => {
    expect(run([['item/somethingNew', at]]).unknown).toEqual(['item/somethingNew'])
  })

  it('leaves the live user message to the host, and replays it', () => {
    const user = {
      type: 'userMessage',
      id: 'u',
      content: [{ type: 'text', text: 'hi', text_elements: [] }],
    }
    expect(run([completed(user)]).entries).toEqual([])
    expect(run([completed(user)], { replaying: true }).entries).toEqual([
      { kind: 'user', id: 'm:u', content: [{ type: 'text', text: 'hi' }] },
    ])
  })
})
