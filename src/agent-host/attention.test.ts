import { describe, expect, it } from 'vitest'
import type { ThreadEntry, ThreadState, ToolEntry } from '@shared/thread'
import { allowOnceOption, changedFiles, replySummary, requestText } from './attention'

function tool(changes: Partial<ToolEntry>): ToolEntry {
  return {
    kind: 'tool',
    id: 't:1',
    title: 'Tool',
    toolKind: 'other',
    status: 'pending',
    content: [],
    locations: [],
    permission: null,
    permissionResult: null,
    ...changes,
  }
}

function thread(entries: ThreadEntry[]): ThreadState {
  return {
    session: {} as ThreadState['session'],
    order: entries.map((e) => e.id),
    byId: Object.fromEntries(entries.map((e) => [e.id, e])),
  }
}

const agent = (id: string, markdown: string): ThreadEntry => ({
  kind: 'agent',
  id,
  markdown,
  attachments: [],
  streaming: false,
})

describe('requestText', () => {
  it('says what the agent wants to do', () => {
    expect(
      requestText(
        tool({ toolKind: 'execute', title: 'Run', rawInput: 'pnpm vitest run src/usage\nmore' }),
        '/p',
      ),
    ).toBe('Wants to run pnpm vitest run src/usage')
    expect(
      requestText(tool({ toolKind: 'edit', locations: [{ path: '/p/src/a.ts' }] }), '/p'),
    ).toBe('Wants to edit src/a.ts')
    expect(
      requestText(tool({ toolKind: 'delete', locations: [{ path: '/elsewhere/b' }] }), '/p'),
    ).toBe('Wants to delete /elsewhere/b')
    expect(requestText(tool({ question: 'Which one?' }), '/p')).toBe('Asks: Which one?')
    expect(requestText(tool({ title: 'mcp lookup' }), '/p')).toBe('Wants to use mcp lookup')
    expect(requestText(undefined, '/p')).toBe('Asks for permission')
  })
})

describe('allowOnceOption', () => {
  const options = [
    { id: 'always', name: 'Always', kind: 'allow_always' as const },
    { id: 'once', name: 'Once', kind: 'allow_once' as const },
  ]

  it("offers a request's one-time allowing, never a question's answer", () => {
    expect(allowOnceOption(tool({ toolKind: 'edit' }), options)).toBe('once')
    expect(allowOnceOption(tool({ toolKind: 'edit', question: 'Which?' }), options)).toBeNull()
    expect(allowOnceOption(tool({ toolKind: 'edit' }), [options[0]!])).toBeNull()
    expect(allowOnceOption(undefined, options)).toBeNull()
  })

  it('offers it only for what the notification shows in full', () => {
    const run = (rawInput: string) => tool({ toolKind: 'execute', title: 'Run', rawInput })
    expect(allowOnceOption(run('pnpm vitest run src/usage'), options)).toBe('once')
    expect(allowOnceOption(run('cd x\nrm -rf y'), options)).toBeNull()
    expect(allowOnceOption(run('pnpm test && rm -rf y'), options)).toBeNull()
    expect(allowOnceOption(run(`echo ${'x'.repeat(80)}`), options)).toBeNull()
    expect(allowOnceOption(tool({ toolKind: 'switch_mode' }), options)).toBeNull()
    expect(allowOnceOption(tool({ toolKind: 'other' }), options)).toBeNull()
  })
})

describe('replySummary', () => {
  it("gives the turn's reply as its first paragraph in plain text", () => {
    expect(
      replySummary(
        thread([
          { kind: 'user', id: 'u', content: [] },
          agent('a1', 'Looking.'),
          agent(
            'a2',
            '## Done\n\nHeatmap **added** and checked in the [browser](http://x). `2` files changed.\n\nMore.',
          ),
        ]),
      ),
    ).toBe('Heatmap added and checked in the browser. 2 files changed.')
    expect(
      replySummary(
        thread([agent('a', 'Heatmap **added** and checked in the [browser](http://x).\n\nMore.')]),
      ),
    ).toBe('Heatmap added and checked in the browser.')
  })

  it('finds none when the turn ended without a reply', () => {
    expect(
      replySummary(thread([agent('a', 'Earlier.'), { kind: 'user', id: 'u', content: [] }])),
    ).toBeNull()
    expect(replySummary(thread([agent('a', '```\ncode\n```')]))).toBeNull()
  })
})

describe('changedFiles', () => {
  const diff = (path: string) => ({ type: 'diff' as const, path, oldText: 'a', newText: 'b' })

  it("counts the files the turn's finished edits changed, each once", () => {
    expect(
      changedFiles(
        thread([
          tool({ id: 'old', status: 'completed', content: [diff('/p/earlier.ts')] }),
          { kind: 'user', id: 'u', content: [] },
          tool({ id: 'e1', status: 'completed', content: [diff('/p/a.ts')] }),
          tool({ id: 'e2', status: 'completed', content: [diff('/p/a.ts'), diff('/p/b.ts')] }),
          tool({ id: 'e3', status: 'failed', content: [diff('/p/c.ts')] }),
          tool({ id: 'e4', status: 'pending', content: [diff('/p/d.ts')] }),
          agent('a', 'Done.'),
        ]),
      ),
    ).toBe(2)
  })

  it('finds none in a turn without edits', () => {
    expect(changedFiles(thread([{ kind: 'user', id: 'u', content: [] }, agent('a', 'Hi.')]))).toBe(
      0,
    )
  })
})
