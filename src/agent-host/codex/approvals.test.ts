// The options Codex's requests show and the answers they send back: no remembering an unsafe
// command, a question's own words, and an MCP server's request to go on.

import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { threadFromSnapshot } from '@shared/thread'
import { newTurnScope, type MapperContext } from '../session-updates'
import {
  ANSWER_IN_REPLY,
  commandApproval,
  elicitationApproval,
  unsafeSessionCommand,
  userInputApproval,
} from './approvals'
import { ThreadMapper } from './mapper'
import type { CommandExecutionRequestApprovalParams } from './protocol'

function context(): MapperContext {
  let n = 0
  return {
    thread: threadFromSnapshot({
      session: {
        id: 's',
        agentId: 'codex',
        projectPath: os.tmpdir(),
        acpSessionId: 'thread-1',
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
    }),
    replaying: false,
    cancelling: false,
    scope: newTurnScope(),
    now: 1_000,
    nextId: () => `e:${++n}`,
    sessionIdFor: () => null,
  }
}

const at = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'exec-1' }

function command(params: Partial<CommandExecutionRequestApprovalParams>) {
  return commandApproval({ ...at, ...params }, new ThreadMapper(), context())
}

describe('unsafeSessionCommand', () => {
  it('judges the script inside the shell Codex runs it in', () => {
    expect(unsafeSessionCommand("/bin/zsh -lc 'touch a'")).toBe(false)
    expect(unsafeSessionCommand(`/bin/bash -lc 'echo '"'"'hi'"'"''`)).toBe(false)
    expect(unsafeSessionCommand('git status')).toBe(false)
    expect(unsafeSessionCommand("/bin/zsh -lc 'rm -rf build'")).toBe(true)
    expect(unsafeSessionCommand("bash -c 'pnpm build && git push --force'")).toBe(true)
    expect(unsafeSessionCommand("/bin/zsh -lc 'ls' extra")).toBe(true)
    expect(unsafeSessionCommand("/bin/zsh -lc 'ls' && rm x")).toBe(true)
    expect(unsafeSessionCommand(null)).toBe(true)
  })
})

describe('commandApproval', () => {
  it('offers to remember a safe command, for the session or as a rule', () => {
    const approval = command({
      command: "/bin/zsh -lc 'pnpm test'",
      proposedExecpolicyAmendment: ['pnpm', 'test'],
    })
    expect(approval.request.options.map((o) => [o.id, o.name])).toEqual([
      ['allow_once', 'Allow once'],
      ['allow_for_session', 'Allow for this session'],
      ['accept_execpolicy_amendment', 'Always allow `pnpm test`'],
      ['cancel', 'Deny, and say what to do instead'],
      ['decline', 'Deny, and keep going'],
    ])
  })

  it('offers only to allow once or deny a destructive command', () => {
    const approval = command({
      command: "/bin/zsh -lc 'rm -rf build'",
      proposedExecpolicyAmendment: ['rm', '-rf'],
    })
    expect(approval.request.options.map((o) => o.id)).toEqual(['allow_once', 'cancel', 'decline'])
  })

  it('leaves out what the request lists for an unsafe command, and never sends it', () => {
    const approval = command({
      command: "/bin/zsh -lc 'git reset --hard'",
      availableDecisions: [
        'accept',
        'acceptForSession',
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'reset'] } },
        'cancel',
      ],
    })
    expect(approval.request.options.map((o) => o.id)).toEqual(['allow_once', 'cancel'])
    expect(approval.respond({ optionId: 'allow_for_session' })).toEqual({ decision: 'cancel' })
    expect(approval.respond({ optionId: 'accept_execpolicy_amendment' })).toEqual({
      decision: 'cancel',
    })
    expect(approval.respond({ optionId: 'allow_once' })).toEqual({ decision: 'accept' })
  })

  it('judges a rule by its own words, apart from the command', () => {
    const safeRule = command({
      command: "/bin/zsh -lc 'pnpm build && rm -rf dist'",
      proposedExecpolicyAmendment: ['pnpm', 'build'],
    })
    expect(safeRule.request.options.map((o) => o.id)).toEqual([
      'allow_once',
      'accept_execpolicy_amendment',
      'cancel',
      'decline',
    ])
    const openRule = command({ command: 'git status', proposedExecpolicyAmendment: ['git'] })
    expect(openRule.request.options.map((o) => o.id)).toEqual([
      'allow_once',
      'allow_for_session',
      'cancel',
      'decline',
    ])
  })
})

describe('userInputApproval', () => {
  const question = {
    id: 'q',
    header: 'Plan',
    question: 'Which one?',
    isOther: false,
    isSecret: false,
    options: [
      { label: 'A', description: '' },
      { label: 'B', description: '' },
    ],
  }
  const asked = () =>
    userInputApproval({ ...at, questions: [question] }, new ThreadMapper(), context())!

  it('answers a choice with its label', () => {
    expect(asked().respond({ optionId: 'answer:1' })).toEqual({
      answers: { q: { answers: ['B'] } },
    })
  })

  it('tells Codex to wait for the user’s own words after Something else', () => {
    expect(asked().respond({ optionId: 'other' })).toEqual({
      answers: { q: { answers: [ANSWER_IN_REPLY] } },
    })
  })

  it('answers nothing when the request goes unanswered', () => {
    expect(asked().respond('cancelled')).toEqual({ answers: {} })
  })
})

describe('elicitationApproval', () => {
  const elicitation = () =>
    elicitationApproval(
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        serverName: 'docs',
        mode: 'form',
        _meta: null,
        message: 'Go on?',
        requestedSchema: {},
      },
      7,
      new ThreadMapper(),
      context(),
    )!

  it('offers to go on, to decline, then to dismiss, which does not stop the turn', () => {
    expect(elicitation().request.options).toEqual([
      { id: 'allow_once', name: 'Continue', kind: 'allow_once' },
      { id: 'decline', name: 'Deny, and keep going', kind: 'reject_once' },
      { id: 'dismiss', name: 'Dismiss without answering', kind: 'reject_once' },
    ])
  })

  it('sends the action for the option chosen', () => {
    const { respond } = elicitation()
    expect(respond({ optionId: 'allow_once' })).toEqual({
      action: 'accept',
      content: {},
      _meta: null,
    })
    expect(respond({ optionId: 'decline' })).toEqual({
      action: 'decline',
      content: null,
      _meta: null,
    })
    expect(respond({ optionId: 'dismiss' })).toEqual({
      action: 'cancel',
      content: null,
      _meta: null,
    })
    expect(respond('cancelled')).toEqual({ action: 'cancel', content: null, _meta: null })
  })
})
