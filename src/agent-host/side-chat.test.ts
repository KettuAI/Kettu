import { describe, expect, it } from 'vitest'
import type { SessionView, SideChatEntry, SideChatSaw, ThreadEntry } from '@shared/thread'
import { carriedContext, sideContext } from './carried-context'
import {
  copySaw,
  hiddenPrompt,
  ownSaw,
  questionText,
  sideHistory,
  sideRoute,
  sideTurnText,
  SIDE_INSTRUCTIONS,
} from './side-chat'
import { changesStored, parseStoredSession, storedSession } from './threads/model'
import { parseSideChat, SIDE_ENTRIES } from './threads/side-chat'

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
        copy: { turns: 4, total: 10, first: true, bytes: 9_000 },
        fellBackFrom: null,
      },
      { source: 'fork', copy: null, fellBackFrom: null },
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
    expect(copySaw(carried, 'codex')).toMatchObject({
      source: 'copy',
      copy: { turns: 1, total: 1, first: false },
      fellBackFrom: 'codex',
    })
    expect(copySaw(null, null).copy).toEqual({ turns: 0, total: 0, first: false, bytes: 0 })
    expect(ownSaw('claude').source).toBe('agent')
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
