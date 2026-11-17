import type { PermissionOption, ToolCallUpdate } from '@agentclientprotocol/sdk/unstable'
import { describe, expect, it } from 'vitest'
import {
  applyPatches,
  threadFromSnapshot,
  type SessionView,
  type ThreadState,
} from '@shared/thread'
import { newTurnScope } from '../session-updates'
import { mapPermissionToolCall } from './mapper'
import { selectQuestion } from './select-question'

// The shape pi-acp 0.0.34 sends for an extension's select: every choice is "allow once".
const choices = [
  '1. Give a password — type it in the note; used for this connection only.',
  '2. Name a credential source — say which secure source is set up.',
  '3. None of these',
]
const asked = (over: Partial<ToolCallUpdate> = {}): ToolCallUpdate => ({
  toolCallId: 'pi-ui-1',
  title: 'Oracle login: how should Kettu get the credentials?',
  kind: 'other',
  status: 'pending',
  rawInput: { method: 'select', title: 'Oracle login', options: choices },
  ...over,
})
const options = (names: string[]): PermissionOption[] =>
  names.map((name, i) => ({ optionId: `choice-${i}`, name, kind: 'allow_once' }))

describe('selectQuestion', () => {
  it('turns an extension select into a question with its choices', () => {
    expect(selectQuestion(asked(), options(choices))).toEqual({
      question: 'Oracle login',
      options: [
        {
          id: 'choice-0',
          kind: 'allow_once',
          name: 'Give a password',
          description: 'type it in the note; used for this connection only.',
        },
        {
          id: 'choice-1',
          kind: 'allow_once',
          name: 'Name a credential source',
          description: 'say which secure source is set up.',
        },
        { id: 'choice-2', kind: 'allow_once', name: 'None of these' },
      ],
    })
  })

  it('keeps a number that is not the row own and a dash with nothing after it', () => {
    const names = ['3. Later', 'Wait — ', '— Odd']
    const found = selectQuestion(
      asked({ rawInput: { method: 'select', title: 'Q', options: names } }),
      options(names),
    )
    expect(found?.options.map((o) => [o.name, o.description])).toEqual([
      ['3. Later', undefined],
      ['Wait —', undefined],
      ['— Odd', undefined],
    ])
  })

  it('falls back to the call title when the select has none', () => {
    const found = selectQuestion(
      asked({ rawInput: { method: 'select', options: choices } }),
      options(choices),
    )
    expect(found?.question).toBe('Oracle login: how should Kettu get the credentials?')
  })

  it('leaves real permission requests alone', () => {
    const run = asked({ kind: 'execute', title: 'Run rm', rawInput: { command: 'rm -rf x' } })
    const real: PermissionOption[] = [
      { optionId: 'a', name: 'Allow', kind: 'allow_once' },
      { optionId: 'r', name: 'Deny', kind: 'reject_once' },
    ]
    expect(selectQuestion(run, real)).toBeNull()
    // pi-acp's confirm has a rejecting option, so it stays a permission.
    const confirm = asked({ rawInput: { method: 'confirm', title: 'Sure?' } })
    expect(selectQuestion(confirm, real)).toBeNull()
  })

  it('does not take a select whose options differ from the choices it names', () => {
    const rawInput = { method: 'select', title: 'Q', options: ['A', 'B'] }
    expect(selectQuestion(asked({ rawInput }), options(['A']))).toBeNull()
    expect(selectQuestion(asked({ rawInput }), options(['A', 'X']))).toBeNull()
    const rejecting: PermissionOption[] = [
      { optionId: 'a', name: 'A', kind: 'allow_once' },
      { optionId: 'b', name: 'B', kind: 'reject_once' },
    ]
    expect(selectQuestion(asked({ rawInput }), rejecting)).toBeNull()
    expect(selectQuestion(asked({ rawInput: 'select' }), options(['A', 'B']))).toBeNull()
  })

  it('needs a question to show', () => {
    const rawInput = { method: 'select', options: ['A'] }
    expect(selectQuestion(asked({ rawInput, title: '  ' }), options(['A']))).toBeNull()
  })
})

describe('a select question on the thread', () => {
  const session: SessionView = {
    id: 's1',
    agentId: 'pi',
    projectPath: '/repo',
    acpSessionId: 'acp-1',
    status: 'running',
    title: null,
    config: [],
    commands: [],
    usage: null,
    error: null,
    turnStartedAt: 1,
    turnStartUsed: null,
    createdAt: 1,
    updatedAt: 1,
    parentId: null,
    origin: 'user',
    subagent: null,
    routine: null,
    queue: [],
    queuePaused: false,
  }
  const entryOf = (thread: ThreadState, question?: string) => {
    const { entryId, output } = mapPermissionToolCall(
      asked(),
      {
        thread,
        replaying: false,
        cancelling: false,
        scope: newTurnScope(),
        now: 1,
        nextId: () => 'e:1',
        sessionIdFor: () => null,
      },
      question,
    )
    return applyPatches(thread, output.patches).byId[entryId]
  }

  it('gives the entry its question, which an ordinary request lacks', () => {
    const thread = threadFromSnapshot({ session, entries: [], seq: 0 })
    expect(entryOf(thread, 'Oracle login')).toMatchObject({
      kind: 'tool',
      question: 'Oracle login',
    })
    expect(entryOf(thread)).not.toHaveProperty('question')
  })
})
