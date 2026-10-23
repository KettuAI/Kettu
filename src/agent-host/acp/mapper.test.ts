import type { SessionUpdate, ToolCallUpdate } from '@agentclientprotocol/sdk/unstable'
import { describe, expect, it } from 'vitest'
import {
  applyPatches,
  threadEntries,
  threadFromSnapshot,
  type SessionView,
  type ThreadEntry,
  type ThreadState,
} from '@shared/thread'
import {
  addTokenTotals,
  mapAuthStatus,
  mapConfig,
  mapModelUsage,
  mapPermissionOptions,
  mapPermissionToolCall,
  mapRateLimit,
  mapSessionUpdate,
  mapTokenTotals,
  mergeConfig,
  newTurnScope,
  promptBlocks,
  rawInputText,
  type MapperEffect,
  type TurnScope,
} from './mapper'

const baseSession: SessionView = {
  id: 's1',
  agentId: 'fake-agent',
  projectPath: '/repo',
  acpSessionId: 'acp-1',
  status: 'running',
  title: null,
  config: [],
  commands: [],
  usage: null,
  error: null,
  turnStartedAt: 1,
  createdAt: 1,
  updatedAt: 1,
  parentId: null,
  origin: 'user',
  subagent: null,
  queue: [],
  queuePaused: false,
}

interface RunOptions {
  replaying?: boolean
  thread?: ThreadState
  scope?: TurnScope
  session?: Partial<SessionView>
}

/** Runs a fixture of updates and returns the final thread and every effect. */
function run(updates: SessionUpdate[], options: RunOptions = {}) {
  let thread =
    options.thread ??
    threadFromSnapshot({ session: { ...baseSession, ...options.session }, entries: [], seq: 0 })
  let counter = thread.order.length
  let now = 1_000
  const scope = options.scope ?? newTurnScope()
  const effects: MapperEffect[] = []
  for (const update of updates) {
    const out = mapSessionUpdate(update, {
      thread,
      replaying: options.replaying ?? false,
      scope,
      now,
      nextId: () => `e:${++counter}`,
      sessionIdFor: (id) => (id === 'acp-parent' ? 'parent' : null),
    })
    thread = applyPatches(thread, out.patches)
    effects.push(...out.effects)
    now += 100
  }
  return { thread, entries: threadEntries(thread), effects, scope }
}

const text = (value: string, messageId?: string): SessionUpdate => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: value },
  ...(messageId ? { messageId } : {}),
})

describe('message chunks', () => {
  it('appends by messageId, else to the last agent entry, else starts a new one', () => {
    const { entries } = run([
      text('Hel', 'a'),
      text('lo', 'a'),
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read' },
      text(' late', 'a'),
      text('No id'),
      text(' still'),
    ])
    expect(entries.map((e) => e.id)).toEqual(['m:a', 't:t1', 'e:1'])
    expect(entries[0]).toMatchObject({ kind: 'agent', markdown: 'Hello late', streaming: true })
    expect(entries[2]).toMatchObject({ kind: 'agent', markdown: 'No id still' })
  })

  it('keeps images and links as attachments and other content as unsupported refs', () => {
    const { entries } = run([
      text('See', 'a'),
      {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'a',
        content: { type: 'image', mimeType: 'image/png', data: 'AA' },
      },
      {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'a',
        content: { type: 'resource_link', uri: 'file:///x.md', name: 'x.md', title: 'X' },
      },
      {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'a',
        content: { type: 'audio', mimeType: 'audio/wav', data: 'AA' },
      },
      {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'a',
        content: { type: 'resource', resource: { uri: 'file:///n.txt', text: 'n' } },
      },
    ])
    expect(entries[0]).toMatchObject({
      markdown: 'See',
      attachments: [
        { kind: 'image', mimeType: 'image/png', data: 'AA' },
        { kind: 'link', uri: 'file:///x.md', name: 'X' },
        { kind: 'unsupported', label: 'Audio (audio/wav)' },
        { kind: 'unsupported', label: 'Embedded resource file:///n.txt' },
      ],
    })
  })

  it('starts an agent entry from an attachment alone', () => {
    const { entries } = run([
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'image', mimeType: 'image/png', data: 'AA' },
      },
    ])
    expect(entries[0]).toMatchObject({
      kind: 'agent',
      markdown: '',
      attachments: [{ kind: 'image' }],
    })
  })

  it('streams thoughts and closes them, with their duration, when something follows', () => {
    const { entries, scope } = run([
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Hmm' } },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: ', yes' } },
      text('Answer'),
    ])
    expect(entries[0]).toMatchObject({
      kind: 'thought',
      markdown: 'Hmm, yes',
      streaming: false,
      durationMs: 200,
    })
    expect(entries[1]).toMatchObject({ kind: 'agent', markdown: 'Answer' })
    expect(scope.thoughts.size).toBe(0)
  })

  it('separates a thought and a message that share one messageId', () => {
    const { entries } = run([
      {
        sessionUpdate: 'agent_thought_chunk',
        messageId: 'x',
        content: { type: 'text', text: 'think' },
      },
      text('say', 'x'),
    ])
    expect(entries.map((e) => [e.kind, e.id])).toEqual([
      ['thought', 'm:x'],
      ['agent', 'm:x#agent'],
    ])
  })

  it('adds replayed entries as not streaming', () => {
    const { entries } = run([text('Old answer', 'h1')], { replaying: true })
    expect(entries[0]).toMatchObject({ streaming: false })
  })
})

