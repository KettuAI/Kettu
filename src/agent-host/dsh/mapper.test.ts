// What the DeepSeek Harness mapper makes of its session events, as dsh 0.2.2-rc.2 sent them.

import { describe, expect, it } from 'vitest'
import { applyPatches, threadEntries, threadFromSnapshot, type ThreadState } from '@shared/thread'
import { newTurnScope, type MapperContext, type MapperEffect } from '../session-updates'
import { SessionMapper, tokenTotals, toolFacts } from './mapper'
import type { SessionEvent } from './protocol'

const CWD = '/work/app'

function run(events: [string, unknown][]) {
  let thread: ThreadState = threadFromSnapshot({
    session: {
      id: 's',
      agentId: 'deepseek',
      projectPath: CWD,
      acpSessionId: 'kettu-1',
      status: 'running',
      title: null,
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
  const mapper = new SessionMapper(CWD)
  const scope = newTurnScope()
  const effects: MapperEffect[] = []
  const unknown: string[] = []
  let n = 0
  events.forEach(([type, data], seq) => {
    const ctx: MapperContext = {
      thread,
      replaying: false,
      cancelling: false,
      scope,
      now: 1_000 + seq,
      nextId: () => `e:${++n}`,
      sessionIdFor: () => null,
    }
    const event: SessionEvent = { type, seq, time: 0, data } as SessionEvent
    const out = mapper.event(event, ctx)
    if (!out) unknown.push(type)
    else {
      thread = applyPatches(thread, out.patches)
      effects.push(...out.effects)
    }
  })
  return { thread, entries: threadEntries(thread), effects, unknown, mapper }
}

const assistant = (id: string, content: unknown[], usage?: unknown) =>
  [
    'assistant/message',
    { turn: 1, step: 1, message: { id, role: 'assistant', content }, ...(usage ? { usage } : {}) },
  ] as [string, unknown]

const call = (callId: string, name: string, args: unknown) =>
  ['tool/call', { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) }] as [
    string,
    unknown,
  ]

const result = (callId: string, text: string, extra: Record<string, unknown> = {}) =>
  [
    'tool/result',
    {
      turn: 1,
      step: 1,
      message: {
        id: `r-${callId}`,
        role: 'tool',
        toolCallId: callId,
        source: { kind: 'tool', callId },
        content: [{ type: 'text', text }],
        isError: extra.isError === true,
      },
      ...(extra.meta ? { meta: extra.meta } : {}),
      ...(extra.error ? { error: extra.error } : {}),
    },
  ] as [string, unknown]

describe('dsh mapper', () => {
  it('shows a committed message as its thought and its reply', () => {
    const { entries } = run([
      assistant('m1', [
        { type: 'reasoning', text: 'Tool came back.' },
        { type: 'text', text: 'Done. All tool calls finished.' },
      ]),
    ])
    expect(entries.map((entry) => [entry.kind, entry.id])).toEqual([
      ['thought', 'm:m1#thought'],
      ['agent', 'm:m1'],
    ])
    expect(entries[1]).toMatchObject({
      markdown: 'Done. All tool calls finished.',
      streaming: false,
    })
  })

  it('runs a shell call from its call to its fenced output', () => {
    const { entries, effects } = run([
      call('toolu_2', 'bash', { description: 'Say hi', command: 'echo hi && ls' }),
      result('toolu_2', 'hi\n', { meta: { cwd: CWD } }),
    ])
    expect(entries[0]).toMatchObject({
      kind: 'tool',
      id: 't:toolu_2',
      toolKind: 'execute',
      title: 'echo hi && ls',
      rawInput: 'echo hi && ls',
      description: 'Say hi',
      status: 'completed',
      content: [{ type: 'markdown', markdown: '```\nhi\n```' }],
    })
    expect(effects.map((effect) => effect.kind === 'tool' && effect.phase)).toEqual([
      'started',
      'ended',
    ])
  })

  it('shows an edit with the diff dsh attaches to its result', () => {
    const { entries } = run([
      call('toolu_4', 'edit', { file_path: 'notes.txt', old_string: 'two', new_string: 'three' }),
      result('toolu_4', 'The file has been updated successfully.', {
        meta: {
          path: `${CWD}/notes.txt`,
          diffs: [{ path: `${CWD}/notes.txt`, oldText: 'one\ntwo', newText: 'one\nthree' }],
        },
      }),
    ])
    expect(entries[0]).toMatchObject({
      toolKind: 'edit',
      locations: [{ path: `${CWD}/notes.txt` }],
      content: [
        { type: 'diff', path: `${CWD}/notes.txt`, oldText: 'one\ntwo', newText: 'one\nthree' },
      ],
    })
  })

  it('keeps a new file as the call wrote it, since dsh gives a creation no diff', () => {
    const { entries } = run([
      call('toolu_3', 'write', { file_path: 'notes.txt', content: 'one\ntwo\n' }),
      result('toolu_3', 'Created file', {
        meta: { operation: 'create', path: `${CWD}/notes.txt`, diffs: [] },
      }),
    ])
    expect(entries[0]).toMatchObject({
      status: 'completed',
      content: [{ type: 'diff', path: `${CWD}/notes.txt`, oldText: null, newText: 'one\ntwo\n' }],
    })
  })

  it('shows no change for a file written over with what it already held', () => {
    const { entries } = run([
      call('toolu_3', 'write', { file_path: 'notes.txt', content: 'one\ntwo\n' }),
      result('toolu_3', 'Updated file', {
        meta: { operation: 'update', path: `${CWD}/notes.txt`, diffs: [] },
      }),
    ])
    expect(entries[0]).toMatchObject({ status: 'completed', content: [] })
  })

  it('shows a failed call with its reason', () => {
    const { entries } = run([
      call('toolu_1', 'edit', { file_path: 'notes.txt', old_string: 'two', new_string: 'three' }),
      result('toolu_1', 'Error: cannot edit', { isError: true }),
    ])
    expect(entries[0]).toMatchObject({
      status: 'failed',
      content: [{ type: 'markdown', markdown: 'Error: cannot edit' }],
    })
  })

  it('turns todo_write into the plan and shows no row for it or for Kettu’s plan tool', () => {
    const todos = [
      { content: 'Run echo', status: 'in_progress' },
      { content: 'Read file', status: 'pending' },
    ]
    const { entries } = run([
      call('toolu_1', 'todo_write', { todos }),
      ['todo/write', { todos }],
      result('toolu_1', 'Updated todo list'),
      call('toolu_9', 'mcp__kettu__set_plan', { steps: [] }),
      ['todo/write', { todos: [{ ...todos[0], status: 'completed' }, todos[1]] }],
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      kind: 'plan',
      items: [
        { content: 'Run echo', status: 'completed' },
        { content: 'Read file', status: 'pending' },
      ],
    })
  })

  it('shows a subagent as its session, and its call only when no subagent started', () => {
    const { entries } = run([
      call('toolu_7', 'subagent', { description: 'Child task', prompt: 'hi', name: 'kid' }),
      result('toolu_7', 'started kid'),
      call('toolu_8', 'subagent', { description: 'Again', prompt: 'hi', name: 'kid' }),
      result('toolu_8', 'Error: name kid is taken', { isError: true }),
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      id: 't:toolu_8',
      status: 'failed',
      title: 'Again',
      content: [{ type: 'markdown', markdown: 'Error: name kid is taken' }],
    })
  })

  it('names an MCP tool by its server and tool', () => {
    expect(toolFacts('mcp__probe__ping', {}, CWD).title).toBe('probe: ping')
  })

  it('reports a step’s tokens and the context window as the session’s usage', () => {
    const { thread, effects } = run([
      [
        'request/context',
        { provider: 'deepseek-official', model: 'deepseek-flash', contextWindow: 1048576 },
      ],
      assistant('m1', [{ type: 'text', text: 'hi' }], {
        inputTokens: 1200,
        outputTokens: 42,
        cacheReadTokens: 300,
        totalTokens: 1542,
      }),
    ])
    expect(thread.session.usage).toMatchObject({ used: 1542, size: 1048576 })
    expect(effects.some((effect) => effect.kind === 'request')).toBe(true)
  })

  it('counts cache reads into input, as dsh’s counts do not overlap', () => {
    expect(
      tokenTotals({
        inputTokens: 1200,
        outputTokens: 42,
        cacheReadTokens: 300,
        reasoningTokens: 5,
      }),
    ).toEqual({
      total: 1542,
      input: 1500,
      output: 42,
      thought: 5,
      cacheRead: 300,
      cacheWrite: null,
    })
  })

  it('lists only the commands that run beside the turn on the session board', () => {
    const job = (id: string, callId: string) => ({
      jobId: id,
      owner: 'kettu-1',
      kind: 'bash',
      label: `cmd ${id}`,
      startedAt: 5,
      toolCall: { callId, rootCallId: callId },
    })
    const { effects } = run([
      call('c1', 'bash', { command: 'echo hi' }),
      ['job/registered', job('j1', 'c1')],
      ['job/settled', { ...job('j1', 'c1'), status: 'completed', finishedAt: 6 }],
      result('c1', 'hi'),
      call('c2', 'bash', { command: 'pnpm dev', run_in_background: true }),
      ['job/registered', job('j2', 'c2')],
      call('c3', 'bash', { command: 'sleep 99' }),
      ['job/registered', job('j3', 'c3')],
      result('c3', '[still running after 30000ms; moved to background job j3]'),
    ])
    const tasks = effects.filter((effect) => effect.kind === 'tasks')
    expect(tasks.at(-1)).toMatchObject({
      tasks: [
        { id: 'j2', kind: 'shell', status: 'running' },
        { id: 'j3', kind: 'shell', status: 'running' },
      ],
    })
  })

  it('finds the open question call a question without an id answers', () => {
    const { mapper, thread } = run([
      call('toolu_6', 'ask_user_question', {
        questions: [{ id: 'color', question: 'Which color?' }],
      }),
    ])
    const ctx = { thread } as MapperContext
    expect(mapper.openCall('ask_user_question', ctx)).toBe('toolu_6')
    expect(threadEntries(thread)[0]).toMatchObject({ question: 'Which color?' })
  })

  it('leaves events it does not show to the caller', () => {
    const { unknown } = run([
      ['agent/inbox/spliced', {}],
      ['approval/asked', {}],
    ])
    expect(unknown).toEqual(['agent/inbox/spliced', 'approval/asked'])
  })
})
