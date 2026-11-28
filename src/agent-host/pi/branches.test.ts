// Pi native session tree parsing and branch projection: JSONL parsing, bookmark labels, linear
// chain compression, fork points, active mid-chain leaves, multi-root trees and deep chains.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildPiBranches,
  extractLabels,
  parsePiSessionJsonl,
  readPiSessionEntries,
  resolveEffectiveLeaf,
} from './branches'
import type { PiEntry } from './protocol'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function userEntry(id: string, parentId: string | null, text: string, ts: string): PiEntry {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: ts,
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      timestamp: Date.parse(ts),
    },
  }
}

function assistantEntry(id: string, parentId: string | null, text: string, ts: string): PiEntry {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: ts,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      timestamp: Date.parse(ts),
      stopReason: 'stop',
    },
  }
}

describe('parsePiSessionJsonl and readPiSessionEntries', () => {
  it('parses multi-branch Pi JSONL files, skipping headers and malformed lines', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-pi-branches-'))
    dirs.push(dir)
    const file = path.join(dir, 'session.jsonl')
    const lines = [
      JSON.stringify({ type: 'session', version: 3, id: 'pi-1', cwd: '/work/app' }),
      JSON.stringify({
        type: 'model_change',
        id: 'm0',
        parentId: null,
        timestamp: '2026-11-20T10:00:00.000Z',
      }),
      JSON.stringify(userEntry('u1', 'm0', 'Start task', '2026-11-20T10:00:01.000Z')),
      JSON.stringify(assistantEntry('a1', 'u1', 'Done 1', '2026-11-20T10:00:02.000Z')),
      'not-valid-json',
      JSON.stringify(userEntry('u2a', 'a1', 'Branch A prompt', '2026-11-20T10:01:00.000Z')),
      JSON.stringify(assistantEntry('a2a', 'u2a', 'Reply A', '2026-11-20T10:01:05.000Z')),
      JSON.stringify(userEntry('u2b', 'a1', 'Branch B prompt', '2026-11-20T10:02:00.000Z')),
      JSON.stringify(assistantEntry('a2b', 'u2b', 'Reply B', '2026-11-20T10:02:05.000Z')),
    ]
    await writeFile(file, `${lines.join('\n')}\n`)

    const parsed = await readPiSessionEntries(file)
    expect(parsed.entries.map((entry) => entry.id)).toEqual([
      'm0',
      'u1',
      'a1',
      'u2a',
      'a2a',
      'u2b',
      'a2b',
    ])
    expect(parsed.leafId).toBe('a2b')
  })

  it('resolves latest native bookmark labels and clears empty ones', () => {
    const { entries } = parsePiSessionJsonl(
      [
        JSON.stringify(userEntry('u1', null, 'First', '2026-11-20T10:00:00.000Z')),
        JSON.stringify({ type: 'label', id: 'l1', parentId: 'u1', targetId: 'u1', label: 'v1' }),
        JSON.stringify({ type: 'label', id: 'l2', parentId: 'l1', targetId: 'u1', label: 'v2' }),
        JSON.stringify(userEntry('u2', 'l2', 'Second', '2026-11-20T10:01:00.000Z')),
        JSON.stringify({ type: 'label', id: 'l3', parentId: 'u2', targetId: 'u2', label: 'temp' }),
        JSON.stringify({ type: 'label', id: 'l4', parentId: 'l3', targetId: 'u2', label: '' }),
      ].join('\n'),
    )
    const labels = extractLabels(entries)
    expect(labels.get('u1')).toBe('v2')
    expect(labels.has('u2')).toBe(false)
  })

  it('prefers an explicit valid leaf over the file tail when resolving effective leaf', () => {
    const entries: PiEntry[] = [
      userEntry('u1', null, 'One', '2026-11-20T10:00:00.000Z'),
      assistantEntry('a1', 'u1', 'Reply 1', '2026-11-20T10:00:01.000Z'),
      assistantEntry('a2', 'u1', 'Reply 2', '2026-11-20T10:00:02.000Z'),
    ]
    expect(resolveEffectiveLeaf(entries, 'a2', 'a1')).toBe('a1')
    expect(resolveEffectiveLeaf(entries, 'a2', 'missing')).toBe('a2')
    expect(resolveEffectiveLeaf(entries, 'a2', null)).toBeNull()
    expect(resolveEffectiveLeaf(entries, 'missing', undefined)).toBe('a2')
  })
})

