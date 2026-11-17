import { describe, expect, it, vi } from 'vitest'
import type { SessionView, SideChatEntry, SideChatSaw, ThreadEntry } from '@shared/thread'
import { carriedContext, sideContext } from './carried-context'
import {
  answerFork,
  copySaw,
  hiddenPrompt,
  ownSaw,
  questionText,
  sideHistory,
  sideRoute,
  sideRouteWith,
  sideTurnText,
  SIDE_INSTRUCTIONS,
} from './side-chat'
import { changesStored, parseStoredSession, storedSession } from './threads/model'
import { parseSideChat, SIDE_ENTRIES } from './threads/side-chat'
import { SideQuestionUnsupported, type AgentConnection } from './connection'

function entry(id: string, fields: Partial<SideChatEntry> = {}): SideChatEntry {
  return {
    id,
    question: `Question ${id}`,
    quote: null,
    agentId: 'claude-code',
    route: 'claude',
    status: 'answered',
    answer: `Answer ${id}`,
    steps: [],
    saw: null,
    error: null,
    askedAt: 1,
    answeredAt: 2,
    ...fields,
  }
}

function view(fields: Partial<SessionView> = {}): SessionView {
  return {
    id: 's',
    agentId: 'claude-code',
    projectPath: '/p',
    acpSessionId: 'a',
    status: 'ready',
    title: 'T',
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
    ...fields,
  }
}

describe('the stored side chat', () => {
  it('goes with the session view and comes back, its route left to the agent', () => {
    const side = { route: 'claude' as const, answerAgent: null, entries: [entry('1')] }
    const stored = storedSession(view({ sideChat: side }))
    expect(stored.sideChat).toEqual({ answerAgent: null, entries: [entry('1')] })
    expect(parseStoredSession(JSON.parse(JSON.stringify(stored)))?.sideChat).toEqual(
      stored.sideChat,
    )
    expect(changesStored({ sideChat: side })).toBe(true)
  })

  it('stores nothing for an empty side chat, and reads a session stored before it as none', () => {
    const empty = { route: 'none' as const, answerAgent: null, entries: [] }
    expect(storedSession(view({ sideChat: empty })).sideChat).toBeNull()
    const old = JSON.parse(JSON.stringify(storedSession(view()))) as Record<string, unknown>
    delete old.sideChat
    expect(parseStoredSession(old)?.sideChat).toBeNull()
  })

  it('reads what an answer saw, and an entry stored with carried as a copy', () => {
    const copy: SideChatSaw = {
      source: 'copy',
      compacted: 4,
      copy: { turns: 3, total: 9, first: true, bytes: 4_000 },
      fellBackFrom: 'claude',
    }
    const parsed = parseSideChat({
      answerAgent: null,
      entries: [
        entry('a', { route: 'hidden', saw: copy }),
        { ...entry('b'), saw: { source: 'copy', copy: null, fellBackFrom: null } },
        {
          ...entry('c', { route: 'hidden' }),
          saw: undefined,
          carried: { first: true, recent: 4, omitted: 6, bytes: 9_000 },
        },
        entry('d', { saw: ownSaw('codex') }),
      ],
    })
    expect(parsed?.entries.map((e) => e.saw)).toEqual([
      copy,
      null,
      {
        source: 'copy',
        compacted: 0,
        copy: { turns: 4, total: 10, first: true, bytes: 9_000 },
        fellBackFrom: null,
      },
      { source: 'fork', compacted: 0, copy: null, fellBackFrom: null },
    ])
  })

  it('drops damaged entries on their own, keeps the newest and stops one cut off by a restart', () => {
    const many = Array.from({ length: SIDE_ENTRIES + 3 }, (_, i) => entry(String(i)))
    const parsed = parseSideChat({
      answerAgent: 'codex',
      entries: [
        { ...entry('bad'), status: 'thinking' },
        { ...entry('bad2'), question: 3 },
        ...many,
        {
          ...entry('live', { status: 'answering' }),
          steps: [{ kind: 'read', title: 'a.ts' }, { x: 1 }],
        },
      ],
    })
    expect(parsed?.answerAgent).toBe('codex')
    expect(parsed?.entries).toHaveLength(SIDE_ENTRIES)
    expect(parsed?.entries.some((e) => e.id.startsWith('bad'))).toBe(false)
    expect(parsed?.entries.at(-1)).toMatchObject({
      id: 'live',
      status: 'stopped',
      steps: [{ kind: 'read', title: 'a.ts' }],
    })
    expect(parseSideChat({ entries: 'x' })).toBeNull()
    expect(parseSideChat(null)).toBeNull()
  })
})