describe('user message chunks', () => {
  it('are ignored during a live turn', () => {
    const { entries } = run([
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'echo' } },
    ])
    expect(entries).toEqual([])
  })

  it('build user entries during a replay and start a new plan scope', () => {
    const { entries } = run(
      [
        {
          sessionUpdate: 'user_message_chunk',
          messageId: 'u1',
          content: { type: 'text', text: 'Fix ' },
        },
        {
          sessionUpdate: 'user_message_chunk',
          messageId: 'u1',
          content: { type: 'text', text: 'it' },
        },
        { sessionUpdate: 'plan', entries: [{ content: 'A', priority: 'high', status: 'pending' }] },
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Again' } },
        {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'image', mimeType: 'image/png', data: 'AA' },
        },
        { sessionUpdate: 'plan', entries: [{ content: 'B', priority: 'low', status: 'pending' }] },
      ],
      { replaying: true },
    )
    expect(entries.map((e) => e.kind)).toEqual(['user', 'plan', 'user', 'plan'])
    expect(entries[0]).toMatchObject({ id: 'm:u1', content: [{ type: 'text', text: 'Fix it' }] })
    expect(entries[2]).toMatchObject({
      content: [
        { type: 'text', text: 'Again' },
        { type: 'ref', ref: { kind: 'image' } },
      ],
    })
  })
})

