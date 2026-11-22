import { describe, expect, it } from 'vitest'
import { forkedUuids, rewindCut, RewindPointMissing, type TranscriptRecord } from './rewind'

const prompt = (uuid: string, parentUuid: string | null, text: string): TranscriptRecord => ({
  type: 'user',
  uuid,
  parentUuid,
  message: { role: 'user', content: [{ type: 'text', text }] },
})
const reply = (uuid: string, parentUuid: string): TranscriptRecord => ({
  type: 'assistant',
  uuid,
  parentUuid,
  message: { content: [{ type: 'text', text: 'Done.' }] },
})

const transcript: TranscriptRecord[] = [
  prompt('u1', null, 'Fix the test'),
  reply('a1', 'u1'),
  { type: 'system', subtype: 'local_command', uuid: 'c1', parentUuid: 'a1', content: '/usage' },
  prompt('c2', 'c1', '<local-command-stdout>42%</local-command-stdout>'),
  prompt('u2', 'c2', 'Now the docs'),
  reply('a2', 'u2'),
  prompt('u3', 'a2', 'Now the docs'),
]

describe('rewindCut', () => {
  it('cuts at the record before the prompt, past a local command run in between', () => {
    expect(rewindCut(transcript, { ref: 'u2', text: 'Now the docs', occurrence: 1 })).toBe('a1')
    expect(rewindCut(transcript, { ref: 'u3', text: 'Now the docs', occurrence: 2 })).toBe('a2')
  })

  it('finds a prompt sent before Kettu kept its id by its text and occurrence', () => {
    expect(rewindCut(transcript, { ref: null, text: 'Now the docs', occurrence: 2 })).toBe('a2')
    expect(rewindCut(transcript, { ref: 'gone', text: 'Fix the test', occurrence: 1 })).toBeNull()
  })

  it('finds a prompt a fork copied by the id it was copied from', () => {
    const fork = [{ ...prompt('f1', null, 'Fix'), forkedFrom: { messageUuid: 'u1' } }]
    fork.push({ ...reply('f2', 'f1'), forkedFrom: { messageUuid: 'a1' } })
    fork.push({ ...prompt('f3', 'f2', 'Again'), forkedFrom: { messageUuid: 'u9' } })
    expect(rewindCut(fork, { ref: 'u9', text: 'Again', occurrence: 1 })).toBe('f2')
  })

  it('says when the prompt is not in the transcript', () => {
    expect(() => rewindCut(transcript, { ref: null, text: 'Other', occurrence: 1 })).toThrow(
      RewindPointMissing,
    )
  })
})

describe('forkedUuids', () => {
  it("maps the records a fork copied from their source's ids", () => {
    const fork: TranscriptRecord[] = [
      { ...prompt('f1', null, 'Fix'), forkedFrom: { sessionId: 's', messageUuid: 'u1' } },
      { ...reply('f2', 'f1'), forkedFrom: { sessionId: 's', messageUuid: 'a1' } },
      prompt('f3', 'f2', 'New'),
    ]
    expect(forkedUuids(fork)).toEqual({ u1: 'f1', a1: 'f2' })
  })
})
