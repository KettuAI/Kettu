import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  diffPathOf,
  hasToolDigest,
  isDiffContentItem,
  type DigestedToolEntry,
  type ThreadEntry,
  type ToolEntry,
} from '@shared/thread'
import { turnChanges } from '../turn-work'
import { cachedStats, diffsSettled } from './use-diff-stats'
import { changedFiles } from '../../tray/model'

function digestedEdit(
  id: string,
  path: string,
  added: number | null,
  removed: number | null,
): ToolEntry {
  const entry: DigestedToolEntry = {
    kind: 'tool',
    id,
    title: `Edit ${path}`,
    toolKind: 'edit',
    status: 'completed',
    content: [{ type: 'digest', of: 'diff', path, size: 16_000, added, removed }],
    locations: [{ path }],
    permission: null,
    permissionResult: null,
    rawInputDigest: { size: 4_000, lines: 50 },
  }
  return entry as unknown as ToolEntry
}

describe('tool digest compatibility across thread UI helpers', () => {
  let toolStep: typeof import('./helpers').toolStep
  let toolHasBody: typeof import('./tool-call-model').toolHasBody

  beforeAll(async () => {
    vi.stubGlobal('window', {
      kettu: {
        platform: 'darwin',
        client: 'web',
        hostPlatform: () => 'darwin',
      },
      matchMedia: () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    })
    ;({ toolStep } = await import('./helpers'))
    ;({ toolHasBody } = await import('./tool-call-model'))
  }, 20_000)

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it('recognizes digested diffs, counts stats without a worker, and tracks entry ids', () => {
    const entry = digestedEdit('t1', 'src/app.ts', 14, 3)
    expect(hasToolDigest(entry)).toBe(true)
    expect(toolHasBody(entry, '/proj')).toBe(true)

    const changes = turnChanges([entry])
    expect(changes).toHaveLength(1)
    expect(changes[0]!.path).toBe('src/app.ts')
    expect(changes[0]!.entryIds).toEqual(['t1'])
    expect(diffsSettled(changes[0]!.diffs)).toBe(true)
    expect(cachedStats(changes[0]!.diffs)).toEqual({ insertions: 14, deletions: 3 })

    const step = toolStep(entry)
    expect(step.kind).toBe('tool')
    if (step.kind === 'tool') {
      expect(step.paths).toEqual(['src/app.ts'])
      expect(step.diffs).toHaveLength(1)
      expect(isDiffContentItem(step.diffs![0]!)).toBe(true)
      expect(diffPathOf(step.diffs![0]!)).toBe('src/app.ts')
    }

    expect(changedFiles([entry as ThreadEntry])).toBe(1)
  })

  it('treats oversized digested diffs with null counts as settled without blocking cards', () => {
    const entry = digestedEdit('t2', 'src/generated.ts', null, null)
    const changes = turnChanges([entry])
    expect(diffsSettled(changes[0]!.diffs)).toBe(true)
    expect(cachedStats(changes[0]!.diffs)).toBeNull()
  })
})
