import { describe, expect, it } from 'vitest'
import { MAX_ACTIONS_PER_BATCH, parseActionBatch } from './action-records'

const NOW = 1_800_000_000_000

describe('parseActionBatch', () => {
  it('keeps well-formed records', () => {
    const { records, rejected } = parseActionBatch(
      [
        { at: NOW, name: 'view.session', data: { sessionId: 's-1', pinned: false } },
        { at: NOW - 1000, name: 'command.new-session' },
      ],
      NOW,
    )
    expect(rejected).toBe(0)
    expect(records).toEqual([
      { at: NOW, name: 'view.session', data: { sessionId: 's-1', pinned: false } },
      { at: NOW - 1000, name: 'command.new-session', data: {} },
    ])
  })

  it('rejects anything that is not a list', () => {
    expect(parseActionBatch({ at: NOW, name: 'x' }, NOW)).toEqual({ records: [], rejected: 1 })
  })

  it('rejects bad names, long values, nested data and odd times', () => {
    const { records, rejected } = parseActionBatch(
      [
        { at: NOW, name: 'has space' },
        { at: NOW, name: 'x'.repeat(65) },
        { at: NOW, name: 'ok', data: { text: 'a'.repeat(129) } },
        { at: NOW, name: 'ok', data: { nested: { a: 1 } } },
        { at: NOW, name: 'ok', data: { 'bad-key': 1 } },
        { at: NOW, name: 'ok', data: { n: Number.NaN } },
        { at: NOW + 60 * 60 * 1000, name: 'ok' },
        { at: 'now', name: 'ok' },
        null,
      ],
      NOW,
    )
    expect(records).toEqual([])
    expect(rejected).toBe(9)
  })

  it('caps the fields of a record and the records of a batch', () => {
    const fields = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, i]))
    expect(parseActionBatch([{ at: NOW, name: 'ok', data: fields }], NOW).rejected).toBe(1)
    const many = Array.from({ length: MAX_ACTIONS_PER_BATCH + 5 }, () => ({ at: NOW, name: 'ok' }))
    const parsed = parseActionBatch(many, NOW)
    expect(parsed.records).toHaveLength(MAX_ACTIONS_PER_BATCH)
    expect(parsed.rejected).toBe(5)
  })
})
