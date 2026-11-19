// What the OpenCode mapper makes of its server's events and stored messages, as OpenCode 2.3.2
// sent them.

import { describe, expect, it } from 'vitest'
import { SessionMapper, assistantMessageId, textEntryId, tokenTotals, toolFacts } from './mapper'
import { sessionOf, type ServerEvent } from './protocol'
import { CWD, TestThread, recorded, rootOf, storedMessages } from './testing'

/** Plays a recorded stream into one thread for each of its sessions, as a connection routes it. */
function play(events: readonly ServerEvent[], threads = new Map<string, TestThread>()) {
  const mappers = new Map<string, SessionMapper>()
  const unknown = new Set<string>()
  for (const event of events) {
    const id = sessionOf(event)!
    if (!threads.has(id)) threads.set(id, new TestThread(id))
    if (!mappers.has(id)) mappers.set(id, new SessionMapper(CWD))
    const thread = threads.get(id)!
    const out = mappers.get(id)!.event(event, thread.context())
    if (out) thread.apply(out)
    else unknown.add(event.type)
  }
  const root = rootOf(events)
  return { root: threads.get(root)!, mapper: mappers.get(root)!, threads, unknown }
}

describe('a turn', () => {
  const { root, unknown } = play(recorded('turn'))

  it('shows the call, the thought and the reply, each in its last state', () => {
    expect(root.lines).toEqual([
      "tool completed read Read file 'note.txt'",
      expect.stringMatching(/^thought The file says "hello from kettu"/),
      expect.stringMatching(/^agent 我快速想了一下/),
    ])
    const thought = root.entries[1]!
    expect(thought.kind === 'thought' && thought.durationMs).toEqual(expect.any(Number))
  })

  it('keeps the file the call read and what it returned', () => {
    const read = root.tool('call_b1271038e80c470ba66b1bc9')!
    expect(read.locations).toEqual([{ path: '/work/app/note.txt' }])
    expect(read.content).toEqual([
      {
        type: 'markdown',
        markdown: 'Read file /work/app/note.txt, lines 1-1\n1: hello from kettu',
      },
    ])
  })

  it('takes the title OpenCode gave the session', () => {
    expect(root.state.session.title).toBe('Summary of note.txt')
    expect(root.effects).toContainEqual({ kind: 'title', title: 'Summary of note.txt' })
  })

  it('counts each request once, with the context its last one left', () => {
    expect(root.effects.filter((effect) => effect.kind === 'request')).toEqual([
      { kind: 'request', cache: { read: 256, written: 0 } },
      { kind: 'request', cache: { read: 12672, written: 0 } },
    ])
    expect(root.state.session.usage).toMatchObject({
      used: 119 + 47 + 38 + 12672,
      cost: { amount: 0, currency: 'USD' },
    })
    expect(root.state.session.lastRequest).toMatchObject({
      input: 119,
      cacheRead: 12672,
      output: 47 + 38,
    })
  })

  it('reads the events that only the connection acts on as none of its own', () => {
    expect([...unknown].sort()).toEqual([
      'session.created',
      'session.execution.succeeded',
      'session.inbox.delivered',
      'session.inbox.enqueued',
      'session.reasoning.started',
      'session.text.started',
      'session.tool.input.ended',
    ])
  })
})