describe('side questions', () => {
  it('go to each agent its own way, and to another agent where hidden sessions leave a trace', () => {
    expect(sideRoute('claude-code')).toBe('claude')
    expect(sideRoute('claude-code~work')).toBe('claude')
    expect(sideRoute('codex')).toBe('codex')
    expect(sideRoute('opencode')).toBe('hidden')
    expect(sideRoute('pi')).toBe('hidden')
    expect(sideRoute('deepseek')).toBe('none')
    expect(sideRoute('auggie')).toBe('none')
    // agy's hidden sessions may only be opened and read, never asked anything.
    expect(sideRoute('antigravity')).toBe('none')
  })

  it('go to an agent that can fork its session through the fork, never past its own way', () => {
    const forks = { forkSession: true }
    expect(sideRouteWith('opencode', forks)).toBe('fork')
    expect(sideRouteWith('opencode', { forkSession: false })).toBe('hidden')
    expect(sideRouteWith('opencode', null)).toBe('hidden')
    expect(sideRouteWith('pi', { forkSession: false })).toBe('hidden')
    expect(sideRouteWith('claude-code', forks)).toBe('claude')
    expect(sideRouteWith('codex', forks)).toBe('codex')
    // A fork of a session whose hidden sessions leave a trace would leave one too.
    expect(sideRouteWith('deepseek', forks)).toBe('none')
  })

  it('carry only answered questions, newest last, with their quotes', () => {
    const history = sideHistory([
      entry('1', { quote: 'line one' }),
      entry('2', { status: 'failed', answer: '' }),
      entry('3', { status: 'stopped' }),
      entry('4'),
    ])
    expect(history).toEqual([
      { question: questionText('Question 1', 'line one'), answer: 'Answer 1' },
      { question: 'Question 4', answer: 'Answer 4' },
    ])
    expect(questionText('Why?', 'a\nb')).toBe('> a\n> b\n\nWhy?')
  })

  it('carry the newest 20 earlier questions, and say what a copy held', () => {
    const many = Array.from({ length: 25 }, (_, i) => entry(String(i + 1)))
    const history = sideHistory(many)
    expect(history).toHaveLength(20)
    expect(history.at(-1)).toMatchObject({ question: 'Question 25' })
    expect(history[0]).toMatchObject({ question: 'Question 6' })
    const entries: ThreadEntry[] = [
      { kind: 'user', id: 'u1', content: [{ type: 'text', text: 'Clean the worktrees' }] },
      { kind: 'agent', id: 'm1', markdown: 'Done.', attachments: [], streaming: false },
    ]
    const carried = sideContext(entries, { firstAgent: 'claude-code', agentName: () => 'Claude' })
    expect(copySaw(carried, 'codex', 0)).toMatchObject({
      source: 'copy',
      copy: { turns: 1, total: 1, first: false },
      fellBackFrom: 'codex',
    })
    expect(copySaw(null, null, 3)).toMatchObject({
      compacted: 3,
      copy: { turns: 0, total: 0, first: false, bytes: 0 },
    })
    expect(ownSaw('claude', null, 2)).toMatchObject({ source: 'agent', compacted: 2 })
  })

  it('tell a fork the history may still run and a hidden session the conversation, as reference only', () => {
    const turn = sideTurnText({ question: 'Why?', history: [] })
    expect(turn).toMatch(/^The session may still be running\. Nothing above is yours to run/)
    expect(turn.endsWith('Side question:\nWhy?')).toBe(true)
    expect(SIDE_INSTRUCTIONS).toMatch(/reference context only/)
    expect(SIDE_INSTRUCTIONS).toMatch(/may still be running/)
    expect(SIDE_INSTRUCTIONS).toMatch(/Never run again a command or tool call/)
    const entries: ThreadEntry[] = [
      { kind: 'user', id: 'u1', content: [{ type: 'text', text: 'Clean the worktrees' }] },
      {
        kind: 'agent',
        id: 'm1',
        markdown: 'Moved it to archive.',
        attachments: [],
        streaming: false,
      },
    ]
    const carried = carriedContext(entries, {
      firstAgent: 'claude-code',
      agentName: () => 'Claude Code',
      side: true,
    })
    expect(carried?.header).toMatch(/^Below is the conversation of a Kettu session/)
    expect(carried?.header).not.toMatch(/taking over/)
    const prompt = hiddenPrompt(carried!.text, { question: 'Why?', history: [] })
    expect(prompt).toContain('Clean the worktrees')
    expect(prompt).toContain('Moved it to archive.')
    expect(prompt).toContain('without tools')
    expect(prompt.endsWith('Side question:\nWhy?')).toBe(true)
  })
})