describe('tool calls', () => {
  it('adds a call, updates only the fields present and replaces lists', () => {
    const { entries, effects } = run([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'c1',
        title: 'Run tests',
        kind: 'execute',
        status: 'pending',
        locations: [{ path: '/repo/a.ts', line: 3 }],
        rawInput: { command: 'pnpm test', cwd: '/repo' },
      },
      { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'in_progress' },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'completed',
        content: [
          { type: 'content', content: { type: 'text', text: 'ok\r\nall passed\r\n' } },
          { type: 'diff', path: '/repo/a.ts', oldText: 'a\r\n', newText: 'b\r\n' },
          { type: 'diff', path: '/repo/new.ts', newText: 'new' },
        ],
        locations: [{ path: '/repo/b.ts', line: null }],
      },
    ])
    expect(entries).toEqual<ThreadEntry[]>([
      {
        kind: 'tool',
        id: 't:c1',
        title: 'Run tests',
        toolKind: 'execute',
        status: 'completed',
        content: [
          { type: 'markdown', markdown: 'ok\nall passed\n' },
          { type: 'diff', path: '/repo/a.ts', oldText: 'a\n', newText: 'b\n' },
          { type: 'diff', path: '/repo/new.ts', oldText: null, newText: 'new' },
        ],
        locations: [{ path: '/repo/b.ts' }],
        permission: null,
        permissionResult: null,
        rawInput: 'pnpm test',
      },
    ])
    expect(effects).toEqual([
      {
        kind: 'tool',
        phase: 'started',
        toolCallId: 'c1',
        entryId: 't:c1',
        toolKind: 'execute',
        output: '',
      },
      {
        kind: 'tool',
        phase: 'ended',
        toolCallId: 'c1',
        entryId: 't:c1',
        toolKind: 'execute',
        output: 'ok\nall passed\n',
      },
    ])
  })

  it('updates a call announced twice instead of duplicating it', () => {
    const { entries } = run([
      { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Read', kind: 'read' },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'c1',
        title: 'Read src/a.ts',
        rawInput: 'src/a.ts',
      },
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      title: 'Read src/a.ts',
      toolKind: 'read',
      rawInput: 'src/a.ts',
    })
  })

  it('adds the entry when an update arrives before the call, with defaults', () => {
    const { entries, effects } = run([
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'late',
        status: 'failed',
        kind: 'bogus' as 'other',
      },
    ])
    expect(entries[0]).toMatchObject({ title: 'Tool call', toolKind: 'other', status: 'failed' })
    expect(effects.map((e) => (e.kind === 'tool' ? e.phase : e.kind))).toEqual(['started', 'ended'])
  })

  it('reports work that runs on in the background after its call, live only', () => {
    const background = (update: Partial<ToolCallUpdate>): SessionUpdate => ({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'bg',
      status: 'completed',
      ...update,
    })
    const kinds = (updates: SessionUpdate[], replaying = false) =>
      run(updates, { replaying }).effects.map((e) => e.kind)
    const command = { rawInput: { command: 'npm run dev', run_in_background: true } }
    expect(kinds([background(command)])).toContain('background')
    expect(kinds([background({ _meta: { claudeCode: { toolName: 'Monitor' } } })])).toContain(
      'background',
    )
    expect(kinds([background(command)], true)).not.toContain('background')
    expect(kinds([background({ rawInput: { command: 'ls' } })])).not.toContain('background')
    // A background agent is a subagent, whose own state says when it ends.
    expect(
      kinds([background({ rawInput: { prompt: 'Explore', run_in_background: true } })]),
    ).not.toContain('background')
  })

  it("keeps a command's description", () => {
    const { entries } = run([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'c1',
        title: 'pnpm test',
        kind: 'execute',
        rawInput: { command: 'pnpm test', description: 'Run the login tests' },
      },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'c2',
        title: 'ls',
        kind: 'execute',
        rawInput: { command: 'ls', command_description: 'List the files' },
      },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'c3',
        title: 'Publish',
        kind: 'other',
        rawInput: { title: 'Notes', description: 'Shared notes' },
      },
    ])
    expect(entries.map((e) => (e.kind === 'tool' ? e.description : null))).toEqual([
      'Run the login tests',
      'List the files',
      undefined,
    ])
    expect(entries[2]).not.toHaveProperty('description')
  })

  it('updates the description as the input streams in', () => {
    const { entries } = run([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'c1',
        title: 'Terminal',
        kind: 'execute',
        rawInput: {},
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        rawInput: { command: 'pnpm test', description: 'Run the' },
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        rawInput: { command: 'pnpm test', description: 'Run the login tests' },
      },
    ])
    expect(entries[0]).toMatchObject({ rawInput: 'pnpm test', description: 'Run the login tests' })
  })

  it('renders raw input as text', () => {
    expect(rawInputText(undefined)).toBeUndefined()
    expect(rawInputText('ls\r\n')).toBe('ls\n')
    expect(rawInputText({ command: ['git', 'status'] })).toBe('git status')
    expect(rawInputText({ path: '/a' })).toBe('{\n  "path": "/a"\n}')
  })
})

describe('plans', () => {
  it('replaces the current plan in a turn and starts a new one in the next', () => {
    const scope = newTurnScope()
    const first = run(
      [
        {
          sessionUpdate: 'plan',
          entries: [{ content: 'A', priority: 'high', status: 'in_progress' }],
        },
        {
          sessionUpdate: 'plan',
          entries: [{ content: 'A', priority: 'high', status: 'completed' }],
        },
      ],
      { scope },
    )
    expect(first.entries).toEqual([
      { kind: 'plan', id: 'e:1', items: [{ content: 'A', priority: 'high', status: 'completed' }] },
    ])
    const second = run(
      [{ sessionUpdate: 'plan', entries: [{ content: 'B', priority: 'low', status: 'pending' }] }],
      { thread: first.thread, scope: newTurnScope() },
    )
    expect(second.entries.map((e) => e.id)).toEqual(['e:1', 'e:2'])
  })
})

