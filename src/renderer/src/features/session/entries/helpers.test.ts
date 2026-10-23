import { describe, expect, it } from 'vitest'
import type { ToolEntry } from '@shared/thread'
import {
  forkEntry,
  groupLabel,
  runSummary,
  stopReasonText,
  toolLabel,
  toolStep,
  type RunStep,
} from './helpers'

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
  const lookup = (kind: 'read' | 'search' | 'fetch', path?: string) => ({
    kind: 'tool' as const,
    toolKind: kind,
    status: 'completed' as const,
    path,
  })

  it('names the files a run of lookups read and counts the rest', () => {
    expect(groupLabel([lookup('read', '/repo/a.ts'), lookup('read', '/repo/b.ts')])).toBe(
      'Read a.ts, b.ts',
    )
    expect(groupLabel([lookup('search'), lookup('search'), lookup('search')])).toBe(
      'Searched 3 times',
    )
    expect(
      groupLabel([lookup('read', '/repo/a.ts'), lookup('search'), lookup('read'), lookup('fetch')]),
    ).toBe('Read a.ts and 1 more · Searched once · Fetched a page')
  })
})

describe('runSummary', () => {
  const run = (
    kind: string,
    path?: string,
    extra: Partial<Extract<RunStep, { kind: 'tool' }>> = {},
  ) => ({
    kind: 'tool' as const,
    toolKind: kind as 'read',
    status: 'completed' as const,
    path,
    ...extra,
  })
  const text = (steps: RunStep[]) => runSummary(steps).parts.map((p) => p.text)
  const diff = (path: string, oldText: string | null) =>
    ({ type: 'diff', path, oldText, newText: 'x\n' }) as const

  it('gives each kind a part in the order it first appears', () => {
    expect(
      runSummary([
        run('execute'),
        run('read', '/repo/a.ts'),
        run('execute'),
        run('read', '/repo/b.ts'),
        run('read', '/repo/a.ts'),
        run('execute'),
      ]),
    ).toEqual({
      parts: [{ text: 'Ran 3 commands' }, { text: 'Read a.ts, b.ts' }],
      failed: 0,
      running: false,
    })
  })

  it('names up to two files and counts the rest', () => {
    const reads = ['README.md', 'plan.md', '01.md', '02.md', '03.md'].map((name) =>
      run('read', `/repo/docs/${name}`),
    )
    expect(text(reads)).toEqual(['Read README.md, plan.md and 3 more'])
    expect(text([run('read', '/repo/a.ts'), run('read')])).toEqual(['Read a.ts and 1 more'])
    expect(text([run('read'), run('read')])).toEqual(['Read 2 files'])
    expect(text([run('delete', '/repo/old.ts'), run('move', '/repo/x.ts')])).toEqual([
      'Deleted old.ts',
      'Moved x.ts',
    ])
  })

  it('says Created for an edit that creates its file, with the diffs that follow each', () => {
    const created = diff('/repo/offload.py', null)
    const later = diff('/repo/offload.py', 'x\n')
    const edited = diff('/repo/docs/ui.md', 'a\n')
    expect(
      runSummary([
        { kind: 'thought', durationMs: 8_000 },
        run('edit', '/repo/offload.py', { content: [created] }),
        run('edit', '/repo/docs/ui.md', { content: [edited] }),
        run('edit', '/repo/offload.py', { content: [later] }),
        run('search'),
      ]),
    ).toEqual({
      parts: [
        { text: 'Thought for 8 s' },
        { text: 'Created offload.py', diffs: [created, later] },
        { text: 'Edited ui.md', diffs: [edited] },
        { text: 'Searched once' },
      ],
      failed: 0,
      running: false,
    })
  })

  it('names one command by its description', () => {
    expect(
      text([
        run('execute', undefined, { description: 'Reran CPU content diff with full key map' }),
      ]),
    ).toEqual(['Reran CPU content diff with full key map'])
    expect(text([run('execute')])).toEqual(['Ran a command'])
  })

  it("counts several commands, then names the latest one's description", () => {
    expect(
      text([
        run('execute', undefined, { description: 'List the store jobs' }),
        run('execute'),
        run('execute', undefined, { description: 'Locate store job builders in vLLM' }),
      ]),
    ).toEqual(['Ran 3 commands', 'Locate store job builders in vLLM'])
    expect(
      text([run('execute', undefined, { description: 'List the store jobs' }), run('execute')]),
    ).toEqual(['Ran 2 commands'])
  })

  it('counts failures and running steps', () => {
    const summary = runSummary([
      { ...run('execute'), status: 'failed' },
      { ...run('fetch'), status: 'in_progress' },
      run('other'),
      { kind: 'thought', streaming: true },
    ])
    expect(summary).toEqual({
      parts: [
        { text: 'Ran a command' },
        { text: 'Fetched a page' },
        { text: 'Used a tool' },
        { text: 'Thought' },
      ],
      failed: 1,
      running: true,
    })
  })

  it('names plan updates and compactions once', () => {
    expect(
      text([
        { kind: 'plan' },
        run('execute'),
        { kind: 'plan' },
        { kind: 'compaction', running: true },
      ]),
    ).toEqual(['Updated the plan', 'Ran a command', 'Compacted the context'])
  })
})

describe('toolStep', () => {
  const tool: ToolEntry = {
    kind: 'tool',
    id: 't:1',
    title: 'Edit',
    toolKind: 'edit',
    status: 'completed',
    content: [{ type: 'diff', path: '/repo/a.ts', oldText: null, newText: 'x' }],
    locations: [{ path: '/repo/a.ts' }],
    permission: null,
    permissionResult: null,
  }

  it("keeps an edit's diffs and a command's description", () => {
    expect(toolStep(tool)).toEqual({
      kind: 'tool',
      toolKind: 'edit',
      status: 'completed',
      path: '/repo/a.ts',
      content: tool.content,
    })
    expect(
      toolStep({
        ...tool,
        toolKind: 'execute',
        locations: [],
        content: [{ type: 'markdown', markdown: 'ok' }],
        description: 'Run the tests',
      }),
    ).toEqual({
      kind: 'tool',
      toolKind: 'execute',
      status: 'completed',
      description: 'Run the tests',
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

describe('forkEntry', () => {
  const both = { forkSession: true, forkAtMessage: true }
  const wholeOnly = { forkSession: true, forkAtMessage: false }
  const reply = (latest: boolean, agentIds = ['m:msg_1', 'm:msg_2']) => ({ latest, agentIds })

  it("forks at the reply's last message", () => {
    expect(forkEntry(reply(true), both)).toBe('m:msg_2')
    expect(forkEntry(reply(false), both)).toBe('m:msg_2')
  })

  it('offers an earlier reply only to an agent that forks at a message', () => {
    expect(forkEntry(reply(true), wholeOnly)).toBe('m:msg_2')
    expect(forkEntry(reply(false), wholeOnly)).toBeNull()
  })

  it('needs a message the agent gave an id under an earlier reply', () => {
    expect(forkEntry(reply(false, ['m:msg_1', 'e:12']), both)).toBeNull()
    expect(forkEntry(reply(true, ['e:12']), both)).toBe('e:12')
  })

  it('offers nothing without session/fork', () => {
    expect(forkEntry(reply(true), { forkSession: false, forkAtMessage: false })).toBeNull()
    expect(forkEntry(reply(true), undefined)).toBeNull()
  })
})
