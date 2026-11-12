// What Kettu sends DeepSeek Harness: answers to its questions and plans, the MCP servers it mounts
// and the errors a turn ends with.

import { describe, expect, it } from 'vitest'
import { AgentRequestError } from '../connection'
import {
  mcpPatch,
  planAnswer,
  promptContent,
  questionResult,
  serverName,
  turnError,
} from './connection'
import type { QuestionRequest } from './protocol'

const ASK: QuestionRequest = {
  requestId: 'q1',
  sessionId: 'kettu-1',
  questions: [
    {
      id: 'color',
      question: 'Which color?',
      header: 'Color',
      options: [{ label: 'Red', description: 'warm' }, { label: 'Blue' }],
    },
    {
      id: 'size',
      question: 'Sizes?',
      multiSelect: true,
      options: [{ label: 'S' }, { label: 'M' }],
    },
  ],
}

describe('dsh answers', () => {
  it('answers every question by its id, a skipped one with nothing chosen', () => {
    expect(
      questionResult(ASK, {
        answers: [{ question: 0, choices: [1], text: '  a darker one ' }],
      }),
    ).toEqual({
      answers: [
        { id: 'color', selected: ['Blue'], custom: 'a darker one' },
        { id: 'size', selected: [] },
      ],
    })
  })

  it('takes several choices of a multiple choice question', () => {
    expect(
      questionResult(ASK, {
        answers: [
          { question: 0, choices: [0] },
          { question: 1, choices: [0, 1] },
        ],
      }),
    ).toMatchObject({ answers: [{ selected: ['Red'] }, { selected: ['S', 'M'] }] })
  })

  it('reads a dismissed card, or a form answer it never asked for, as a dismissal', () => {
    expect(questionResult(ASK, 'cancelled')).toEqual({ cancelled: true })
    expect(questionResult(ASK, { values: {} })).toEqual({ cancelled: true })
  })

  it('answers the first question from a client that only picks an option', () => {
    expect(questionResult(ASK, { optionId: 'answer:0' })).toEqual({
      answers: [
        { id: 'color', selected: ['Red'] },
        { id: 'size', selected: [] },
      ],
    })
    expect(questionResult(ASK, { optionId: 'other' })).toEqual({ cancelled: true })
  })

  it('approves a plan with its own label, and sends a note back as the user’s words', () => {
    const review = {
      id: 'plan-review',
      options: [{ label: 'Approve' }, { label: 'Keep planning' }],
    }
    expect(planAnswer(review, 'Approve', { optionId: 'approve' })).toEqual({
      answers: [{ id: 'plan-review', selected: ['Approve'] }],
    })
    expect(planAnswer(review, 'Approve', { optionId: 'keep', note: 'Add tests' })).toEqual({
      answers: [{ id: 'plan-review', selected: ['Keep planning'], custom: 'Add tests' }],
    })
    expect(planAnswer(review, 'Approve', null)).toEqual({ cancelled: true })
  })
})

describe('dsh MCP patch', () => {
  it('writes no header or environment value into the file, only the variables that hold them', () => {
    const { yaml, env } = mcpPatch([
      {
        type: 'http',
        name: 'kettu',
        url: 'http://127.0.0.1:4100/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer secret-token' }],
        secret: true,
      },
      {
        type: 'stdio',
        name: 'my server',
        command: '/usr/bin/node',
        args: ['server.js', '--flag'],
        env: [{ name: 'API_TOKEN', value: 'sk-abc' }],
      },
    ])
    expect(yaml).not.toContain('secret-token')
    expect(yaml).not.toContain('sk-abc')
    expect(yaml).toContain('"Authorization": !!js process.env.KETTU_MCP_SECRET_0')
    expect(yaml).toContain('"API_TOKEN": !!js process.env.KETTU_MCP_SECRET_1')
    expect(env).toEqual({ KETTU_MCP_SECRET_0: 'Bearer secret-token', KETTU_MCP_SECRET_1: 'sk-abc' })
    expect(Object.keys(env).every((name) => name.includes('SECRET'))).toBe(true)
    expect(yaml).toContain('serverName: "my_server"')
    expect(yaml).toContain('args: ["server.js", "--flag"]')
  })

  it('quotes what a server names, so no value can add rows of its own', () => {
    const { yaml } = mcpPatch([
      {
        type: 'stdio',
        name: 'x',
        command: '/bin/x\n- insert: [{name: evil}]',
        args: ['"; process.exit()'],
        env: [],
      },
    ])
    expect(yaml).toContain('command: "/bin/x\\n- insert: [{name: evil}]"')
    expect(yaml.split('\n').filter((line) => line.startsWith('- '))).toEqual(['- insert:'])
  })

  it('writes nothing for no servers, and leaves out SSE, which dsh does not speak', () => {
    expect(mcpPatch([]).yaml).toBe('')
    expect(mcpPatch([{ type: 'sse', name: 'old', url: 'http://x', headers: [] }]).yaml).toBe('')
  })

  it('makes server names dsh accepts, each once', () => {
    const taken = new Set(['kettu'])
    expect(serverName('kettu', taken)).toBe('kettu_2')
    expect(serverName('a'.repeat(40), new Set())).toBe('a'.repeat(32))
    expect(serverName('ä b', new Set())).toBe('__b')
  })
})

describe('dsh turns', () => {
  it('asks for a sign-in when the provider refuses the credentials', () => {
    const error = turnError({ message: 'Unauthorized', code: 'AUTH', status: 401 })
    expect(error).toBeInstanceOf(AgentRequestError)
    expect((error as AgentRequestError).kind).toBe('auth_required')
  })

  it('keeps the provider’s status, which tells an empty balance', () => {
    const error = turnError({ message: 'Insufficient Balance', code: 'QUOTA', status: 402 })
    expect(error).toMatchObject({ kind: 'agent_error', data: { code: 'QUOTA', status: 402 } })
  })

  it('sends text and images in order, and a file link as a path dsh reads itself', () => {
    expect(
      promptContent([
        { type: 'text', text: 'look' },
        { type: 'image', mimeType: 'image/png', data: 'AAAA' },
        { type: 'resource_link', uri: 'file:///work/app/a%20b.ts', name: 'a b.ts' },
      ]),
    ).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'text', text: '@/work/app/a b.ts' },
    ])
  })
})