describe('session-level updates', () => {
  it('maps commands, config, modes, titles and usage', () => {
    const { thread, effects } = run(
      [
        {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            { name: 'compact', description: 'Compact' },
            { name: 'review', description: 'Review', input: { hint: '<branch>' } },
          ],
        },
        {
          sessionUpdate: 'config_option_update',
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: 'b',
              options: [
                { value: 'a', name: 'A' },
                { value: 'b', name: 'B' },
              ],
            },
          ],
        },
        { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
        {
          sessionUpdate: 'session_info_update',
          title: 'Fix login',
          updatedAt: '2026-10-20T10:00:00Z',
        },
        {
          sessionUpdate: 'usage_update',
          used: 1200,
          size: 200000,
          cost: { amount: 0.42, currency: 'USD' },
          _meta: {
            '_claude/rateLimit': {
              status: 'allowed_warning',
              rateLimitType: 'five_hour',
              utilization: 0.823,
              resetsAt: 1_800_000_000,
            },
          },
        },
      ],
      {
        session: {
          config: mapConfig([], {
            currentModeId: 'ask',
            availableModes: [
              { id: 'ask', name: 'Ask' },
              { id: 'plan', name: 'Plan', description: 'Plans first' },
            ],
          }),
          usage: {
            used: 0,
            size: 1,
            cost: null,
            tokens: {
              total: 9,
              input: 5,
              output: 4,
              thought: null,
              cacheRead: null,
              cacheWrite: null,
            },
          },
        },
      },
    )
    expect(thread.session.commands).toEqual([
      { name: 'compact', description: 'Compact' },
      { name: 'review', description: 'Review', inputHint: '<branch>' },
    ])
    expect(thread.session.config.map((o) => [o.id, o.value])).toEqual([
      ['__mode', 'plan'],
      ['model', 'b'],
    ])
    expect(thread.session.title).toBe('Fix login')
    expect(thread.session.updatedAt).toBe(Date.parse('2026-10-20T10:00:00Z'))
    expect(thread.session.usage).toEqual({
      used: 1200,
      size: 200000,
      cost: { amount: 0.42, currency: 'USD' },
      tokens: { total: 9, input: 5, output: 4, thought: null, cacheRead: null, cacheWrite: null },
    })
    expect(effects).toEqual([
      { kind: 'title', title: 'Fix login' },
      {
        kind: 'limit',
        limit: {
          window: 'five_hour',
          label: '5-hour',
          usedPercent: 82.3,
          resetsAt: 1_800_000_000_000,
          state: 'warning',
          observedAt: 1400,
        },
      },
    ])
  })

  it('updates a real mode option and reports a mode update without one', () => {
    const withMode = run([{ sessionUpdate: 'current_mode_update', currentModeId: 'code' }], {
      session: {
        config: [
          { id: 'mode', name: 'Mode', category: 'mode', type: 'select', value: 'ask', choices: [] },
        ],
      },
    })
    expect(withMode.thread.session.config[0]!.value).toBe('code')
    const without = run([{ sessionUpdate: 'current_mode_update', currentModeId: 'code' }])
    expect(without.effects).toEqual([
      { kind: 'ignored', variant: 'current_mode_update', detail: 'no mode option' },
    ])
  })

  it('reports a cleared title so the host can fall back', () => {
    const { thread, effects } = run([{ sessionUpdate: 'session_info_update', title: null }], {
      session: { title: 'Old' },
    })
    expect(thread.session.title).toBeNull()
    expect(effects).toEqual([{ kind: 'title', title: null }])
  })
})

