import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CONTENT_MISSING } from '@shared/artifacts'
import { ArtifactStore, type FoundVersion } from './store'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('reading a version whose stored file is gone', () => {
  // Reading again cannot bring the file back, so the error says so instead of failing as any read.
  it('fails as content missing', async () => {
    const contentDir = await mkdtemp(path.join(tmpdir(), 'kettu-content-'))
    dirs.push(contentDir)
    const store = new ArtifactStore({
      threads: null,
      contentDir,
      log: () => {},
      changed: () => {},
      version: () => {},
      activity: () => {},
    })
    const file = { path: 'index.html', hash: 'a'.repeat(64), size: 10 }
    const found = {
      artifact: { id: 'art_1' },
      version: { version: 2 },
      files: [file],
      type: null,
    } as unknown as FoundVersion
    await expect(store.bytes(found, file)).rejects.toMatchObject({
      code: 'internal',
      data: { reason: CONTENT_MISSING },
    })
  })
})
