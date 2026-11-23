// What the Cline mapper makes of the SDK's events, as @cline/sdk 0.2.0 sent them through Kettu's
// host process (cline 3.0.74), one recorded turn at a time.

import { describe, expect, it } from 'vitest'
import { applyPatches, threadEntries, threadFromSnapshot, type ThreadState } from '@shared/thread'
import { newTurnScope, type MapperContext, type MapperEffect } from '../session-updates'
import recorded from './fixtures/recorded.json'
import { mcpTool, outputText, patchFiles, SessionMapper, tokenTotals, toolFacts } from './mapper'
import type { ApprovalParams, ClineEvent } from './protocol'

const CWD = '/work/app'

type Wire = [string, unknown]
type TurnName = keyof typeof recorded.turns

/** Replays recorded turns as the connection feeds them: an approval announces its call's row. */
function run(
  names: TurnName[],
  options: {
    window?: number
    cancelling?: boolean
    /** How many of the last turn's messages arrive before it ends. */
    take?: number
    /** Other events in place of the last turn's own from `take` on. */
    then?: ClineEvent[]
    /** The turn ends after them, as when the user stops it. */
    ended?: boolean
  } = {},
) {
  let thread: ThreadState = threadFromSnapshot({
    session: {
      id: 's',
      agentId: 'cline',
      projectPath: CWD,
      acpSessionId: '1_kettu',
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
  if (options.window) mapper.window(options.window)
  const scope = newTurnScope()
  const effects: MapperEffect[] = []
  const dropped: string[] = []
  let n = 0
  let now = 1_000
  const context = (): MapperContext => ({
    thread,
    replaying: false,
    cancelling: options.cancelling === true,
    scope,
    now: (now += 10),
    nextId: () => `e:${++n}`,
    sessionIdFor: () => null,
  })
  for (const [index, name] of names.entries()) {
    mapper.turn()
    let wire = recorded.turns[name].wire as Wire[]
    if (index === names.length - 1) {
      wire = [
        ...wire.slice(0, options.take),
        ...(options.then ?? []).map((event): Wire => ['event', event]),
      ]
    }
    for (const [kind, data] of wire) {
      const ctx = context()
      if (kind === 'approval') {
        const ask = data as Omit<ApprovalParams, 'sessionId'>
        const out = mapper.announce(ask.toolCallId, ask.toolName, ask.input, ctx)
        thread = applyPatches(thread, out.patches)
      } else if (kind === 'event') {
        const out = mapper.event(data as ClineEvent, ctx)
        if (!out) dropped.push((data as ClineEvent).type)
        else {
          thread = applyPatches(thread, out.patches)
          effects.push(...out.effects)
        }
      }
    }
  }
  if (options.ended) {
    const out = mapper.ended(context())
    if (out) thread = applyPatches(thread, out.patches)
  }
  return { thread, entries: threadEntries(thread), effects, dropped }
}

/** The notice of the recorded compaction that says it started, as another phase of it. */
function compactionNotice(phase: string, message: string): ClineEvent {
  const [, started] = (recorded.turns['real-compaction'].wire as Wire[])[1]!
  const notice = started as Extract<ClineEvent, { type: 'notice' }>
  return { ...notice, message, metadata: { ...notice.metadata, phase } }
}

describe('Cline mapper', () => {
  it('joins streamed reasoning and text into one thought and one reply', () => {
    const { entries } = run(['think'])
    expect(entries.map((entry) => entry.kind)).toEqual(['thought', 'agent'])
    expect(entries[0]).toMatchObject({
      markdown: 'Let me think about it. Done thinking.',
      streaming: false,
    })
    expect(entries[1]).toMatchObject({ markdown: 'Thought it through.', streaming: false })
  })

  it('reports the context a request used against the model window, and the request itself', () => {
    const { thread, effects } = run(['think'], { window: 128_000 })
    expect(thread.session.usage).toMatchObject({ used: 1231, size: 128_000 })
    expect(effects.filter((effect) => effect.kind === 'request')).toHaveLength(1)
  })

  it('counts no request once the user stopped the turn', () => {
    const { effects } = run(['think'], { cancelling: true })
    expect(effects.filter((effect) => effect.kind === 'request')).toHaveLength(0)
  })

  it('shows a read as a row with the file and what it read', () => {
    const { entries } = run(['read'])
    const tool = entries.find((entry) => entry.kind === 'tool')
    expect(tool).toMatchObject({
      id: 't:call_2',
      title: "Read file 'hello.txt'",
      toolKind: 'read',
      status: 'completed',
      locations: [{ path: '/work/app/hello.txt' }],
    })
    expect(tool?.kind === 'tool' && tool.content[0]).toMatchObject({ type: 'markdown' })
    // The text before the call and the text after it are two replies.
    expect(entries.filter((entry) => entry.kind === 'agent')).toHaveLength(2)
  })

  it('announces a command that waits for approval, then runs it and fences what it printed', () => {
    const { entries, effects } = run(['shell'])
    const tool = entries.find((entry) => entry.kind === 'tool')
    expect(tool).toMatchObject({
      id: 't:call_4',
      title: 'echo probe-shell && ls',
      rawInput: 'echo probe-shell && ls',
      toolKind: 'execute',
      status: 'completed',
    })
    expect(tool?.kind === 'tool' && tool.content).toEqual([
      { type: 'markdown', markdown: expect.stringMatching(/^```\nprobe-shell\n[\s\S]*```$/) },
    ])
    expect(effects.filter((effect) => effect.kind === 'tool').map((e) => e.phase)).toEqual([
      'started',
      'ended',
    ])
  })

  it('leaves a denied call failed without its refusal as output, and adds no notice for it', () => {
    const { entries } = run(['shell-denied'])
    const tool = entries.find((entry) => entry.kind === 'tool')
    expect(tool).toMatchObject({ status: 'failed', content: [] })
    expect(entries.some((entry) => entry.kind === 'notice')).toBe(false)
  })

  it('shows a patch that adds a file, and one that changes it, as diffs', () => {
    const { entries } = run(['edit', 'edit-second'])
    const tools = entries.filter((entry) => entry.kind === 'tool')
    expect(tools[0]).toMatchObject({
      title: "Edit file 'made.txt'",
      toolKind: 'edit',
      status: 'completed',
      content: [
        {
          type: 'diff',
          path: '/work/app/made.txt',
          oldText: null,
          newText: 'made by probe\nline two',
        },
      ],
    })
    expect(tools[1]).toMatchObject({
      content: [
        {
          type: 'diff',
          path: '/work/app/made.txt',
          oldText: 'made by probe\nline two',
          newText: 'changed by probe\nline two',
        },
      ],
    })
  })

  it('shows a question as its own row, answered with what the user picked', () => {
    const { entries } = run(['ask'])
    const tool = entries.find((entry) => entry.kind === 'tool')
    expect(tool).toMatchObject({
      title: 'Which color?',
      question: 'Which color?',
      status: 'completed',
      content: [{ type: 'markdown', markdown: 'Blue' }],
    })
  })

  it("keeps a subagent's own events out of the thread, and shows what it returned", () => {
    const { entries, effects, dropped } = run(['sub'])
    const tool = entries.find((entry) => entry.kind === 'tool')
    expect(tool).toMatchObject({
      title: 'Start subagent',
      description: 'KP hello from sub',
      status: 'completed',
      content: [{ type: 'markdown', markdown: 'Hello from the fake model. **Bold** text.' }],
    })
    // Only the session's own reply after the call is a reply.
    expect(
      entries.filter((entry) => entry.kind === 'agent').map((entry) => entry.markdown),
    ).toEqual(['Done with sub.'])
    expect(dropped).toContain('usage')
    // The subagent's request is not one of the session's own.
    expect(effects.filter((effect) => effect.kind === 'request')).toHaveLength(2)
  })

  it("shows no row for Kettu's plan tool, which the host shows itself", () => {
    const { entries } = run(['mcp'])
    expect(entries.map((entry) => entry.kind)).toEqual(['agent'])
  })

  it('maps a turn of a real model: its reasoning, reads, a patch with context and its usage', () => {
    const { thread, entries, effects } = run(['real-edit'], { window: 400_000 })
    expect(entries.map((entry) => entry.kind)).toEqual([
      'thought',
      'agent',
      'tool',
      'tool',
      'tool',
      'agent',
    ])
    expect(entries[0]).toMatchObject({
      markdown: '**Planning commentary and path usage**',
      streaming: false,
    })
    const [read, patch] = entries.filter((entry) => entry.kind === 'tool')
    expect(read).toMatchObject({ title: "Read file 'notes.txt'", status: 'completed' })
    expect(patch).toMatchObject({
      title: "Edit file 'notes.txt'",
      status: 'completed',
      content: [
        {
          type: 'diff',
          path: '/work/app/notes.txt',
          oldText: 'alpha\nBETA-2\ngamma',
          newText: 'alpha\nBETA-2\nGAMMA-3',
        },
      ],
    })
    // The context is the last request's, the cost every request's.
    expect(thread.session.usage).toMatchObject({ used: 8287 + 30, size: 400_000 })
    expect(thread.session.usage?.cost?.amount).toBeCloseTo(0.021864, 6)
    const requests = effects.filter((effect) => effect.kind === 'request')
    expect(requests).toHaveLength(4)
    expect(requests[1]).toMatchObject({ cache: { read: 7424, written: 0 } })
  })

  it('shows a compaction of a real model as one divider, before the reply it made room for', () => {
    const { entries } = run(['real-compaction'])
    expect(entries.map((entry) => entry.kind)).toEqual(['compaction', 'agent'])
    expect(entries[0]).toMatchObject({ status: 'completed' })
    expect(entries[1]).toMatchObject({ markdown: 'AMBER-FALCON-17' })
  })

  it('shows a compaction as running until Cline says it is done', () => {
    // The request it makes room for waits on it, here for five seconds.
    const { entries } = run(['real-compaction'], { take: 2 })
    expect(entries).toMatchObject([{ kind: 'compaction', status: 'in_progress' }])
  })

  it('leaves a compaction the turn was stopped in as cancelled', () => {
    const { entries } = run(['real-compaction'], { take: 2, ended: true })
    expect(entries).toMatchObject([{ kind: 'compaction', status: 'cancelled' }])
  })

  it('says a compaction that folded nothing or broke off failed, and shows no budget notice', () => {
    // None of these was recorded: they are the recorded notice with the message and phase the
    // runtime's source gives them, and the error a failed request sends.
    const skipped = run(['real-compaction'], {
      take: 2,
      then: [compactionNotice('skipped', 'auto-compaction-skipped')],
    })
    expect(skipped.entries).toMatchObject([{ kind: 'compaction', status: 'failed' }])
    const adjusted = run(['real-compaction'], {
      take: 3,
      then: [
        {
          type: 'notice',
          noticeType: 'status',
          message: 'compaction-budget-adjusted',
          reason: 'compaction_budget_emergency',
          metadata: { kind: 'compaction_budget_emergency' },
        },
      ],
    })
    expect(adjusted.entries).toMatchObject([{ kind: 'compaction', status: 'completed' }])
    const broken = run(['real-compaction'], {
      take: 2,
      then: [
        { type: 'error', error: { message: 'fetch failed' }, recoverable: false, iteration: 1 },
      ],
      ended: true,
    })
    expect(broken.entries).toMatchObject([{ kind: 'compaction', status: 'failed' }])
  })

  it('keeps what streamed before a stop', () => {
    const { entries } = run(['slow'])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'agent', markdown: expect.stringMatching(/^tick 0 /) })
  })
})

describe('Cline tool facts', () => {
  it('reads an editor call as a new file, a replacement or an insertion', () => {
    expect(toolFacts('editor', { path: '/work/app/a.txt', new_text: 'x\n' }, CWD)).toMatchObject({
      title: "Write file 'a.txt'",
      content: [{ type: 'diff', path: '/work/app/a.txt', oldText: null, newText: 'x\n' }],
    })
    expect(
      toolFacts('editor', { path: '/work/app/a.txt', old_text: 'x', new_text: 'y' }, CWD),
    ).toMatchObject({
      title: "Edit file 'a.txt'",
      content: [{ type: 'diff', oldText: 'x', newText: 'y' }],
    })
    expect(
      toolFacts('editor', { path: '/elsewhere/a.txt', new_text: 'y', insert_line: 3 }, CWD),
    ).toMatchObject({
      title: "Edit file '/elsewhere/a.txt'",
      content: [{ type: 'diff', oldText: '', newText: 'y' }],
    })
  })

  it('titles the other tools by what they act on', () => {
    expect(toolFacts('search_codebase', { queries: ['foo', 'bar'] }, CWD).title).toBe(
      "Search for 'foo · bar'",
    )
    expect(
      toolFacts('fetch_web_content', { requests: [{ url: 'https://a.test', prompt: 'p' }] }, CWD),
    ).toMatchObject({ title: 'Open https://a.test', toolKind: 'fetch' })
    expect(
      toolFacts('run_commands', { commands: [{ command: 'git', args: ['status'] }, 'ls'] }, CWD)
        .rawInput,
    ).toBe('git status\nls')
    expect(toolFacts('github__create_issue', { title: 'x' }, CWD)).toMatchObject({
      title: 'github: create_issue',
      rawInput: '{\n  "title": "x"\n}',
    })
  })

  it('splits an MCP tool name at its first separator only', () => {
    expect(mcpTool('kettu__set_plan')).toEqual({ server: 'kettu', tool: 'set_plan' })
    expect(mcpTool('a__b__c')).toEqual({ server: 'a', tool: 'b__c' })
    expect(mcpTool('read_files')).toBeNull()
  })

  it('reads a patch of several files, leaving out a file it deletes', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/a.ts',
      '@@ function a',
      ' keep',
      '-old',
      '+new',
      '@@',
      '-gone',
      '*** Delete File: src/b.ts',
      '*** Add File: src/c.ts',
      '+fresh',
      '*** End Patch',
    ].join('\n')
    expect(patchFiles(patch, CWD)).toEqual([
      { path: '/work/app/src/a.ts', oldText: 'keep\nold', newText: 'keep\nnew' },
      { path: '/work/app/src/a.ts', oldText: 'gone', newText: '' },
      { path: '/work/app/src/c.ts', oldText: null, newText: 'fresh' },
    ])
  })

  it('reads what a tool returned as text', () => {
    expect(outputText([{ query: 'a', result: 'one', success: true }, { error: 'two' }])).toBe(
      'one\ntwo',
    )
    expect(outputText({ content: [{ type: 'text', text: 'from mcp' }] })).toBe('from mcp')
    expect(outputText('plain')).toBe('plain')
  })

  it("takes the cache out of a request's input, which Cline counts inside it", () => {
    expect(
      tokenTotals({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 5 }),
    ).toEqual({ total: 120, input: 35, output: 20, thought: null, cacheRead: 60, cacheWrite: 5 })
    // A provider of the user's own that counts the cache apart.
    expect(
      tokenTotals({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 5 }),
    ).toEqual({ total: 95, input: 10, output: 20, thought: null, cacheRead: 60, cacheWrite: 5 })
  })
})