describe('notices and compactions', () => {
  it('adds notices and shows unknown severities as info', () => {
    const { entries } = run([
      { sessionUpdate: 'notice', severity: 'warning', title: 'Careful', description: 'Really' },
      { sessionUpdate: 'notice', severity: 'debug', title: 'Odd' },
    ])
    expect(entries).toEqual([
      { kind: 'notice', id: 'e:1', severity: 'warning', title: 'Careful', description: 'Really' },
      { kind: 'notice', id: 'e:2', severity: 'info', title: 'Odd' },
    ])
  })

  it('tracks a compaction by id and streams its summary', () => {
    const { entries } = run([
      { sessionUpdate: 'compaction_update', compactionId: 'k', status: 'in_progress' },
      {
        sessionUpdate: 'compaction_summary_chunk',
        compactionId: 'k',
        content: { type: 'text', text: 'We ' },
      },
      {
        sessionUpdate: 'compaction_summary_chunk',
        compactionId: 'k',
        content: { type: 'text', text: 'fixed it' },
      },
      { sessionUpdate: 'compaction_update', compactionId: 'k', status: 'completed' },
      {
        sessionUpdate: 'compaction_summary_chunk',
        compactionId: 'j',
        content: { type: 'text', text: 'Early' },
      },
      {
        sessionUpdate: 'compaction_update',
        compactionId: 'f',
        status: 'failed',
        error: 'Too long',
      },
      { sessionUpdate: 'compaction_update', compactionId: 'f', status: 'something_new' },
    ])
    expect(entries).toEqual([
      { kind: 'compaction', id: 'c:k', status: 'completed', summary: 'We fixed it' },
      { kind: 'compaction', id: 'c:j', status: 'in_progress', summary: 'Early' },
      { kind: 'compaction', id: 'c:f', status: 'failed', summary: 'Too long' },
    ])
  })
})

describe('subagents', () => {
  it('reports announcements and changes, with null clearing', () => {
    const { effects, entries } = run([
      {
        sessionUpdate: 'subagent_update',
        sessionId: 'child-1',
        title: 'Explore',
        description: 'Find clock reads',
        capabilities: { cancel: {} },
        state: { state: 'running' },
      },
      {
        sessionUpdate: 'subagent_update',
        sessionId: 'child-1',
        state: { state: 'requires_action' },
      },
      { sessionUpdate: 'subagent_update', sessionId: 'child-1', capabilities: null, title: null },
      {
        sessionUpdate: 'subagent_update',
        sessionId: 'child-1',
        state: {
          state: 'idle',
          stopReason: 'end_turn',
          usage: { totalTokens: 3, inputTokens: 2, outputTokens: 1 },
        },
      },
      {
        sessionUpdate: 'subagent_update',
        sessionId: 'child-1',
        state: { state: 'idle', stopReason: 'error', error: { code: -32603, message: 'Boom' } },
      },
      { sessionUpdate: 'subagent_update', sessionId: 'child-1', state: { state: 'unknown' } },
      { sessionUpdate: 'subagent_update', sessionId: 'child-1', state: null },
    ])
    expect(entries).toEqual([])
    expect(effects).toEqual([
      {
        kind: 'subagent',
        acpSessionId: 'child-1',
        title: 'Explore',
        description: 'Find clock reads',
        canCancel: true,
        state: { kind: 'running' },
      },
      { kind: 'subagent', acpSessionId: 'child-1', state: { kind: 'requires_action' } },
      { kind: 'subagent', acpSessionId: 'child-1', title: null, canCancel: false },
      {
        kind: 'subagent',
        acpSessionId: 'child-1',
        state: {
          kind: 'idle',
          stopReason: 'end_turn',
          error: null,
          tokens: {
            total: 3,
            input: 2,
            output: 1,
            thought: null,
            cacheRead: null,
            cacheWrite: null,
          },
        },
      },
      {
        kind: 'subagent',
        acpSessionId: 'child-1',
        state: { kind: 'idle', stopReason: 'error', error: { message: 'Boom' }, tokens: null },
      },
      { kind: 'subagent', acpSessionId: 'child-1', state: { kind: 'unknown' } },
      { kind: 'subagent', acpSessionId: 'child-1', state: { kind: 'cleared' } },
    ])
  })

  it('adds and replaces session messages, and appends their chunks', () => {
    const { entries } = run([
      {
        sessionUpdate: 'session_message',
        messageId: 'd1',
        senderSessionId: 'acp-parent',
        recipientSessionId: 'acp-1',
        content: [{ type: 'text', text: 'Find it' }],
      },
      {
        sessionUpdate: 'session_message_chunk',
        messageId: 'd1',
        content: { type: 'text', text: ' fast' },
      },
      {
        sessionUpdate: 'session_message',
        messageId: 'd2',
        senderSessionId: 'stranger',
        content: null,
      },
      { sessionUpdate: 'session_message', messageId: 'd1' },
    ])
    expect(entries).toEqual([
      {
        kind: 'session_message',
        id: 'sm:d1',
        senderId: 'parent',
        content: [{ type: 'text', text: 'Find it fast' }],
      },
      { kind: 'session_message', id: 'sm:d2', senderId: null, content: [] },
    ])
  })
})

