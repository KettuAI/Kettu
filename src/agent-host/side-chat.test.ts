import { describe, expect, it } from 'vitest'
import type { SessionView, SideChatEntry, ThreadEntry } from '@shared/thread'
import { carriedContext } from './carried-context'
import {
  hiddenPrompt,
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
    carried: null,
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

  it('drops damaged entries on their own, keeps the newest and stops one cut off by a restart', () => {
    const many = Array.from({ length: SIDE_ENTRIES + 3 }, (_, i) => entry(String(i)))
    const parsed = parseSideChat({
      answerAgent: 'codex',
      entries: [
        { ...entry('bad'), status: 'thinking' },
        { ...entry('bad2'), question: 3 },
        ...many,
        entry('live', { status: 'answering', steps: [{ kind: 'read', title: 'a.ts' }, { x: 1 }] }),
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

  it('tell a fork the running turn and a hidden session the conversation, as reference only', () => {
    const turn = sideTurnText({ question: 'Why?', history: [], running: 'Fix it' })
    expect(turn).toContain('<running_turn>')
    expect(turn.endsWith('Side question:\nWhy?')).toBe(true)
    expect(SIDE_INSTRUCTIONS).toMatch(/reference context only/)
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
