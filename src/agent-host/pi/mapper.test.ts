// What the Pi mapper makes of the events and stored entries of `pi --mode rpc`, as pi 1.5.2 and
// 0.81.0 sent them.

import { describe, expect, it } from 'vitest'
import {
  applyPatches,
  threadEntries,
  threadFromSnapshot,
  type Patch,
  type ThreadEntry,
  type ThreadState,
} from '@shared/thread'
import { newTurnScope, type MapperContext, type MapperEffect } from '../session-updates'
import abort from './fixtures/abort.json'
import stored from './fixtures/entries.json'
import old from './fixtures/old-081.json'
import failed from './fixtures/provider-error.json'
import reply from './fixtures/reply.json'
import skill from './fixtures/skill.json'
import steer from './fixtures/steer.json'
import thinking from './fixtures/thinking.json'
import tools from './fixtures/tools.json'
import {
  activeBranch,
  forkEntry,
  mcpTool,
  rewindEntry,
  SessionMapper,
  TIMESTAMP_REF_PREFIX,
  tokenTotals,
  toolFacts,
  typedText,
} from './mapper'
import type { PiEntry, PiEvent } from './protocol'

const CWD = '/work/app'

function fresh(): ThreadState {
  return threadFromSnapshot({
    session: {
      id: 's',
      agentId: 'pi',
      projectPath: CWD,
      acpSessionId: 'pi-1',
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
}

interface Run {
  thread: ThreadState
  entries: ThreadEntry[]
  effects: MapperEffect[]
  unknown: string[]
  patches: Patch[]
}

/** Maps events, or stored entries when `replaying`, each against the thread the ones before left. */
function run(
  records: readonly unknown[],
  options: { replaying?: boolean; before?: Record<string, string | null> } = {},
): Run {
  let thread = fresh()
  const mapper = new SessionMapper(CWD)
  mapper.setContextWindow(1_000_000)
  const scope = newTurnScope()
  const effects: MapperEffect[] = []
  const unknown: string[] = []
  const patches: Patch[] = []
  let n = 0
  records.forEach((record, seq) => {
    const ctx: MapperContext = {
      thread,
      replaying: options.replaying === true,
      cancelling: false,
      scope,
      now: 1_000 + seq * 10,
      nextId: () => `e:${++n}`,
      sessionIdFor: () => null,
    }
    const event = record as PiEvent & { toolCallId?: string }
    const out = options.replaying
      ? mapper.entry(record as PiEntry, ctx)
      : mapper.event(event, ctx, event.toolCallId ? options.before?.[event.toolCallId] : undefined)
    if (!out) unknown.push((record as { type: string }).type)
    else {
      patches.push(...out.patches)
      thread = applyPatches(thread, out.patches)
      effects.push(...out.effects)
    }
  })
  return { thread, entries: threadEntries(thread), effects, unknown, patches }
}

const rows = (entries: readonly ThreadEntry[]) =>
  entries.map((entry) =>
    entry.kind === 'tool'
      ? [entry.kind, entry.status, entry.title]
      : entry.kind === 'agent' || entry.kind === 'thought'
        ? [entry.kind, entry.markdown]
        : [entry.kind],
  )

describe('a reply', () => {
  it('streams into one message named after its time, and ends it', () => {
    const { entries, thread, effects } = run(reply)
    expect(entries).toEqual([
      {
        kind: 'agent',
        id: 'm:1795102903400-0',
        markdown: 'pong',
        attachments: [],
        streaming: false,
        at: expect.any(Number),
      },
    ])
    expect(thread.session.usage).toMatchObject({ used: 3216, size: 1_000_000 })
    expect(effects).toEqual([{ kind: 'request', cache: { read: 256, written: 0 } }])
  })

  it('is a message while it still streams', () => {
    const upTo = reply.findIndex(
      (event) => event.type === 'message_end' && event.message?.role === 'assistant',
    )
    const { entries } = run(reply.slice(0, upTo))
    expect(entries).toMatchObject([{ kind: 'agent', markdown: 'pong', streaming: true }])
  })

  it('keeps a thought apart from the text after it, and times it', () => {
    const { entries } = run(thinking)
    expect(entries).toMatchObject([
      {
        kind: 'thought',
        id: 'm:1795103333534-0',
        markdown: '**Preparing red image**',
        streaming: false,
      },
      { kind: 'agent', id: 'm:1795103333534-1', markdown: 'Red' },
    ])
    expect((entries[0] as { durationMs?: number }).durationMs).toBeGreaterThanOrEqual(0)
  })

  it('shows nothing of the prompt pi echoes, which the host already shows', () => {
    expect(rows(run(skill).entries)).toEqual([['agent', 'skill loaded']])
  })

  it('adds nothing for a reply the provider refused, which the turn reports', () => {
    const { entries, thread } = run(failed)
    expect(entries).toEqual([])
    expect(thread.session.usage).toBeNull()
  })

  it('goes on through a message sent into the run', () => {
    expect(rows(run(steer).entries)).toEqual([
      ['tool', 'completed', 'sleep 4'],
      ['agent', 'Otter'],
      ['agent', 'bye'],
    ])
  })
})

describe('tool calls', () => {
  const { entries, effects } = run(tools)

  it('show a read with its file and what it read', () => {
    expect(entries[0]).toMatchObject({
      kind: 'tool',
      id: 't:call_4528bbefcfa34bda82dd7521',
      status: 'completed',
      toolKind: 'read',
      title: "Read file 'notes.txt'",
      locations: [{ path: '/work/app/notes.txt' }],
      content: [{ type: 'markdown', markdown: '```\nhello from notes\nline two\nline three\n```' }],
    })
  })

  it("show an edit as the hunks of pi's own patch, at the line it changed first", () => {
    expect(entries[2]).toMatchObject({
      toolKind: 'edit',
      title: "Edit file 'notes.txt'",
      locations: [{ path: '/work/app/notes.txt', line: 2 }],
      content: [
        {
          type: 'diff',
          path: '/work/app/notes.txt',
          oldText: 'hello from notes\nline two\nline three',
          newText: 'hello from notes\nline 2\nline three',
        },
      ],
    })
  })

  it('show a write as a new file while nobody read what it replaced', () => {
    expect(entries[3]).toMatchObject({
      toolKind: 'edit',
      title: "Write file 'out.txt'",
      content: [
        { type: 'diff', path: '/work/app/out.txt', oldText: null, newText: 'made by pi\n' },
      ],
    })
  })

  it('show a write against the text its file held before', () => {
    const call = 'call_96ddf24f0313431db56cca5b'
    const withBefore = run(tools, { before: { [call]: 'older\n' } }).entries[3]
    expect(withBefore).toMatchObject({
      content: [{ type: 'diff', oldText: 'older\n', newText: 'made by pi\n' }],
    })
    // What a late read finds is what the call wrote, which says nothing of the file before.
    const sameAsWritten = run(tools, { before: { [call]: 'made by pi\n' } }).entries[3]
    expect(sameAsWritten).toMatchObject({ content: [{ type: 'diff', oldText: null }] })
  })

  it('show a command with its output fenced', () => {
    expect(entries[4]).toMatchObject({
      toolKind: 'execute',
      title: 'wc -l notes.txt',
      rawInput: 'wc -l notes.txt',
      content: [{ type: 'markdown', markdown: '```\n       3 notes.txt\n```' }],
    })
  })

  it('report each call once as started and once as ended', () => {
    const phases = effects.flatMap((effect) => (effect.kind === 'tool' ? [effect.phase] : []))
    expect(phases).toEqual(Array.from({ length: 4 }, () => ['started', 'ended']).flat())
  })

  it('fail a command the user stopped', () => {
    expect(run(abort).entries).toMatchObject([
      {
        kind: 'tool',
        status: 'failed',
        title: 'sleep 30',
        content: [{ type: 'markdown', markdown: 'Command aborted' }],
      },
    ])
  })

  it('read the call a block starts from the message so far, as pi 0.81.0 names it', () => {
    expect(rows(run(old).entries)).toEqual([
      ['tool', 'completed', "Read file 'notes.txt'"],
      ['thought', 'Now edit.'],
      ['tool', 'completed', "Edit file 'notes.txt'"],
      ['tool', 'completed', 'wc -l notes.txt'],
      ['agent', 'Done. `notes.txt` now reads "hallo from notes" and has 2 lines.'],
    ])
  })
})

describe('what a call shows before its result', () => {
  it("titles pi's own tools, with the file each names", () => {
    expect(toolFacts('read', { path: 'src/a.ts', offset: 40 }, CWD)).toMatchObject({
      toolKind: 'read',
      locations: [{ path: '/work/app/src/a.ts', line: 40 }],
    })
    expect(toolFacts('edit', { path: '/abs/b.ts', oldText: 'a', newText: 'b' }, CWD)).toMatchObject(
      {
        toolKind: 'edit',
        content: [{ type: 'diff', path: '/abs/b.ts', oldText: 'a', newText: 'b' }],
      },
    )
    expect(
      toolFacts('edit', { path: 'b.ts', edits: '[{"oldText":"x","newText":"y"}]' }, CWD).content,
    ).toEqual([{ type: 'diff', path: '/work/app/b.ts', oldText: 'x', newText: 'y' }])
    expect(toolFacts('bash', { command: 'ls\r\n-la' }, CWD)).toMatchObject({
      toolKind: 'execute',
      title: 'ls\n-la',
      rawInput: 'ls\n-la',
    })
    expect(toolFacts('grep', { pattern: 'TODO', path: 'src' }, CWD).toolKind).toBe('search')
    expect(toolFacts('codemode', { code: 'text(1)' }, CWD)).toMatchObject({
      toolKind: 'execute',
      rawInput: 'text(1)',
    })
  })

  it('names an MCP tool by its server and tool, and any other tool by its name', () => {
    expect(mcpTool('mcp__kettu__read_artifact')).toEqual({ server: 'kettu', tool: 'read_artifact' })
    expect(mcpTool('mcp__my_server__do__it')).toEqual({ server: 'my_server', tool: 'do__it' })
    expect(mcpTool('bash')).toBeNull()
    expect(toolFacts('mcp__kettu__read_artifact', { id: 'a1' }, CWD)).toMatchObject({
      title: 'kettu: read_artifact',
      toolKind: 'other',
    })
    expect(toolFacts('ask_question', {}, CWD)).toMatchObject({ title: 'ask_question', content: [] })
  })
})

describe("Kettu's own tools", () => {
  const call = (id: string, name: string, isError = false): unknown[] => [
    { type: 'tool_execution_start', toolCallId: id, toolName: name, args: { title: 't' } },
    {
      type: 'tool_execution_end',
      toolCallId: id,
      toolName: name,
      result: { content: [{ type: 'text', text: isError ? 'no such entry' : 'saved' }] },
      isError,
    },
  ]

  it('show no row for the plan and memory writes, unless a write fails', () => {
    const { entries } = run([
      ...call('c1', 'mcp__kettu__set_plan'),
      ...call('c2', 'mcp__kettu__remember'),
      ...call('c3', 'mcp__kettu__update_memory', true),
      ...call('c4', 'mcp__kettu__read_memory'),
    ])
    expect(rows(entries)).toEqual([
      ['tool', 'failed', 'kettu: update_memory'],
      ['tool', 'completed', 'kettu: read_memory'],
    ])
  })
})

describe('a running command', () => {
  it('shows its output as it grows, not more often than the thread can take', () => {
    const update = (text: string) => ({
      type: 'tool_execution_update',
      toolCallId: 'c1',
      toolName: 'bash',
      partialResult: { content: [{ type: 'text', text }] },
    })
    const start = {
      type: 'tool_execution_start',
      toolCallId: 'c1',
      toolName: 'bash',
      args: { command: 'make' },
    }
    // Events are 10 ms apart here: the first update shows, and the next 150 ms after it.
    const some = run([start, ...Array.from({ length: 15 }, (_, i) => update(`line ${i}`))])
    expect(some.entries[0]).toMatchObject({
      status: 'in_progress',
      content: [{ type: 'markdown', markdown: '```\nline 0\n```' }],
    })
    const more = run([start, ...Array.from({ length: 16 }, (_, i) => update(`line ${i}`))])
    expect(more.entries[0]).toMatchObject({
      content: [{ type: 'markdown', markdown: '```\nline 15\n```' }],
    })

    // 输出按前缀递增时仅发 entry.appendOutput 增量；发生覆盖回写时自动回退 entry.update
    const filler = Array.from({ length: 14 }, () => update('a\n'))
    const growing = run([start, update('a\n'), ...filler, update('a\nb\n')])
    expect(growing.patches.filter((p) => p.op === 'entry.appendOutput')).toEqual([
      { op: 'entry.appendOutput', id: 't:c1', text: 'a\n' },
      { op: 'entry.appendOutput', id: 't:c1', text: 'b\n' },
    ])
    expect(growing.entries[0]).toMatchObject({
      content: [{ type: 'markdown', markdown: '```\na\nb\n```' }],
    })
  })
})

describe('other events', () => {
  it('draw a compaction as a divider with its summary, or with why it failed', () => {
    const done = run([
      { type: 'compaction_start', reason: 'manual' },
      { type: 'compaction_end', reason: 'manual', result: { summary: 'So far: A, B.' } },
    ])
    expect(done.entries).toMatchObject([
      { kind: 'compaction', status: 'completed', summary: 'So far: A, B.' },
    ])
    const none = run([
      { type: 'compaction_start', reason: 'manual' },
      { type: 'compaction_end', aborted: false, errorMessage: 'Nothing to compact' },
    ])
    expect(none.entries).toMatchObject([
      { kind: 'compaction', status: 'failed', summary: 'Nothing to compact' },
    ])
    const stopped = run([{ type: 'compaction_start' }, { type: 'compaction_end', aborted: true }])
    expect(stopped.entries).toMatchObject([{ kind: 'compaction', status: 'cancelled' }])
  })

  it('show a retry, an extension notification and a new session name', () => {
    const { entries, effects, thread } = run([
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: '529' },
      {
        type: 'extension_ui_request',
        id: 'n1',
        method: 'notify',
        message: 'MCP servers need attention:\n  docs: failed',
        notifyType: 'warning',
      },
      { type: 'session_info_changed', name: 'Refactor auth' },
    ])
    expect(entries).toMatchObject([
      { kind: 'notice', severity: 'warning', description: '529' },
      {
        kind: 'notice',
        severity: 'warning',
        title: 'MCP servers need attention:',
        description: 'docs: failed',
      },
    ])
    expect(thread.session.title).toBe('Refactor auth')
    expect(effects).toEqual([{ kind: 'title', title: 'Refactor auth' }])
  })

  it("leave what belongs to the run or to pi's terminal UI to the connection", () => {
    const { unknown } = run([
      { type: 'agent_start' },
      { type: 'queue_update', steering: [], followUp: [] },
      {
        type: 'extension_ui_request',
        id: 's1',
        method: 'setStatus',
        statusKey: 'k',
        statusText: 'v',
      },
      { type: 'something_new' },
    ])
    expect(unknown).toEqual([
      'agent_start',
      'queue_update',
      'extension_ui_request',
      'something_new',
    ])
  })
})

describe('the usage', () => {
  it("keeps a reply's cached input out of its input, as Kettu's totals do", () => {
    expect(
      tokenTotals({
        input: 100,
        output: 20,
        cacheRead: 3000,
        cacheWrite: 50,
        reasoning: 5,
        totalTokens: 3170,
      }),
    ).toEqual({ total: 3170, input: 100, output: 20, thought: 5, cacheRead: 3000, cacheWrite: 50 })
    expect(
      tokenTotals({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }),
    ).toBeNull()
  })

  it("sums a reply's total from its parts when the provider reported none", () => {
    expect(
      tokenTotals({ input: 100, output: 20, cacheRead: 3000, cacheWrite: 50, totalTokens: 0 }),
    ).toEqual({
      total: 3170,
      input: 100,
      output: 20,
      thought: null,
      cacheRead: 3000,
      cacheWrite: 50,
    })
  })

  it("takes pi's own count of the context and the session's cost once a turn settled", () => {
    let thread = fresh()
    const mapper = new SessionMapper(CWD)
    const ctx = (): MapperContext => ({
      thread,
      replaying: false,
      cancelling: false,
      scope: newTurnScope(),
      now: 1,
      nextId: () => 'e:1',
      sessionIdFor: () => null,
    })
    const out = mapper.stats(
      { cost: 0.0123, contextUsage: { tokens: 6291, contextWindow: 512_000, percent: 1.2 } },
      ctx(),
    )
    thread = applyPatches(thread, out!.patches)
    expect(thread.session.usage).toEqual({
      used: 6291,
      size: 512_000,
      cost: { amount: 0.0123, currency: 'USD' },
      tokens: null,
    })
    // Right after a compaction pi has no count yet, and the last one stays.
    const after = mapper.stats(
      { contextUsage: { tokens: null, contextWindow: 512_000, percent: null } },
      ctx(),
    )
    expect(applyPatches(thread, after!.patches).session.usage).toMatchObject({ used: 6291 })
    expect(mapper.stats({}, ctx())).toBeNull()
  })
})

describe('a replay of stored entries', () => {
  const branch = activeBranch(stored.entries as PiEntry[], stored.leafId)
  const { entries, effects } = run(branch, { replaying: true })

  it('shows the prompts, replies and calls of the active branch, in order', () => {
    expect(rows(entries)).toEqual([
      ['user'],
      ['agent', 'pong'],
      ['user'],
      ['tool', 'completed', "Read file 'notes.txt'"],
      ['agent', 'The second line is: `line two`'],
      ['user'],
      ['tool', 'completed', "Edit file 'notes.txt'"],
      ['tool', 'completed', "Write file 'out.txt'"],
      ['tool', 'completed', 'wc -l notes.txt'],
      ['agent', expect.stringContaining('Done:')],
    ])
    expect(entries[0]).toMatchObject({
      content: [{ type: 'text', text: 'Reply with exactly: pong' }],
      agentRef: 'd1fed4b3',
    })
  })

  it('names replies as the live turn did, and marks none as streaming or as a request', () => {
    expect(entries[1]).toEqual({
      kind: 'agent',
      id: 'm:1795102903400-0',
      markdown: 'pong',
      attachments: [],
      streaming: false,
    })
    expect(effects.some((effect) => effect.kind === 'request')).toBe(false)
  })

  it('keeps an edit as its patch and a result as its call', () => {
    expect(entries[6]).toMatchObject({
      locations: [{ path: '/work/app/notes.txt', line: 2 }],
      content: [{ type: 'diff', oldText: 'hello from notes\nline two\nline three' }],
    })
  })

  it('leaves out a branch the user left', () => {
    const tree: PiEntry[] = [
      { type: 'message', id: 'a', parentId: null, message: { role: 'user', content: 'one' } },
      { type: 'message', id: 'b', parentId: 'a', message: { role: 'user', content: 'left' } },
      { type: 'message', id: 'c', parentId: 'a', message: { role: 'user', content: 'taken' } },
    ]
    expect(activeBranch(tree, 'c').map((entry) => entry.id)).toEqual(['a', 'c'])
    expect(activeBranch(tree, null)).toEqual([])
    expect(activeBranch(tree, 'gone')).toEqual([])
  })

  it('shows a prompt as it was typed: without what Kettu sent ahead, a skill as its command', () => {
    const prompt = (text: string): PiEntry => ({
      type: 'message',
      id: 'u',
      parentId: null,
      message: { role: 'user', content: [{ type: 'text', text }] },
    })
    const ahead =
      '<kettu-guide>\nUse Kettu.\n</kettu-guide>\n\n<kettu-memory>\nNone.\n</kettu-memory>\n\nFix it'
    expect(run([prompt(ahead)], { replaying: true }).entries).toMatchObject([
      { kind: 'user', content: [{ type: 'text', text: 'Fix it' }] },
    ])
    const expanded = (skill[2] as { message: { content: { text: string }[] } }).message.content[0]!
      .text
    expect(typedText(expanded)).toBe('/skill:find-skills just say "skill loaded" and nothing else')
    expect(typedText('<skill name="x" location="/s/x/SKILL.md">\nBody\n</skill>')).toBe('/skill:x')
    expect(typedText('plain <skill> text')).toBe('plain <skill> text')
  })

  it('brings back an image and a file a prompt carried', () => {
    const { entries, effects } = run(
      [
        {
          type: 'message',
          id: 'u',
          parentId: null,
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'Look at [@a.ts](file:///work/app/a.ts)\nand this' },
              { type: 'image', data: 'AAAA', mimeType: 'image/png' },
            ],
          },
        },
      ],
      { replaying: true },
    )
    const content = (
      entries[0] as { content: { type: string; ref?: { attachment: { type: string } } }[] }
    ).content
    expect(
      content.map((part) => (part.type === 'ref' ? part.ref!.attachment.type : 'text')),
    ).toEqual(['text', 'file', 'text', 'image'])
    expect(effects).toMatchObject([{ kind: 'replayImage', mimeType: 'image/png', data: 'AAAA' }])
  })

  it('shows a compaction, a command the user ran and a new session name', () => {
    const { entries, effects } = run(
      [
        {
          type: 'compaction',
          id: 'k',
          parentId: null,
          summary: 'Earlier: A.',
          firstKeptEntryId: 'x',
        },
        {
          type: 'message',
          id: 'b',
          parentId: 'k',
          message: { role: 'bashExecution', command: 'ls', output: 'a\nb', exitCode: 0 },
        },
        { type: 'session_info', id: 'n', parentId: 'b', name: 'Named' },
        { type: 'model_change', id: 'm', parentId: 'n' },
      ],
      { replaying: true },
    )
    expect(entries).toMatchObject([
      { kind: 'compaction', status: 'completed', summary: 'Earlier: A.' },
      { kind: 'tool', toolKind: 'execute', title: 'ls', status: 'completed' },
    ])
    expect(effects).toEqual([{ kind: 'title', title: 'Named' }])
  })
})