describe('unknown updates', () => {
  it('are ignored and reported', () => {
    const { entries, effects } = run([
      { sessionUpdate: 'future_update', value: 1 } as unknown as SessionUpdate,
      { sessionUpdate: 'plan_removed', planId: 'p' },
    ])
    expect(entries).toEqual([])
    expect(effects.map((e) => e.kind === 'ignored' && e.variant)).toEqual([
      'future_update',
      'plan_removed',
    ])
  })
})

describe('permissions', () => {
  it('adds the tool entry for an unseen call and maps the options', () => {
    const thread = threadFromSnapshot({ session: baseSession, entries: [], seq: 0 })
    const { entryId, output } = mapPermissionToolCall(
      { toolCallId: 'p1', title: 'Run rm', kind: 'execute', rawInput: { command: 'rm -rf x' } },
      {
        thread,
        replaying: false,
        scope: newTurnScope(),
        now: 1,
        nextId: () => 'e:1',
        sessionIdFor: () => null,
      },
    )
    expect(entryId).toBe('t:p1')
    expect(applyPatches(thread, output.patches).byId['t:p1']).toMatchObject({
      kind: 'tool',
      title: 'Run rm',
      status: 'pending',
      rawInput: 'rm -rf x',
    })
    expect(
      mapPermissionOptions([
        { optionId: 'a', name: 'Allow', kind: 'allow_once' },
        { optionId: 'r', name: 'Never', kind: 'reject_always' },
      ]),
    ).toEqual([
      { id: 'a', name: 'Allow', kind: 'allow_once' },
      { id: 'r', name: 'Never', kind: 'reject_always' },
    ])
  })
})

describe('config options', () => {
  it('flattens groups, keeps booleans and treats unknown categories as other', () => {
    expect(
      mapConfig(
        [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'deep',
            options: [
              { group: 'fast', name: 'Fast', options: [{ value: 'swift', name: 'Swift' }] },
              {
                group: 'smart',
                name: 'Smart',
                options: [{ value: 'deep', name: 'Deep', description: 'Slow' }],
              },
            ],
          },
          {
            id: 'fast',
            name: 'Fast mode',
            category: 'vendor_thing',
            type: 'boolean',
            currentValue: true,
          },
        ],
        null,
      ),
    ).toEqual([
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        value: 'deep',
        choices: [
          { value: 'swift', name: 'Swift', group: 'Fast' },
          { value: 'deep', name: 'Deep', description: 'Slow', group: 'Smart' },
        ],
      },
      { id: 'fast', name: 'Fast mode', category: 'other', type: 'boolean', value: true },
    ])
  })

  it('adds a synthetic mode only when no option covers modes', () => {
    const modes = { currentModeId: 'a', availableModes: [{ id: 'a', name: 'A' }] }
    expect(mapConfig(null, modes)[0]).toMatchObject({
      id: '__mode',
      value: 'a',
      choices: [{ value: 'a', name: 'A' }],
    })
    expect(
      mapConfig(
        [
          {
            id: 'mode',
            name: 'Mode',
            category: 'mode',
            type: 'select',
            currentValue: 'a',
            options: [],
          },
        ],
        modes,
      ).map((o) => o.id),
    ).toEqual(['mode'])
    const synthetic = mapConfig(null, modes)
    expect(mergeConfig(synthetic, []).map((o) => o.id)).toEqual(['__mode'])
  })
})

