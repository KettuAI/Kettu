import { describe, expect, it } from 'vitest'
import { groupLabel, stopReasonText, toolLabel } from './helpers'

const base = { title: 'Do something', locations: [], rawInput: undefined }

describe('toolLabel', () => {
  it('names a file tool by its verb and the path inside the project', () => {
    expect(
      toolLabel({ ...base, toolKind: 'edit', locations: [{ path: '/repo/src/a.ts' }] }, '/repo'),
    ).toEqual({ verb: 'Edit', target: 'src/a.ts', kind: 'path' })
  })

  it('keeps a path outside the project absolute', () => {
    expect(
      toolLabel({ ...base, toolKind: 'read', locations: [{ path: '/etc/hosts' }] }, '/repo'),
    ).toEqual({
      verb: 'Read',
      target: '/etc/hosts',
      kind: 'path',
    })
  })

  it('names a command by Run and its input, else the title', () => {
    expect(toolLabel({ ...base, toolKind: 'execute', rawInput: 'pnpm test' }, '/repo')).toEqual({
      verb: 'Run',
      target: 'pnpm test',
      kind: 'command',
    })
    expect(toolLabel({ ...base, toolKind: 'execute', title: 'ls' }, '/repo').target).toBe('ls')
  })

  it("falls back to the agent's title", () => {
    expect(toolLabel({ ...base, toolKind: 'search', title: 'grep foo' }, '/repo')).toEqual({
      verb: null,
      target: 'grep foo',
      kind: 'title',
    })
  })
})

describe('groupLabel', () => {
  it('counts each kind of lookup', () => {
    expect(groupLabel(['read', 'read', 'read', 'read'])).toBe('Explored 4 files')
    expect(groupLabel(['search', 'search', 'search'])).toBe('Searched 3 times')
    expect(groupLabel(['read', 'search', 'read', 'fetch'])).toBe(
      'Explored 2 files, searched 1 time, fetched 1 page',
    )
  })
})

describe('stopReasonText', () => {
  it('says how a turn ended', () => {
    expect(stopReasonText('end_turn', 133_000)).toBe('Worked for 2 m 13 s')
    expect(stopReasonText('cancelled', 0)).toBe('Cancelled')
    expect(stopReasonText('max_tokens', 0)).toBe('Stopped at the token limit')
    expect(stopReasonText('max_turn_requests', 0)).toBe('Stopped at the request limit')
    expect(stopReasonText('refusal', 0)).toBe('Declined')
  })
})
