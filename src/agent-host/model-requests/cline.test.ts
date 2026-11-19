// The Requests pane's reading of a Cline session, on the messages file cline 3.0.74 kept for a
// session made over ACP and carried on through the SDK.

import { describe, expect, it } from 'vitest'
import { clineMessagesFile, clineTurns } from './cline'
import recorded from './fixtures/cline-messages.json'

describe('Cline requests', () => {
  it('reads each of the user’s messages as a turn, and each reply as a request of it', () => {
    const turns = clineTurns(recorded.messages)
    expect(turns.map((turn) => [turn.index, turn.prompt, turn.requests.length])).toEqual([
      [1, 'KP hello from main over acp', 1],
      [2, 'KP read', 2],
      [3, 'KP hello continuing on the sdk', 1],
      [4, 'KP hello back on acp', 1],
    ])
  })

  it('reads a request’s model, tokens, what it sent and what came back', () => {
    const [first, read] = clineTurns(recorded.messages)
    expect(first!.requests[0]).toMatchObject({
      id: 'msg_b30alpMa',
      turnId: first!.id,
      model: 'gpt-4o',
      status: 'done',
      tokens: { input: 1221, cacheRead: 0, cacheWrite: 0, output: 30 },
      actions: [{ kind: 'reply', label: 'Reply', count: 1 }],
      sent: [{ kind: 'prompt', label: 'Prompt', preview: 'KP hello from main over acp' }],
      received: [{ kind: 'text', label: 'Reply' }],
      raw: '0-2',
    })
    const [call, after] = read!.requests
    expect(call!.actions).toEqual([
      { kind: 'read', label: 'read_files', count: 1 },
      { kind: 'reply', label: 'Reply', count: 1 },
    ])
    expect(call!.received.map((part) => part.kind)).toEqual(['text', 'tool-call'])
    // The request after a tool call sends that call's result.
    expect(after!.sent).toMatchObject([{ kind: 'tool-result', label: 'read_files' }])
    expect(after!.raw).toBe('4-6')
  })

  it('counts input apart from what the cache served', () => {
    const [turn] = clineTurns([
      { role: 'user', content: [{ type: 'text', text: 'hi' }], ts: 1 },
      {
        id: 'm',
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'hm' }],
        ts: 2,
        metrics: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 60, cacheWriteTokens: 10 },
      },
    ])
    expect(turn!.requests[0]).toMatchObject({
      sentAt: 1,
      endedAt: 2,
      tokens: { input: 30, cacheRead: 60, cacheWrite: 10, output: 7 },
      actions: [{ kind: 'thinking' }],
    })
  })

  it('finds the file where Cline’s own variables put its folders', () => {
    const home = '/home/u'
    expect(clineMessagesFile({}, home, 's1')).toBe(
      '/home/u/.cline/data/sessions/s1/s1.messages.json',
    )
    expect(clineMessagesFile({ CLINE_DIR: '/c' }, home, 's1')).toBe(
      '/c/data/sessions/s1/s1.messages.json',
    )
    expect(clineMessagesFile({ CLINE_DIR: '/c', CLINE_DATA_DIR: '/d' }, home, 's1')).toBe(
      '/d/sessions/s1/s1.messages.json',
    )
    expect(clineMessagesFile({ CLINE_SESSION_DATA_DIR: '/s' }, home, 's1')).toBe(
      '/s/s1/s1.messages.json',
    )
  })
})