describe('where a fork that ends at a reply starts', () => {
  const branch = activeBranch(stored.entries as PiEntry[], stored.leafId)
  const user = (text: string) =>
    branch.find(
      (entry) =>
        entry.message?.role === 'user' && JSON.stringify(entry.message.content).includes(text),
    )!

  it('is the prompt after the reply, found by the time its entry is named after', () => {
    const point = { messageId: '1795102903400-0', text: 'pong', occurrence: 1 }
    expect(forkEntry(branch, point)).toEqual({ found: true, entryId: user('Read notes.txt').id })
  })

  it('is found by the text, the nth with it, when the entry was named otherwise', () => {
    const point = { messageId: 'e:12', text: 'The second line is: `line two`', occurrence: 1 }
    expect(forkEntry(branch, point)).toEqual({ found: true, entryId: user('Use the edit tool').id })
    expect(forkEntry(branch, { ...point, occurrence: 2 })).toEqual({ found: false, entryId: null })
  })

  it('is nowhere after the last reply, so the fork takes the whole branch', () => {
    const last = branch.at(-1)!
    const point = { messageId: `${last.message!.timestamp}-0`, text: 'x', occurrence: 1 }
    expect(forkEntry(branch, point)).toEqual({ found: true, entryId: null })
  })
})

describe('where an edit from a message cuts', () => {
  const branch = activeBranch(stored.entries as PiEntry[], stored.leafId)
  const users = branch.filter((entry) => entry.type === 'message' && entry.message?.role === 'user')

  it('matches by replayed entry id and live timestamp reference', () => {
    const second = users[1]!
    expect(rewindEntry(branch, { ref: second.id, text: 'unrelated', occurrence: 1 })).toEqual({
      entry: second,
      hasPriorHistory: true,
    })
    expect(
      rewindEntry(branch, {
        ref: `${TIMESTAMP_REF_PREFIX}${second.message!.timestamp}`,
        text: 'unrelated',
        occurrence: 1,
      }),
    ).toEqual({ entry: second, hasPriorHistory: true })
  })

  it('marks the first user message as having no prior conversation even after metadata entries', () => {
    const first = users[0]!
    expect(rewindEntry(branch, { ref: first.id, text: '', occurrence: 1 })).toEqual({
      entry: first,
      hasPriorHistory: false,
    })
  })

  it('falls back to matching prompt text and occurrence, including wrapped guide and skill prompts', () => {
    const wrapped: PiEntry[] = [
      {
        type: 'message',
        id: 'u1',
        parentId: null,
        message: {
          role: 'user',
          content: [{ type: 'text', text: '<kettu-guide>\nGuide\n</kettu-guide>\n\ncheck src' }],
        },
      },
      {
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      },
      {
        type: 'message',
        id: 'u2',
        parentId: 'a1',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<skill name="lint" location="/s/lint/SKILL.md">\nBody\n</skill>\n\ncheck src',
            },
          ],
        },
      },
    ]
    expect(rewindEntry(wrapped, { ref: null, text: 'check src', occurrence: 1 })).toEqual({
      entry: wrapped[0],
      hasPriorHistory: false,
    })
    expect(rewindEntry(wrapped, { ref: null, text: 'check src', occurrence: 2 })).toEqual({
      entry: wrapped[2],
      hasPriorHistory: true,
    })
    expect(
      rewindEntry(wrapped, { ref: null, text: '/skill:lint check src', occurrence: 1 }),
    ).toEqual({
      entry: wrapped[2],
      hasPriorHistory: true,
    })
    expect(rewindEntry(wrapped, { ref: null, text: 'missing', occurrence: 1 })).toBeNull()
  })

  it('ignores abandoned branches outside the active branch', () => {
    const tree: PiEntry[] = [
      { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'first' } },
      {
        type: 'message',
        id: 'abandoned',
        parentId: 'u1',
        message: { role: 'user', content: 'old' },
      },
      { type: 'message', id: 'kept', parentId: 'u1', message: { role: 'user', content: 'new' } },
    ]
    const active = activeBranch(tree, 'kept')
    expect(rewindEntry(active, { ref: 'abandoned', text: 'old', occurrence: 1 })).toBeNull()
    expect(rewindEntry(active, { ref: 'kept', text: 'new', occurrence: 1 })).toEqual({
      entry: tree[2],
      hasPriorHistory: true,
    })
  })
})