describe('a side question answered in a fork', () => {
  const connect = (changes: Record<string, unknown> = {}, hang = false) => {
    const calls: string[] = []
    let release: (messages: string[]) => void = () => {}
    const connection = {
      hiddenSessions: true,
      forkSession: vi.fn(async () => {
        calls.push('fork')
        return { sessionId: 'fork-1', config: [] }
      }),
      collect: vi.fn(async (_id: string, text: string) => {
        calls.push(`collect:${text.length > 0}`)
        if (hang) return new Promise<string[]>((resolve) => (release = resolve))
        return ['First.', 'Second.']
      }),
      // A cancelled turn ends, as an agent's does.
      cancel: vi.fn(async () => {
        calls.push('cancel')
        release([])
      }),
      removeHidden: vi.fn(async () => {
        calls.push('remove')
      }),
      setConfigOption: vi.fn(async () => []),
      ...changes,
    }
    return { calls, connection, runtime: { connection: connection as unknown as AgentConnection } }
  }
  const request = (open: () => Promise<{ sessionId: string; config: never[] }>) => ({
    open,
    model: null,
    prompt: 'Why?',
    signal: new AbortController().signal,
    text: () => {},
    log: () => {},
  })

  it('forks, asks and removes the fork, whatever the answer was', async () => {
    const { calls, connection, runtime } = connect()
    const grown: string[] = []
    const answer = await answerFork(runtime, {
      ...request(() => connection.forkSession() as never),
      text: (text) => grown.push(text),
    })
    expect(answer).toBe('First.\n\nSecond.')
    expect(grown).toEqual(['First.\n\nSecond.'])
    expect(calls).toEqual(['fork', 'collect:true', 'remove'])

    const failing = connect({
      collect: vi.fn(async () => {
        throw new Error('boom')
      }),
    })
    await expect(
      answerFork(
        failing.runtime,
        request(() => failing.connection.forkSession() as never),
      ),
    ).rejects.toThrow('boom')
    expect(failing.calls).toEqual(['fork', 'remove'])
  })

  it('removes the fork of an answer that was stopped or took too long', async () => {
    const stopped = new AbortController()
    const slow = connect({}, true)
    const asking = answerFork(slow.runtime, {
      ...request(() => slow.connection.forkSession() as never),
      signal: stopped.signal,
    })
    await vi.waitFor(() => expect(slow.connection.collect).toHaveBeenCalled())
    stopped.abort()
    await expect(asking).rejects.toThrow()
    expect(slow.calls).toEqual(expect.arrayContaining(['fork', 'cancel', 'remove']))
    expect(slow.calls.at(-1)).toBe('remove')

    const late = connect({}, true)
    await expect(
      answerFork(late.runtime, {
        ...request(() => late.connection.forkSession() as never),
        timeoutMs: 20,
      }),
    ).rejects.toThrow(/no answer within/)
    expect(late.calls.at(-1)).toBe('remove')
  })

  it('leaves it to another way when the agent cannot remove its hidden sessions or fork', async () => {
    const keeps = connect({ hiddenSessions: false })
    await expect(
      answerFork(
        keeps.runtime,
        request(() => keeps.connection.forkSession() as never),
      ),
    ).rejects.toBeInstanceOf(SideQuestionUnsupported)
    expect(keeps.calls).toEqual([])

    const refuses = connect({
      forkSession: vi.fn(async () => {
        throw new Error('no such session')
      }),
    })
    await expect(
      answerFork(
        refuses.runtime,
        request(() => refuses.connection.forkSession() as never),
      ),
    ).rejects.toBeInstanceOf(SideQuestionUnsupported)
    expect(refuses.calls).toEqual([])
  })
})
