import { access, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolEntry } from '@shared/thread'
import { applyTurnUndo, previewTurnUndo } from './turn-undo'
import { tempFolder } from './testing/temp'

const dirs: string[] = []

async function makeWorkspace(): Promise<string> {
  const dir = await tempFolder('kettu-turn-undo-')
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

function tool(overrides: Partial<ToolEntry> & { id: string }): ToolEntry {
  return {
    kind: 'tool',
    title: 'Edit',
    toolKind: 'edit',
    status: 'completed',
    content: [],
    locations: [],
    permission: null,
    permissionResult: null,
    ...overrides,
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

describe('turn-undo engine', () => {
  it('reverts a single-file edit and preserves CRLF line endings', async () => {
    const root = await makeWorkspace()
    const file = path.join(root, 'a.ts')
    await writeFile(file, 'const a = 1\r\nconst b = 20\r\n', 'utf8')

    const entries = [
      tool({
        id: 't1',
        content: [{ type: 'diff', path: file, oldText: 'const b = 2', newText: 'const b = 20' }],
      }),
    ]

    const preview = await previewTurnUndo({ workRoot: root, entries, platform: process.platform })
    expect(preview.canApply).toBe(true)
    expect(preview.conflicts).toEqual([])
    expect(preview.affectedFiles).toHaveLength(1)
    expect(preview.affectedFiles[0]).toMatchObject({
      path: 'a.ts',
      action: 'revert',
      status: 'ready',
      beforeText: 'const a = 1\nconst b = 20\n',
      afterText: 'const a = 1\nconst b = 2\n',
      editCount: 1,
    })

    const applied = await applyTurnUndo({
      workRoot: root,
      entries,
      expectedDigests: preview.fileDigests,
      platform: process.platform,
    })
    expect(applied).toEqual({
      status: 'applied',
      revertedFiles: ['a.ts'],
      deletedFiles: [],
      restoredFiles: [],
    })
    expect(await readFile(file, 'utf8')).toBe('const a = 1\r\nconst b = 2\r\n')
  })

  it('reverses multiple edits to the same file in strict reverse chronological order', async () => {
    const root = await makeWorkspace()
    const file = path.join(root, 'chain.ts')
    // Turn changed: v1 -> v2 -> v3
    await writeFile(file, 'export const version = "v3"\n', 'utf8')

    const entries = [
      tool({
        id: 't1',
        content: [
          {
            type: 'diff',
            path: file,
            oldText: 'export const version = "v1"',
            newText: 'export const version = "v2"',
          },
        ],
      }),
      tool({
        id: 't2',
        content: [
          {
            type: 'diff',
            path: 'chain.ts',
            oldText: 'export const version = "v2"',
            newText: 'export const version = "v3"',
          },
        ],
      }),
    ]

    const preview = await previewTurnUndo({ workRoot: root, entries, platform: process.platform })
    expect(preview.canApply).toBe(true)
    expect(preview.affectedFiles[0]).toMatchObject({
      path: 'chain.ts',
      action: 'revert',
      status: 'ready',
      afterText: 'export const version = "v1"\n',
      editCount: 2,
    })

    const result = await applyTurnUndo({
      workRoot: root,
      entries,
      expectedDigests: preview.fileDigests,
      platform: process.platform,
    })
    expect(result.status).toBe('applied')
    expect(await readFile(file, 'utf8')).toBe('export const version = "v1"\n')
  })

  it('undoes a multi-file turn with edit, create (delete), and delete (restore) atomically', async () => {
    const root = await makeWorkspace()
    const edited = path.join(root, 'src', 'app.ts')
    const created = path.join(root, 'src', 'new.ts')
    const deleted = path.join(root, 'old', 'nested', 'gone.ts')

    await mkdir(path.join(root, 'src'), { recursive: true })
    await writeFile(edited, 'export const name = "after"\n', 'utf8')
    await writeFile(created, 'export const fresh = 2\n', 'utf8')

    const entries = [
      tool({
        id: 't1',
        content: [
          {
            type: 'diff',
            path: edited,
            oldText: 'export const name = "before"',
            newText: 'export const name = "after"',
          },
        ],
      }),
      // Created then edited in the same turn -> undo should delete the file.
      tool({
        id: 't2',
        content: [
          { type: 'diff', path: created, oldText: null, newText: 'export const fresh = 1\n' },
        ],
      }),
      tool({
        id: 't3',
        content: [
          {
            type: 'diff',
            path: created,
            oldText: 'export const fresh = 1',
            newText: 'export const fresh = 2',
          },
        ],
      }),
      tool({
        id: 't4',
        toolKind: 'delete',
        content: [
          { type: 'diff', path: deleted, oldText: 'export const restored = true\n', newText: '' },
        ],
      }),
    ]

    const preview = await previewTurnUndo({ workRoot: root, entries, platform: process.platform })
    expect(preview.canApply).toBe(true)
    expect(preview.affectedFiles.map((f) => [f.path, f.action, f.status])).toEqual([
      ['src/app.ts', 'revert', 'ready'],
      ['src/new.ts', 'delete', 'ready'],
      ['old/nested/gone.ts', 'restore', 'ready'],
    ])

    const result = await applyTurnUndo({
      workRoot: root,
      entries,
      expectedDigests: preview.fileDigests,
      platform: process.platform,
    })
    expect(result).toEqual({
      status: 'applied',
      revertedFiles: ['src/app.ts'],
      deletedFiles: ['src/new.ts'],
      restoredFiles: ['old/nested/gone.ts'],
    })
    expect(await readFile(edited, 'utf8')).toBe('export const name = "before"\n')
    expect(await exists(created)).toBe(false)
    expect(await readFile(deleted, 'utf8')).toBe('export const restored = true\n')
  })

  it('reverses whole-file writes cleanly when a later edit touched unrelated lines', async () => {
    const root = await makeWorkspace()
    const file = path.join(root, 'lines.txt')
    const beforeTurn =
      ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10'].join('\n') + '\n'
    const afterTurn1 =
      ['L1', 'L2-turn1', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10'].join('\n') + '\n'
    const afterTurn2 =
      ['L1', 'L2-turn1', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10-turn2'].join('\n') + '\n'
    await writeFile(file, afterTurn2, 'utf8')

    const entries = [
      tool({
        id: 't1',
        content: [{ type: 'diff', path: file, oldText: beforeTurn, newText: afterTurn1 }],
      }),
    ]

    const preview = await previewTurnUndo({ workRoot: root, entries, platform: process.platform })
    expect(preview.canApply).toBe(true)
    const result = await applyTurnUndo({
      workRoot: root,
      entries,
      expectedDigests: preview.fileDigests,
      platform: process.platform,
    })
    expect(result.status).toBe('applied')
    expect(await readFile(file, 'utf8')).toBe(
      ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10-turn2'].join('\n') + '\n',
    )
  })

  it('writes zero files when any file in a multi-file turn conflicts with later edits', async () => {
    const root = await makeWorkspace()
    const cleanFile = path.join(root, 'clean.ts')
    const conflictedFile = path.join(root, 'conflict.ts')
    await writeFile(cleanFile, 'export const ok = 2\n', 'utf8')
    await writeFile(conflictedFile, 'export const value = "later-edit"\n', 'utf8')

    const entries = [
      tool({
        id: 't1',
        content: [
          {
            type: 'diff',
            path: cleanFile,
            oldText: 'export const ok = 1',
            newText: 'export const ok = 2',
          },
          {
            type: 'diff',
            path: conflictedFile,
            oldText: 'export const value = "orig"',
            newText: 'export const value = "turn1"',
          },
        ],
      }),
    ]

    const preview = await previewTurnUndo({ workRoot: root, entries, platform: process.platform })
    expect(preview.canApply).toBe(false)
    expect(preview.conflicts).toEqual([{ path: 'conflict.ts', reason: 'content_mismatch' }])

    const result = await applyTurnUndo({
      workRoot: root,
      entries,
      expectedDigests: preview.fileDigests,
      platform: process.platform,
    })
    expect(result.status).toBe('conflict')
    // Zero partial writes: the clean file remains untouched on disk.
    expect(await readFile(cleanFile, 'utf8')).toBe('export const ok = 2\n')
    expect(await readFile(conflictedFile, 'utf8')).toBe('export const value = "later-edit"\n')
  })

  it('detects ambiguous matches, modified new files, and restored-path collisions as conflicts', async () => {
    const root = await makeWorkspace()
    const dupFile = path.join(root, 'dup.ts')
    const newFile = path.join(root, 'created.ts')
    const recreatedFile = path.join(root, 'deleted.ts')
    await writeFile(dupFile, 'const x = 2\nconst x = 2\n', 'utf8')
    await writeFile(newFile, 'created\nlater addition\n', 'utf8')
    await writeFile(recreatedFile, 'recreated by user\n', 'utf8')

    const entries = [
      tool({
        id: 't1',
        content: [{ type: 'diff', path: dupFile, oldText: 'const x = 1', newText: 'const x = 2' }],
      }),
      tool({
        id: 't2',
        content: [{ type: 'diff', path: newFile, oldText: null, newText: 'created\n' }],
      }),
      tool({
        id: 't3',
        toolKind: 'delete',
        content: [{ type: 'diff', path: recreatedFile, oldText: 'old content\n', newText: '' }],
      }),
    ]

    const preview = await previewTurnUndo({ workRoot: root, entries, platform: process.platform })
    expect(preview.canApply).toBe(false)
    expect(preview.conflicts).toEqual([
      { path: 'dup.ts', reason: 'ambiguous_match' },
      { path: 'created.ts', reason: 'modified_after_turn' },
      { path: 'deleted.ts', reason: 'file_already_exists' },
    ])
  })

  it('detects stale files modified after preview opened, writes nothing, and returns fresh re-verification', async () => {
    const root = await makeWorkspace()
    const fileA = path.join(root, 'a.ts')
    const fileB = path.join(root, 'b.ts')
    await writeFile(fileA, 'const a = 2\n', 'utf8')
    await writeFile(fileB, 'const b = 2\nconst extra = 0\n', 'utf8')

    const entries = [
      tool({
        id: 't1',
        content: [
          { type: 'diff', path: fileA, oldText: 'const a = 1', newText: 'const a = 2' },
          { type: 'diff', path: fileB, oldText: 'const b = 1', newText: 'const b = 2' },
        ],
      }),
    ]

    const preview = await previewTurnUndo({ workRoot: root, entries, platform: process.platform })
    expect(preview.canApply).toBe(true)

    // User edits fileB after preview was generated (even on an unrelated line).
    await writeFile(fileB, 'const b = 2\nconst extra = 999\n', 'utf8')

    const stale = await applyTurnUndo({
      workRoot: root,
      entries,
      expectedDigests: preview.fileDigests,
      platform: process.platform,
    })
    expect(stale.status).toBe('stale')
    if (stale.status !== 'stale') throw new Error('expected stale')
    expect(stale.changedPaths).toEqual(['b.ts'])
    expect(stale.preview.canApply).toBe(true)
    // Nothing was written to disk on stale detection.
    expect(await readFile(fileA, 'utf8')).toBe('const a = 2\n')
    expect(await readFile(fileB, 'utf8')).toBe('const b = 2\nconst extra = 999\n')

    // Re-confirming with the fresh digests succeeds cleanly and preserves the unrelated edit.
    const applied = await applyTurnUndo({
      workRoot: root,
      entries,
      expectedDigests: stale.preview.fileDigests,
      platform: process.platform,
    })
    expect(applied.status).toBe('applied')
    expect(await readFile(fileA, 'utf8')).toBe('const a = 1\n')
    expect(await readFile(fileB, 'utf8')).toBe('const b = 1\nconst extra = 999\n')
  })

  it('blocks unsupported or insufficient before-snapshot edits without partial writes', async () => {
    const root = await makeWorkspace()
    const clean = path.join(root, 'clean.ts')
    const bulk = path.join(root, 'bulk.ts')
    await writeFile(clean, 'const ok = 2\n', 'utf8')
    await writeFile(bulk, 'bar bar\n', 'utf8')

    const entries = [
      tool({
        id: 't1',
        content: [{ type: 'diff', path: clean, oldText: 'const ok = 1', newText: 'const ok = 2' }],
      }),
      tool({
        id: 't2',
        toolKind: 'delete',
        locations: [{ path: path.join(root, 'no-snapshot.ts') }],
        content: [],
      }),
      tool({
        id: 't3',
        rawInput: JSON.stringify({
          file_path: bulk,
          old_string: 'foo',
          new_string: 'bar',
          replace_all: true,
        }),
        content: [{ type: 'diff', path: bulk, oldText: 'foo', newText: 'bar' }],
      }),
    ]

    const preview = await previewTurnUndo({ workRoot: root, entries, platform: process.platform })
    expect(preview.canApply).toBe(false)
    expect(preview.conflicts).toEqual([
      { path: 'no-snapshot.ts', reason: 'missing_before_snapshot' },
      { path: 'bulk.ts', reason: 'replace_all_unsupported' },
    ])

    const result = await applyTurnUndo({
      workRoot: root,
      entries,
      expectedDigests: preview.fileDigests,
      platform: process.platform,
    })
    expect(result.status).toBe('conflict')
    expect(await readFile(clean, 'utf8')).toBe('const ok = 2\n')
  })

  it('rejects workspace path traversal, .git paths, and symlink escapes', async () => {
    const root = await makeWorkspace()
    const outsideDir = await makeWorkspace()
    const outsideFile = path.join(outsideDir, 'secret.txt')
    await writeFile(outsideFile, 'secret-after\n', 'utf8')

    const fileLink = path.join(root, 'link.txt')
    await symlink(outsideFile, fileLink)

    const dirLink = path.join(root, 'escaped-dir')
    await symlink(outsideDir, dirLink)

    const entries = [
      tool({
        id: 't1',
        content: [
          { type: 'diff', path: '../outside.txt', oldText: 'a', newText: 'b' },
          { type: 'diff', path: outsideFile, oldText: 'secret-before', newText: 'secret-after' },
          { type: 'diff', path: path.join(root, '.git', 'config'), oldText: 'a', newText: 'b' },
          { type: 'diff', path: fileLink, oldText: 'secret-before', newText: 'secret-after' },
          {
            type: 'diff',
            path: path.join(dirLink, 'secret.txt'),
            oldText: 'secret-before',
            newText: 'secret-after',
          },
        ],
      }),
    ]

    const preview = await previewTurnUndo({ workRoot: root, entries, platform: process.platform })
    expect(preview.canApply).toBe(false)
    expect(preview.conflicts).toEqual([
      { path: '../outside.txt', reason: 'outside_workspace' },
      { path: outsideFile, reason: 'outside_workspace' },
      { path: path.join(root, '.git', 'config'), reason: 'outside_workspace' },
      { path: 'link.txt', reason: 'symlink_not_allowed' },
      { path: 'escaped-dir/secret.txt', reason: 'outside_workspace' },
    ])

    const result = await applyTurnUndo({
      workRoot: root,
      entries,
      expectedDigests: preview.fileDigests,
      platform: process.platform,
    })
    expect(result.status).toBe('conflict')
    expect(await readFile(outsideFile, 'utf8')).toBe('secret-after\n')
  })

  it('rolls back already-written files if an unexpected mid-write I/O error occurs', async () => {
    const root = await makeWorkspace()
    const first = path.join(root, 'first.ts')
    const second = path.join(root, 'second.ts')
    const created = path.join(root, 'created.ts')
    await writeFile(first, 'first-after\n', 'utf8')
    await writeFile(second, 'second-after\n', 'utf8')
    await writeFile(created, 'created-body\n', 'utf8')

    const entries = [
      tool({
        id: 't1',
        content: [
          { type: 'diff', path: first, oldText: 'first-before', newText: 'first-after' },
          { type: 'diff', path: created, oldText: null, newText: 'created-body\n' },
          { type: 'diff', path: second, oldText: 'second-before', newText: 'second-after' },
        ],
      }),
    ]

    const preview = await previewTurnUndo({ workRoot: root, entries, platform: process.platform })
    expect(preview.canApply).toBe(true)

    await expect(
      applyTurnUndo({
        workRoot: root,
        entries,
        expectedDigests: preview.fileDigests,
        platform: process.platform,
        beforeWrite: (relative) => {
          if (relative === 'second.ts') throw new Error('Simulated ENOSPC')
        },
      }),
    ).rejects.toThrow('Simulated ENOSPC')

    // Previously reverted and deleted files must be rolled back to their pre-apply contents.
    expect(await readFile(first, 'utf8')).toBe('first-after\n')
    expect(await readFile(created, 'utf8')).toBe('created-body\n')
    expect(await readFile(second, 'utf8')).toBe('second-after\n')
  })
})