describe('tool calls', () => {
  it('shows a written file whole and an edit as what its patch changed', () => {
    const { root } = play(recorded('tools'))
    expect(root.lines.filter((line) => line.startsWith('tool'))).toEqual([
      "tool completed edit Write file 'fruit.txt'",
      "tool completed edit Edit file 'fruit.txt'",
      "tool completed search Search for 'PEAR' in /work/app",
      "tool completed search Search for '*.txt' in /work/app",
    ])
    expect(root.tool('call_1e9ba878d4c4441ab89a7220')!.content).toEqual([
      { type: 'diff', path: '/work/app/fruit.txt', oldText: null, newText: 'apple\npear\nkiwi\n' },
    ])
    expect(root.tool('call_8aaec086bfb74b5fbd9ad132')!.content).toEqual([
      {
        type: 'diff',
        path: '/work/app/fruit.txt',
        oldText: 'apple\npear\nkiwi',
        newText: 'apple\nPEAR\nkiwi',
      },
    ])
  })

  it('shows a call as waiting from the moment the model names it', () => {
    const events = recorded('tools')
    const named = events.findIndex((event) => event.type === 'session.tool.input.started')
    const { root } = play([events[0]!, events[named]!])
    expect(root.lines).toEqual(['tool pending edit Edit file'])
  })

  it('titles each kind of call by what it does', () => {
    expect(toolFacts('shell', { command: 'ls -la', description: 'List files' }, CWD)).toMatchObject(
      {
        title: 'ls -la',
        toolKind: 'execute',
        rawInput: 'ls -la',
        description: 'List files',
      },
    )
    expect(toolFacts('read', { path: '/elsewhere/a.txt' }, CWD)).toMatchObject({
      title: "Read file '/elsewhere/a.txt'",
      locations: [{ path: '/elsewhere/a.txt' }],
    })
    expect(toolFacts('webfetch', { url: 'https://example.com' }, CWD).toolKind).toBe('fetch')
    expect(toolFacts('websearch', { query: 'kettu' }, CWD).title).toBe('Web search: kettu')
    expect(toolFacts('question', { questions: [{ question: 'Which?' }] }, CWD)).toMatchObject({
      title: 'Which?',
      question: 'Which?',
    })
    expect(toolFacts('some_tool', { a: 1 }, CWD)).toMatchObject({
      title: 'some_tool',
      toolKind: 'other',
      rawInput: '{\n  "a": 1\n}',
    })
  })

  it('shows a refused call as failed, with what the user said', () => {
    const { root } = play(recorded('reject'))
    const call = root.tool('call_2136d7b780fd4a2f82f130a3')!
    expect(call).toMatchObject({ status: 'failed', title: 'ls -la', toolKind: 'execute' })
    expect(call.content).toEqual([{ type: 'markdown', markdown: 'Not now, thanks' }])
  })

  it('shows a call the user stopped as cancelled', () => {
    const events = recorded('interrupt')
    const thread = new TestThread()
    const mapper = new SessionMapper(CWD)
    for (const event of events) {
      // The user presses Stop while the command runs.
      if (event.type === 'session.tool.failed') thread.cancelling = true
      const out = mapper.event(event, thread.context())
      if (out) thread.apply(out)
    }
    expect(thread.tool('call_7b746b9b9a2a46c1996ec4e6')!.status).toBe('cancelled')
    expect(thread.effects.filter((effect) => effect.kind === 'request')).toEqual([])
  })

  it('keeps the question a call asks, and ends it with the answer', () => {
    const { root } = play(recorded('question'))
    expect(root.tool('call_90c9742ed55449c28df3d7f9')).toMatchObject({
      status: 'completed',
      title: 'Which color do you prefer?',
      question: 'Which color do you prefer?',
    })
  })
})

describe('Code Mode scripts', () => {
  const call = (code: string, metadata: Record<string, unknown>): ServerEvent[] => [
    {
      type: 'session.tool.input.started',
      data: { sessionID: 's', assistantMessageID: 'msg_1', id: 'call_1', name: 'execute' },
    },
    {
      type: 'session.tool.called',
      data: { sessionID: 's', assistantMessageID: 'msg_1', id: 'call_1', input: { code } },
    },
    {
      type: 'session.tool.success',
      data: {
        sessionID: 's',
        assistantMessageID: 'msg_1',
        id: 'call_1',
        content: [{ type: 'text', text: 'ok' }],
        metadata,
      },
    },
  ]

  it('titles a script by the tools it calls', () => {
    const { root } = play(recorded('script'))
    expect(root.tool('call_2ece41c9dff7486a9fd492fa')).toMatchObject({
      status: 'completed',
      title: 'kettuprobe.probe_echo',
      toolKind: 'other',
      rawInput: 'const r = await tools.kettuprobe.probe_echo({ text: "hello-mcp" });\nreturn r;',
    })
  })

  it('shows no row for a script that only sets the plan, which the thread shows itself', () => {
    const { root } = play(
      call('return await tools.kettu.set_plan({ steps: [] })', {
        toolCalls: [{ tool: 'kettu.set_plan', status: 'completed' }],
      }),
    )
    expect(root.lines).toEqual([])
  })

  it('shows a script that threw as failed', () => {
    const { root } = play(
      call('return await tools.kettu.create_artifact({})', { error: true, toolCalls: [] }),
    )
    expect(root.lines).toEqual(['tool failed other kettu.create_artifact'])
  })

  it('shows the row of a held script once it asks for permission', () => {
    const [named, called] = call('return await tools.kettu.set_plan({ steps: [] })', {})
    const { root, mapper } = play([named!, called!])
    expect(root.lines).toEqual([])
    const asked = mapper.asked(
      {
        id: 'per_1',
        sessionID: 's',
        action: 'execute',
        resources: ['*'],
        source: { type: 'tool', messageID: 'msg_1', id: 'call_1' },
      },
      root.context(),
    )
    root.apply(asked.output)
    expect(asked.callId).toBe('call_1')
    expect(root.lines).toEqual(['tool in_progress other kettu.set_plan'])
  })
})