describe('extensions and helpers', () => {
  it('reads _auth/status_update', () => {
    expect(
      mapAuthStatus({
        authStatus: {
          kind: 'account',
          label: 'Claude Max',
          account: { plan: 'max', email: 'me@x.dev' },
        },
      }),
    ).toEqual({ kind: 'account', label: 'Claude Max', email: 'me@x.dev' })
    expect(mapAuthStatus({ authStatus: { kind: 'none', label: 'Not logged in' } })).toEqual({
      kind: 'none',
      label: 'Not logged in',
      email: null,
    })
    expect(mapAuthStatus({ authStatus: { kind: 'weird', label: 'x' } })).toBeNull()
    expect(mapAuthStatus(null)).toBeNull()
  })

  it('reads rate limits defensively', () => {
    expect(mapRateLimit({ status: 'rejected', rateLimitType: 'seven_day_opus' }, 5)).toEqual({
      window: 'seven_day_opus',
      label: 'Weekly · Opus',
      usedPercent: null,
      resetsAt: null,
      state: 'reached',
      observedAt: 5,
    })
    expect(
      mapRateLimit(
        { status: 'allowed', rateLimitType: 'seven_day_overage_included', utilization: 1.5 },
        5,
      ),
    ).toMatchObject({
      label: 'Weekly overage included',
      usedPercent: 100,
      state: 'ok',
    })
    expect(mapRateLimit({ status: 'allowed' }, 5)).toBeNull()
    expect(mapRateLimit('nope', 5)).toBeNull()
  })

  it('adds a turn to the token totals', () => {
    const turn = { total: 10, input: 4, output: 3, thought: null, cacheRead: 2, cacheWrite: null }
    expect(addTokenTotals(null, turn)).toBe(turn)
    expect(
      addTokenTotals(turn, {
        total: 7,
        input: 1,
        output: 2,
        thought: 3,
        cacheRead: null,
        cacheWrite: null,
      }),
    ).toEqual({ total: 17, input: 5, output: 5, thought: 3, cacheRead: 2, cacheWrite: null })
  })

  it('reads the tokens per model, with either name for the cache write', () => {
    const claude = {
      quota: {
        model_usage: [
          {
            model: 'claude-opus-5-5',
            token_count: {
              totalTokens: 166_135,
              inputTokens: 8,
              cachedInputTokens: 80_289,
              cachedWriteTokens: 85_417,
              outputTokens: 421,
              reasoningOutputTokens: 0,
            },
          },
          { model: 'broken', token_count: { inputTokens: -1, outputTokens: 2 } },
        ],
      },
    }
    expect(mapModelUsage(claude)).toEqual([
      {
        model: 'claude-opus-5-5',
        tokens: {
          total: 166_135,
          input: 8,
          output: 421,
          thought: 0,
          cacheRead: 80_289,
          cacheWrite: 85_417,
        },
      },
    ])
    const codex = {
      quota: {
        model_usage: [
          {
            model: 'gpt-5.6-sol',
            token_count: {
              inputTokens: 5,
              cachedInputTokens: 10,
              cacheWriteInputTokens: 2,
              outputTokens: 7,
            },
          },
        ],
      },
    }
    expect(mapModelUsage(codex)[0]?.tokens).toEqual({
      total: 24,
      input: 5,
      output: 7,
      thought: null,
      cacheRead: 10,
      cacheWrite: 2,
    })
    expect(mapModelUsage(undefined)).toEqual([])
    expect(mapModelUsage({ quota: { model_usage: 'x' } })).toEqual([])
  })

  it('maps token totals and prompt content', () => {
    expect(mapTokenTotals(null)).toBeNull()
    expect(
      promptBlocks([
        { type: 'text', text: 'hi' },
        { type: 'ref', ref: { kind: 'image', mimeType: 'image/png', data: 'AA' } },
        { type: 'ref', ref: { kind: 'link', uri: 'file:///a', name: 'a' } },
      ]),
    ).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'image', mimeType: 'image/png', data: 'AA' },
      { type: 'resource_link', uri: 'file:///a', name: 'a' },
    ])
  })
})
