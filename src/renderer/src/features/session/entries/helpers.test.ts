import { describe, expect, it } from 'vitest'
import { groupLabel, runSummary, stopReasonText, toolLabel } from './helpers'

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

  it('drops the verb from a title that already starts with it', () => {
    expect(toolLabel({ ...base, toolKind: 'execute', title: 'Run pnpm build' }, '/repo')).toEqual({
      verb: 'Run',
      target: 'pnpm build',
      kind: 'command',
    })
    expect(toolLabel({ ...base, toolKind: 'execute', title: 'Runner' }, '/repo').target).toBe(
      'Runner',
    )
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
      'Explored 2 files, searched once, fetched a page',
    )
  })
})

describe('runSummary', () => {
  const run = (kind: string, path?: string) => ({
    kind: 'tool' as const,
    toolKind: kind as 'read',
    status: 'completed' as const,
    path,
  })

  it('counts each kind in the order it first appears', () => {
    expect(
      runSummary([
        run('execute'),
        run('read', '/repo/a.ts'),
        run('execute'),
        run('read', '/repo/b.ts'),
        run('read', '/repo/a.ts'),
        run('execute'),
      ]),
    ).toEqual({ parts: ['Ran 3 commands', 'read 2 files'], editAt: -1, failed: 0, running: false })
  })

  it('names the one file a run edited, and where its stats go', () => {
    expect(
      runSummary([
        { kind: 'thought', durationMs: 8_000 },
        run('edit', '/repo/docs/ui.md'),
        run('edit', '/repo/docs/ui.md'),
        run('search'),
      ]),
    ).toEqual({
      parts: ['Thought for 8 s', 'edited ui.md', 'searched once'],
      editAt: 1,
      failed: 0,
      running: false,
    })
  })

  it('counts failures and running steps', () => {
    const summary = runSummary([
      { ...run('execute'), status: 'failed' },
      { ...run('fetch'), status: 'in_progress' },
      run('other'),
      { kind: 'thought', streaming: true },
    ])
    expect(summary).toEqual({
      parts: ['Ran a command', 'fetched a page', 'used a tool', 'thought'],
      editAt: -1,
      failed: 1,
      running: true,
    })
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
