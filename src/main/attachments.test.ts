import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AttachmentGrant } from '@shared/attachments'
import { grantPaths } from './attachments'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'overbench-grants-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('grantPaths', () => {
  it('grants files and folders, and hands the host the paths the renderer never sees', async () => {
    const file = path.join(dir, 'notes.md')
    const folder = path.join(dir, 'src')
    await writeFile(file, '# Notes\n')
    await mkdir(folder)
    const handed: AttachmentGrant[][] = []
    const granted = await grantPaths([file, folder], async (grants) => {
      handed.push(grants)
    })
    expect(granted).toEqual([
      { grantId: expect.any(String), name: 'notes.md', kind: 'file', size: 8 },
      { grantId: expect.any(String), name: 'src', kind: 'folder', size: null },
    ])
    expect(handed).toEqual([
      [
        { grantId: granted[0]!.grantId, path: file, kind: 'file' },
        { grantId: granted[1]!.grantId, path: folder, kind: 'folder' },
      ],
    ])
    expect(JSON.stringify(granted)).not.toContain(dir)
  })

  it('keeps the order and leaves a gap for a path that is gone', async () => {
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'a')
    const handed: AttachmentGrant[] = []
    const granted = await grantPaths([path.join(dir, 'gone.txt'), file], async (grants) => {
      handed.push(...grants)
    })
    expect(granted[0]).toBeNull()
    expect(granted[1]).toMatchObject({ name: 'a.txt', kind: 'file' })
    expect(handed.map((grant) => grant.path)).toEqual([file])
  })

  it('grants nothing when the host does not take the grants', async () => {
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'a')
    await expect(
      grantPaths([file], () => Promise.reject(new Error('host down'))),
    ).rejects.toThrow('host down')
  })
})