describe('requests without a call', () => {
  it('gives a permission request a row of its own, ended by its answer', () => {
    const thread = new TestThread()
    const mapper = new SessionMapper(CWD)
    const request = {
      id: 'per_9',
      sessionID: 's',
      action: 'external_directory',
      resources: ['/elsewhere/*'],
    }
    const { callId, output } = mapper.asked(request, thread.context())
    thread.apply(output)
    expect(callId).toBe('per_9')
    expect(thread.lines).toEqual(['tool in_progress other external_directory: /elsewhere/*'])
    thread.apply(mapper.settle(callId, false, thread.context()))
    expect(thread.lines).toEqual(['tool failed other external_directory: /elsewhere/*'])
  })
})

describe('a subagent', () => {
  const { root, threads } = play(recorded('subagent'))

  it('shows no call in its parent, which shows it as a session', () => {
    expect(root.lines.filter((line) => line.startsWith('tool'))).toEqual([])
    expect(root.lines.filter((line) => line.startsWith('agent'))).toHaveLength(3)
  })

  it('keeps its own work in its own thread', () => {
    const child = [...threads.values()].find((thread) => thread !== root)!
    expect(child.lines.filter((line) => line.startsWith('tool'))).toEqual([
      "tool completed read Read file 'note.txt'",
      'tool completed execute od -c /work/app/note.txt && ls -l /work/app/note.txt',
    ])
  })
})

