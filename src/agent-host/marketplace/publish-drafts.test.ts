import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PublishManifest } from '@shared/market-publish'
import { PublishDrafts, parsePublishDraftsFile } from './publish-drafts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'kettu-publish-drafts-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const log = () => {}
const MANIFEST: PublishManifest = {
  slug: 'changelog-writer',
  name: 'Changelog writer',
  kind: 'skill',
  description: 'One line per change.',
  version: '1.0.0',
}

describe('parsePublishDraftsFile', () => {
  it('reads a file from before origins were kept as having none', () => {
    expect(parsePublishDraftsFile({ version: 1, drafts: [] })).toEqual({
      version: 1,
      drafts: [],
      origins: {},
    })
  })

  it('keeps only origins of a listing id with a path and session ids by version', () => {
    const parsed = parsePublishDraftsFile({
      version: 1,
      drafts: [],
      origins: {
        abcdefgh23: { path: '/repo/skills/x', sessions: { '1.0.0': 's1', '1.1.0': 7 } },
        'not-an-id': { path: '/repo/y', sessions: {} },
        bcdefghi23: { path: 3, sessions: {} },
        cdefghij23: { path: '/repo/z' },
      },
    })
    expect(parsed).toEqual({
      version: 1,
      drafts: [],
      origins: {
        abcdefgh23: { path: '/repo/skills/x', sessions: { '1.0.0': 's1' } },
        cdefghij23: { path: '/repo/z', sessions: {} },
      },
    })
  })
})

describe('PublishDrafts', () => {
  it('records where a listing was published from and by which session, and forgets it', async () => {
    const file = path.join(root, 'state', 'market-drafts.json')
    const drafts = new PublishDrafts(root, log)
    await drafts.put({
      path: '/repo/skills/x',
      manifest: MANIFEST,
      listingId: null,
      sessionId: 's1',
      sessionTitle: 'Publish it',
      agentId: 'claude-code',
      error: null,
    })
    await drafts.published('/repo/skills/x', {
      listingId: 'abcdefgh23',
      version: '1.0.0',
      sessionId: 's1',
      path: '/repo/skills/x',
    })
    await drafts.published('/private/repo/skills/x-renamed', {
      listingId: 'abcdefgh23',
      version: '1.0.1',
      sessionId: null,
      path: '/repo/skills/x-renamed',
    })
    expect(drafts.list()).toEqual([])
    expect(drafts.origins()).toEqual({
      abcdefgh23: { path: '/repo/skills/x-renamed', sessions: { '1.0.0': 's1' } },
    })
    await drafts.flush()
    const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    expect(saved.origins).toEqual(drafts.origins())

    const again = new PublishDrafts(root, log)
    await again.ready
    expect(again.origins()).toEqual(drafts.origins())
    await again.forget('abcdefgh23')
    expect(again.origins()).toEqual({})
  })
})
