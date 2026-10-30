// What the Codex mapper makes of app-server items, against the same thread model ACP fills.

import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { applyPatches, threadEntries, threadFromSnapshot, type ThreadState } from '@shared/thread'
import { newTurnScope, type MapperContext, type MapperEffect } from '../session-updates'
import { mapAccount, mapRateLimits } from './account'
import { commandFacts, diffHunks, fenced, stripShellPrefix, ThreadMapper } from './mapper'

function run(
  notifications: [string, unknown][],
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
  for (const [method, params] of notifications) {
    const ctx: MapperContext = {
      thread,
      replaying: options.replaying ?? false,
      thoughtParts: false,
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
      locations: [{ path: '/p/a.ts' }],
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

  it('takes a thread name as the title unless it only repeats the first message', () => {
    const named = run([
      ['thread/name/updated', { threadId: 'thread-1', threadName: 'Fix the build' }],
    ])
    expect(named.thread.session.title).toBe('Fix the build')
    expect(named.effects).toContainEqual({ kind: 'title', title: 'Fix the build' })
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
    expect(entries[0]).toMatchObject({ kind: 'thought', markdown: 'raw\n\n summary' })
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

describe('the account and its limits', () => {
  it('names each kind of account', () => {
    expect(
      mapAccount({
        account: { type: 'chatgpt', email: 'a@b.c', planType: 'pro' },
        requiresOpenaiAuth: true,
      }),
    ).toEqual({
      kind: 'account',
      label: 'ChatGPT Pro',
      email: 'a@b.c',
    })
    expect(mapAccount({ account: { type: 'apiKey' }, requiresOpenaiAuth: true })).toMatchObject({
      kind: 'api_key',
      label: 'OpenAI API key',
    })
    expect(mapAccount({ account: null, requiresOpenaiAuth: true })).toMatchObject({ kind: 'none' })
    expect(mapAccount({ account: null, requiresOpenaiAuth: false })).toMatchObject({
      kind: 'gateway',
    })
  })

  it('names windows by their length, in seconds to milliseconds', () => {
    const limits = mapRateLimits(
      {
        limitId: 'codex',
        limitName: null,
        primary: { usedPercent: 40, windowDurationMins: 120, resetsAt: 10 },
        secondary: { usedPercent: 5, windowDurationMins: 43_200, resetsAt: null },
      },
      7,
    )
    expect(limits).toEqual([
      {
        window: '2_hour',
        label: '2-hour',
        usedPercent: 40,
        resetsAt: 10_000,
        state: 'ok',
        observedAt: 7,
      },
      {
        window: 'monthly',
        label: 'Monthly',
        usedPercent: 5,
        resetsAt: null,
        state: 'ok',
        observedAt: 7,
      },
    ])
  })
})