describe('a compaction', () => {
  it('stays in the thread with the summary it streamed', () => {
    const events = recorded('compact')
    const started = events.findIndex((event) => event.type === 'session.compaction.started')
    const partial = play(events.slice(0, started + 3))
    expect(partial.root.lines).toEqual(['compaction in_progress'])
    const { root } = play(events)
    const entry = root.entries[0]!
    expect(entry).toMatchObject({
      kind: 'compaction',
      id: 'c:msg_1f483001a001ZzbB2IITzjrpL9',
      status: 'completed',
    })
    expect(entry.kind === 'compaction' && entry.summary).toMatch(/^## Objective/)
  })
})

describe('stored messages', () => {
  const list = (thread: TestThread, mapper: SessionMapper, own = false): void => {
    for (const message of storedMessages('tools')) {
      thread.apply(mapper.message(message, thread.context(), own))
    }
  }

  it('lists a history Kettu does not have, without times or live states', () => {
    const thread = new TestThread()
    thread.replaying = true
    list(thread, new SessionMapper(CWD))
    expect(thread.lines).toEqual([
      expect.stringMatching(/^user Do exactly this with your file tools/),
      "agent I'll do these in order.",
      "tool completed edit Write file 'veg.txt'",
      "tool completed edit Edit file 'veg.txt'",
      'tool completed execute echo acp-shell',
      "tool completed search Search for 'KALE' in /work/app",
      expect.stringMatching(/^agent /),
    ])
    expect(thread.entries.every((entry) => !('at' in entry))).toBe(true)
    expect(thread.effects.filter((effect) => effect.kind !== 'tool')).toEqual([])
  })

  it('changes nothing in a thread that already has them', () => {
    const thread = new TestThread()
    const mapper = new SessionMapper(CWD)
    list(thread, mapper)
    const before = thread.state
    list(thread, mapper)
    expect(thread.state).toBe(before)
  })

  it('brings a thread the stream left behind up to what the messages hold', () => {
    const thread = new TestThread()
    const mapper = new SessionMapper(CWD)
    const [, first] = storedMessages('tools')
    const part = first!.type === 'assistant' ? first.content[1]! : null
    const callId = part?.type === 'tool' ? part.id : ''
    for (const event of [
      {
        type: 'session.text.delta',
        data: { assistantMessageID: first!.id, ordinal: 0, delta: "I'll" },
      },
      { type: 'session.tool.input.started', data: { id: callId, name: 'write' } },
    ]) {
      thread.apply(mapper.event(event, thread.context())!)
    }
    expect(thread.lines).toEqual(["agent streaming I'll", 'tool pending edit Edit file'])
    list(thread, mapper, true)
    expect(thread.lines.slice(0, 2)).toEqual([
      "agent I'll do these in order.",
      "tool completed edit Write file 'veg.txt'",
    ])
    expect(thread.lines.some((line) => line.startsWith('user'))).toBe(false)
  })

  it('lists a compaction with its summary', () => {
    const thread = new TestThread()
    const mapper = new SessionMapper(CWD)
    for (const message of storedMessages('compact')) {
      thread.apply(mapper.message(message, thread.context()))
    }
    expect(thread.lines.filter((line) => line.startsWith('compaction'))).toEqual([
      'compaction completed',
    ])
  })
})

describe('a request', () => {
  const step = (thread: TestThread, mapper: SessionMapper, events: ServerEvent[]): void => {
    for (const event of events) {
      const out = mapper.event(event, thread.context())
      if (out) thread.apply(out)
    }
  }
  const model = { id: 'deepseek-flash', providerID: 'deepseek' }
  const tokens = { input: 10, output: 400, reasoning: 0, cache: { read: 0, write: 0 } }

  it('is timed from when it went out, which its start event says after the fact', () => {
    const mapper = new SessionMapper(CWD)
    const timed = new TestThread()
    timed.now = 10_000
    step(timed, mapper, [
      // The start comes with the first token, 4 s after the request went out.
      {
        type: 'session.step.started',
        data: { assistantMessageID: 'msg_1', model, started: 6_000 },
      },
      { type: 'session.step.first-token', data: { assistantMessageID: 'msg_1' } },
    ])
    timed.now = 12_000
    step(timed, mapper, [
      { type: 'session.step.ended', data: { assistantMessageID: 'msg_1', tokens } },
    ])
    expect(timed.state.session.lastRequest).toMatchObject({ at: 6_000, ms: 6_000, output: 400 })
    expect(timed.state.session.speed?.last).toMatchObject({ tokens: 400, approx: false })
    expect(timed.state.session.speed!.last.firstTokenMs).toBeGreaterThanOrEqual(4_000)
  })

  it('names the model a subagent runs on in its own session', () => {
    const thread = new TestThread()
    thread.state = {
      ...thread.state,
      session: {
        ...thread.state.session,
        subagent: { description: null, canCancel: true, stateKnown: true, stopReason: null },
      },
    }
    step(thread, new SessionMapper(CWD), [
      { type: 'session.step.started', data: { assistantMessageID: 'msg_1', model } },
    ])
    expect(thread.state.session.subagent?.model).toBe('deepseek/deepseek-flash')
  })
})

describe('a command’s own answer', () => {
  it('reads as a reply of the agent’s, whole and timed', () => {
    const thread = new TestThread()
    thread.apply(new SessionMapper(CWD).say(thread.context(), 'No goal is set.'))
    expect(thread.entries).toEqual([
      {
        kind: 'agent',
        id: 'e:1',
        markdown: 'No goal is set.',
        attachments: [],
        streaming: false,
        at: 1_000,
      },
    ])
  })
})

describe('ids and counts', () => {
  it('gives the replies of one assistant message entries of their own', () => {
    expect(textEntryId('msg_1', 0)).toBe('m:msg_1')
    expect(textEntryId('msg_1', 2)).toBe('m:msg_1.2')
    expect(assistantMessageId('msg_1.2')).toBe('msg_1')
    expect(assistantMessageId('msg_1f4836018001F4gxkyuZyrCHsv_4')).toBe(
      'msg_1f4836018001F4gxkyuZyrCHsv_4',
    )
  })

  it('adds cached input and reasoning, which OpenCode counts apart, into the total', () => {
    expect(
      tokenTotals({ input: 100, output: 20, reasoning: 5, cache: { read: 1000, write: 50 } }),
    ).toEqual({
      total: 1175,
      input: 100,
      output: 20,
      thought: 5,
      cacheRead: 1000,
      cacheWrite: 50,
    })
    expect(tokenTotals(undefined)).toBeNull()
  })
})