describe('buildPiBranches', () => {
  it('returns an empty tree for empty or metadata-only sessions', () => {
    expect(buildPiBranches([], null)).toEqual({
      activeLeafId: null,
      branchCount: 0,
      hasBranches: false,
      nodes: [],
    })
    const metaOnly: PiEntry[] = [
      { type: 'model_change', id: 'm0', parentId: null, timestamp: '2026-11-20T10:00:00.000Z' },
      {
        type: 'thinking_level_change',
        id: 't0',
        parentId: 'm0',
        timestamp: '2026-11-20T10:00:00.000Z',
      },
    ]
    expect(buildPiBranches(metaOnly, 't0')).toEqual({
      activeLeafId: 't0',
      branchCount: 0,
      hasBranches: false,
      nodes: [],
    })
  })

  it('compresses a linear session into one branch segment and splits when active leaf is mid-chain', () => {
    const entries: PiEntry[] = [
      { type: 'model_change', id: 'm0', parentId: null, timestamp: '2026-11-20T10:00:00.000Z' },
      userEntry('u1', 'm0', 'First prompt', '2026-11-20T10:00:01.000Z'),
      assistantEntry('a1', 'u1', 'First reply', '2026-11-20T10:00:02.000Z'),
      userEntry('u2', 'a1', 'Second prompt', '2026-11-20T10:00:03.000Z'),
      assistantEntry('a2', 'u2', 'Second reply', '2026-11-20T10:00:04.000Z'),
    ]

    const full = buildPiBranches(entries, 'a2')
    expect(full.activeLeafId).toBe('a2')
    expect(full.branchCount).toBe(1)
    expect(full.hasBranches).toBe(false)
    expect(full.nodes).toMatchObject([
      {
        id: 'a2',
        parentId: null,
        preview: 'First prompt',
        previewRole: 'user',
        turnCount: 2,
        depth: 0,
        isLeaf: true,
        isCurrent: true,
        onActivePath: true,
      },
    ])

    // Navigating back to a mid-chain node keeps both the active ancestor and downstream continuation visible.
    const mid = buildPiBranches(entries, 'a1')
    expect(mid.activeLeafId).toBe('a1')
    expect(mid.branchCount).toBe(1)
    expect(mid.nodes).toMatchObject([
      {
        id: 'a1',
        parentId: null,
        preview: 'First prompt',
        turnCount: 1,
        depth: 0,
        isLeaf: false,
        isCurrent: true,
        onActivePath: true,
      },
      {
        id: 'a2',
        parentId: 'a1',
        preview: 'Second prompt',
        turnCount: 1,
        depth: 1,
        isLeaf: true,
        isCurrent: false,
        onActivePath: false,
      },
    ])
  })

  it('projects nested branches, labels, and active path accurately', () => {
    const entries: PiEntry[] = [
      { type: 'model_change', id: 'm0', parentId: null, timestamp: '2026-11-20T10:00:00.000Z' },
      userEntry('u1', 'm0', 'Initial architecture', '2026-11-20T10:00:01.000Z'),
      assistantEntry('a1', 'u1', 'Proposed plan', '2026-11-20T10:00:02.000Z'),
      // Branch A
      userEntry('u2a', 'a1', 'Try OAuth flow', '2026-11-20T10:01:00.000Z'),
      assistantEntry('a2a', 'u2a', 'OAuth implemented', '2026-11-20T10:01:05.000Z'),
      // Branch B (further forks into B1 and B2)
      userEntry('u2b', 'a1', 'Use cookie sessions', '2026-11-20T10:02:00.000Z'),
      assistantEntry('a2b', 'u2b', 'Cookie session ready', '2026-11-20T10:02:05.000Z'),
      {
        type: 'label',
        id: 'lbl-b',
        parentId: 'a2b',
        timestamp: '2026-11-20T10:02:06.000Z',
        targetId: 'a2b',
        label: 'cookie-base',
      },
      userEntry('u3b1', 'lbl-b', 'Add refresh rotation', '2026-11-20T10:03:00.000Z'),
      assistantEntry('a3b1', 'u3b1', 'Rotation done', '2026-11-20T10:03:05.000Z'),
      userEntry('u3b2', 'lbl-b', 'Keep stateless token', '2026-11-20T10:04:00.000Z'),
      assistantEntry('a3b2', 'u3b2', 'Stateless done', '2026-11-20T10:04:05.000Z'),
    ]

    const result = buildPiBranches(entries, 'a3b1')
    expect(result.activeLeafId).toBe('a3b1')
    expect(result.branchCount).toBe(3)
    expect(result.hasBranches).toBe(true)
    expect(result.nodes).toMatchObject([
      {
        id: 'a1',
        parentId: null,
        preview: 'Initial architecture',
        turnCount: 1,
        depth: 0,
        isLeaf: false,
        isCurrent: false,
        onActivePath: true,
      },
      {
        id: 'a2a',
        parentId: 'a1',
        preview: 'Try OAuth flow',
        turnCount: 1,
        depth: 1,
        isLeaf: true,
        isCurrent: false,
        onActivePath: false,
      },
      {
        id: 'lbl-b',
        parentId: 'a1',
        label: 'cookie-base',
        preview: 'Use cookie sessions',
        turnCount: 1,
        depth: 1,
        isLeaf: false,
        isCurrent: false,
        onActivePath: true,
      },
      {
        id: 'a3b1',
        parentId: 'lbl-b',
        preview: 'Add refresh rotation',
        turnCount: 1,
        depth: 2,
        isLeaf: true,
        isCurrent: true,
        onActivePath: true,
      },
      {
        id: 'a3b2',
        parentId: 'lbl-b',
        preview: 'Keep stateless token',
        turnCount: 1,
        depth: 2,
        isLeaf: true,
        isCurrent: false,
        onActivePath: false,
      },
    ])
  })

  it('unwraps a leading metadata-only fork root and supports multi-root trees', () => {
    const entries: PiEntry[] = [
      { type: 'model_change', id: 'm0', parentId: null, timestamp: '2026-11-20T10:00:00.000Z' },
      {
        type: 'thinking_level_change',
        id: 't0',
        parentId: 'm0',
        timestamp: '2026-11-20T10:00:00.000Z',
      },
      userEntry('u1a', 't0', 'First attempt', '2026-11-20T10:00:01.000Z'),
      assistantEntry('a1a', 'u1a', 'Reply A', '2026-11-20T10:00:02.000Z'),
      userEntry('u1b', 't0', 'Second attempt', '2026-11-20T10:01:01.000Z'),
      assistantEntry('a1b', 'u1b', 'Reply B', '2026-11-20T10:01:02.000Z'),
    ]

    const unwrapped = buildPiBranches(entries, 'a1b')
    expect(unwrapped.branchCount).toBe(2)
    expect(unwrapped.hasBranches).toBe(true)
    expect(unwrapped.nodes).toMatchObject([
      { id: 'a1a', parentId: null, depth: 0, preview: 'First attempt', isCurrent: false },
      { id: 'a1b', parentId: null, depth: 0, preview: 'Second attempt', isCurrent: true },
    ])

    const multiRoot: PiEntry[] = [
      userEntry('r1', null, 'Root branch 1', '2026-11-20T10:00:01.000Z'),
      assistantEntry('ra1', 'r1', 'Done 1', '2026-11-20T10:00:02.000Z'),
      userEntry('r2', null, 'Root branch 2', '2026-11-20T10:01:01.000Z'),
      assistantEntry('ra2', 'r2', 'Done 2', '2026-11-20T10:01:02.000Z'),
    ]
    const roots = buildPiBranches(multiRoot, 'ra1')
    expect(roots.branchCount).toBe(2)
    expect(roots.hasBranches).toBe(true)
    expect(roots.nodes).toMatchObject([
      { id: 'ra1', parentId: null, depth: 0, isCurrent: true },
      { id: 'ra2', parentId: null, depth: 0, isCurrent: false },
    ])
  })

  it('handles deep linear chains iteratively without overflowing the call stack', () => {
    const entries: PiEntry[] = []
    let parentId: string | null = null
    for (let i = 0; i < 4000; i++) {
      const id = `e-${i}`
      entries.push(
        i % 2 === 0
          ? userEntry(id, parentId, `Prompt ${i}`, '2026-11-20T10:00:00.000Z')
          : assistantEntry(id, parentId, `Reply ${i}`, '2026-11-20T10:00:00.000Z'),
      )
      parentId = id
    }
    const result = buildPiBranches(entries, parentId)
    expect(result.branchCount).toBe(1)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0]).toMatchObject({
      id: 'e-3999',
      turnCount: 2000,
      isCurrent: true,
    })
  })
})
