import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const rm = vi.hoisted(() => vi.fn())
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  rm.mockImplementation(actual.rm)
  return { ...actual, rm }
})

const { removeTree } = await import('./adapter-install')

describe('removeTree', () => {
  it('retries a file held open, as Windows does after npm writes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-remove-'))
    await writeFile(path.join(dir, 'index.js'), '')
    await removeTree(dir)
    expect(rm).toHaveBeenCalledWith(
      dir,
      expect.objectContaining({ maxRetries: 5, recursive: true }),
    )
  })
})
