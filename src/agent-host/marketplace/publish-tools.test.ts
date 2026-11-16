import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONTROL_WAIT_MS } from '@shared/control'
import type {
  MarketAccount,
  MarketCall,
  MarketMine,
  MineListing,
  PublishDraft,
} from '@shared/market-publish'
import type { MarketPublishOutcome } from '@shared/thread'
import type { Caller } from '../artifacts/tools'
import type { NewDraft } from './publish-drafts'
import {
  lineChanges,
  MARKET_CHECK,
  MARKET_MINE,
  MARKET_PUBLISH,
  MARKET_UNLIST,
  MarketCallError,
  MarketTools,
  type MarketAnswer,
  type MarketAsk,
} from './publish-tools'

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'kettu-publish-tools-'))
  await mkdir(path.join(root, 'skills', 'changelog-writer'), { recursive: true })
  await writeFile(
    path.join(root, 'skills', 'changelog-writer', 'SKILL.md'),
    '---\nname: changelog-writer\ndescription: One line per change.\n---\n\nLine one\nLine two\n',
  )
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const ACCOUNT: MarketAccount = { name: 'Amigoer', email: 'a@example.com' }
const caller = (): Caller => ({ sessionId: 's1', project: root })

function listing(over: Partial<MineListing> = {}): MineListing {
  return {
    id: 'abcdefgh23',
    handle: 'amigoer',
    slug: 'changelog-writer',
    name: 'Changelog writer',
    kind: 'skill',
    description: 'One line per change.',
    visibility: 'public',
    official: false,
    current: '1.0.0',
    versions: [
      {
        version: '1.0.0',
        notes: '',
        status: 'live',
        bytes: 1,
        files: 1,
        checks: [],
        publishedAt: 'x',
      },
    ],
    installs: { total: 598, week: 10, days: [] },
    takenDown: null,
    createdAt: 'x',
    updatedAt: 'x',
    ...over,
  }
}

interface Harness {
  tools: MarketTools
  calls: MarketCall[]
  asks: MarketAsk[]
  outcomes: MarketPublishOutcome[]
  drafts: NewDraft[]
  /** Each version that reached the service, with its folder. */
  published: {
    folder: string
    listingId: string
    version: string
    sessionId: string | null
    path: string
  }[]
  /** Answers the card the tools are waiting on. */
  answer(answer: MarketAnswer): void
  account: { current: MarketAccount | null }
}

/** What the service answers a publish: the listing at the version sent. */
function publishedListing(call: MarketCall): unknown {
  if (call.kind !== 'publish') return null
  return listing({
    current: call.manifest.version,
    visibility: call.manifest.visibility ?? 'public',
  })
}

function harness(
  mine: MarketMine = { publisher: null, listings: [], storage: { bytes: 0, limit: 1 } },
  serve: (call: MarketCall) => unknown = publishedListing,
  kept: PublishDraft[] = [],
): Harness {
  const calls: MarketCall[] = []
  const asks: MarketAsk[] = []
  const outcomes: MarketPublishOutcome[] = []
  const drafts: NewDraft[] = []
  const published: Harness['published'] = []
  const account = { current: ACCOUNT as MarketAccount | null }
  let resolve: ((answer: MarketAnswer) => void) | null = null
  const tools = new MarketTools({
    account: () => account.current,
    call: (async (call: MarketCall) => {
      calls.push(call)
      if (call.kind === 'mine') return mine
      return serve(call)
    }) as never,
    ask: (_sessionId, ask) => {
      asks.push(ask)
      return {
        entryId: 'e1',
        answer: new Promise<MarketAnswer>((r) => {
          resolve = r
        }),
      }
    },
    settle: (_sessionId, _entryId, outcome) => outcomes.push(outcome),
    drafts: {
      put: async (draft) => {
        drafts.push(draft)
        return { ...draft, id: 'd', createdAt: 0, problems: [] } as PublishDraft
      },
      published: async (folder, version) => {
        if (version) published.push({ folder, ...version })
      },
      list: () => kept,
      origins: () => ({}),
      forget: async () => {},
    },
    changed: () => {},
    agentOf: () => 'claude-code',
    sessionTitle: () => 'Publish the changelog skill',
    home: os.homedir(),
  })
  return {
    tools,
    calls,
    asks,
    outcomes,
    drafts,
    published,
    account,
    answer: (answer) => resolve?.(answer),
  }
}

/** Waits until the call shows its card. */
async function asked(h: Harness): Promise<void> {
  for (let i = 0; i < 200 && h.asks.length === 0; i++) await new Promise((r) => setTimeout(r, 5))
  expect(h.asks).toHaveLength(1)
}

const uploads = (h: Harness) => h.calls.filter((call) => call.kind === 'publish')

describe('marketplace_publish', () => {
  it('uploads nothing before the user presses Publish', async () => {
    const h = harness()
    const call = h.tools.call(caller(), MARKET_PUBLISH, { path: 'skills/changelog-writer' })
    await asked(h)
    expect(h.asks[0]).toMatchObject({
      action: 'publish',
      item: { name: 'Changelog writer', slug: 'changelog-writer', kind: 'skill' },
      version: '1.0.0',
      previous: null,
      visibility: 'public',
      folder: 'skills/changelog-writer',
      files: [{ path: 'SKILL.md' }],
      publisher: { suggested: 'amigoer' },
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(uploads(h)).toEqual([])
    h.answer({ decision: 'confirm', visibility: 'private', notes: null })
    const result = await call
    expect(result.isError).toBeUndefined()
    expect(uploads(h)).toHaveLength(1)
    const upload = uploads(h)[0] as Extract<MarketCall, { kind: 'publish' }>
    expect(upload.manifest).toMatchObject({
      slug: 'changelog-writer',
      kind: 'skill',
      version: '1.0.0',
      visibility: 'private',
      agent: 'claude-code',
      session: 'Publish the changelog skill',
    })
    expect(upload.files.map((file) => file.path)).toEqual(['SKILL.md'])
    expect(h.outcomes).toEqual([expect.objectContaining({ kind: 'published', version: '1.0.0' })])
    expect(h.drafts).toEqual([])
  })

  it('uploads nothing on Not now, a timeout or the turn ending, and keeps a draft', async () => {
    for (const decision of ['later', 'expired', 'ended'] as const) {
      const h = harness()
      const call = h.tools.call(caller(), MARKET_PUBLISH, {
        path: 'skills/changelog-writer',
        notes: 'First version.',
      })
      await asked(h)
      h.answer({ decision })
      const result = await call
      expect(result.isError).toBeUndefined()
      expect(uploads(h)).toEqual([])
      expect(h.drafts).toEqual([
        expect.objectContaining({
          path: path.join(root, 'skills', 'changelog-writer'),
          sessionId: 's1',
          error: null,
          manifest: expect.objectContaining({ version: '1.0.0', notes: 'First version.' }),
        }),
      ])
    }
  })

  it('refuses a folder with a secret before any card or upload', async () => {
    await writeFile(
      path.join(root, 'skills', 'changelog-writer', 'notes.md'),
      `token ghp_${'aB3'.repeat(12)}\n`,
    )
    const h = harness()
    const result = await h.tools.call(caller(), MARKET_PUBLISH, { path: 'skills/changelog-writer' })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ code: 'not_ready' })
    expect(h.asks).toEqual([])
    expect(uploads(h)).toEqual([])
  })

  it('offers a skill’s next patch as a new version, with old → new and the changed lines', async () => {
    const old = 'Line one\nLine zero\n'
    const h = harness(
      {
        publisher: { handle: 'amigoer', since: 'x' },
        listings: [listing()],
        storage: { bytes: 0, limit: 1 },
      },
      (call) => {
        if (call.kind === 'version') {
          return {
            files: [
              { path: 'SKILL.md', size: old.length, sha256: 'other' },
              { path: 'gone.md', size: 1, sha256: 'x' },
            ],
          }
        }
        if (call.kind === 'file') return { data: Buffer.from(old).toString('base64'), sha256: null }
        return publishedListing(call)
      },
    )
    const call = h.tools.call(caller(), MARKET_PUBLISH, {
      path: path.join(root, 'skills', 'changelog-writer'),
      notes: 'Adds line two.',
    })
    await asked(h)
    expect(h.asks[0]).toMatchObject({
      listingId: 'abcdefgh23',
      version: '1.0.1',
      previous: '1.0.0',
      installs: 598,
      notes: 'Adds line two.',
      publisher: null,
    })
    const changes = h.asks[0]!.changes!
    expect(changes.find((c) => c.path === 'gone.md')).toMatchObject({ status: 'removed' })
    expect(changes.find((c) => c.path === 'SKILL.md')).toMatchObject({ status: 'changed' })
    h.answer({ decision: 'confirm', visibility: null, notes: 'Edited by the user.' })
    await call
    const upload = uploads(h)[0] as Extract<MarketCall, { kind: 'publish' }>
    expect(upload.manifest.version).toBe('1.0.1')
    expect(upload.manifest.notes).toBe('Edited by the user.')
    // A new version keeps its listing's visibility.
    expect(upload.manifest.visibility).toBeUndefined()
  })

  it('keeps a draft with the reason when the service refuses the upload', async () => {
    const h = harness(undefined, () => {
      throw new MarketCallError({
        code: 'check_failed',
        status: 422,
        message: 'Refused',
        problems: [{ message: 'Bad' }],
      })
    })
    const call = h.tools.call(caller(), MARKET_PUBLISH, { path: 'skills/changelog-writer' })
    await asked(h)
    h.answer({ decision: 'confirm', visibility: null, notes: null })
    const result = await call
    expect(result.isError).toBe(true)
    expect(h.outcomes).toEqual([
      { kind: 'failed', message: 'Refused', problems: [{ message: 'Bad' }] },
    ])
    expect(h.drafts).toEqual([
      expect.objectContaining({ error: 'Refused', problems: [{ message: 'Bad' }] }),
    ])
  })
})

describe('marketplace_unlist', () => {
  it('unlists only after the user confirms', async () => {
    const h = harness(
      {
        publisher: { handle: 'amigoer', since: 'x' },
        listings: [listing()],
        storage: { bytes: 0, limit: 1 },
      },
      () => listing({ visibility: 'unlisted' }),
    )
    const call = h.tools.call(caller(), MARKET_UNLIST, { listing: '@amigoer/changelog-writer' })
    await asked(h)
    expect(h.asks[0]).toMatchObject({ action: 'unlist', listingId: 'abcdefgh23', installs: 598 })
    expect(h.calls.filter((c) => c.kind === 'update')).toEqual([])
    h.answer({ decision: 'confirm', visibility: null, notes: null })
    await call
    expect(h.calls.filter((c) => c.kind === 'update')).toEqual([
      { kind: 'update', id: 'abcdefgh23', change: { visibility: 'unlisted' } },
    ])
    expect(h.outcomes).toEqual([{ kind: 'unlisted' }])
  })
})

describe('a card the user has not answered within one call', () => {
  // The clock moves with real time, so the folder checks and polls still run.
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const publishCall = (h: Harness) =>
    h.tools.call(caller(), MARKET_PUBLISH, { path: 'skills/changelog-writer' })

  /** A first call that returned before the user answered its card. */
  async function waitedOnce(h: Harness): Promise<void> {
    const first = publishCall(h)
    await asked(h)
    await vi.advanceTimersByTimeAsync(CONTROL_WAIT_MS)
    expect((await first).structuredContent).toEqual({ waiting: true, confirmed: false })
  }

  it('returns before the harness’s 60 s limit, leaving the card and uploading nothing', async () => {
    const h = harness()
    const started = Date.now()
    let returned = 0
    const call = publishCall(h).then((result) => {
      returned = Date.now()
      return result
    })
    await asked(h)
    await vi.advanceTimersByTimeAsync(60_000)
    const result = await call
    expect(returned - started).toBeLessThan(60_000)
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({ waiting: true, confirmed: false })
    expect(uploads(h)).toEqual([])
    expect(h.drafts).toEqual([])
    expect(h.outcomes).toEqual([])
  })

  it('attaches a repeated call for the same folder to the waiting card', async () => {
    const h = harness()
    await waitedOnce(h)
    const again = h.tools.call(caller(), MARKET_PUBLISH, {
      path: path.join(root, 'skills', 'changelog-writer'),
    })
    h.answer({ decision: 'confirm', visibility: null, notes: null })
    const result = await again
    expect(result.structuredContent).toMatchObject({ published: true, version: '1.0.0' })
    expect(h.asks).toHaveLength(1)
    expect(uploads(h)).toHaveLength(1)
  })

  it('hands an answer that came between calls to the next call', async () => {
    const h = harness()
    await waitedOnce(h)
    h.answer({ decision: 'confirm', visibility: null, notes: null })
    await vi.waitFor(() => expect(h.outcomes).toHaveLength(1))
    const result = await publishCall(h)
    expect(result.structuredContent).toMatchObject({ published: true, version: '1.0.0' })
    expect(h.asks).toHaveLength(1)
    expect(uploads(h)).toHaveLength(1)
  })

  it('attaches a repeated unlisting by the listing’s other name to the same card', async () => {
    const h = harness(
      {
        publisher: { handle: 'amigoer', since: 'x' },
        listings: [listing()],
        storage: { bytes: 0, limit: 1 },
      },
      () => listing({ visibility: 'unlisted' }),
    )
    const first = h.tools.call(caller(), MARKET_UNLIST, { listing: 'abcdefgh23' })
    await asked(h)
    await vi.advanceTimersByTimeAsync(CONTROL_WAIT_MS)
    expect((await first).structuredContent).toEqual({ waiting: true, confirmed: false })
    const again = h.tools.call(caller(), MARKET_UNLIST, { listing: '@amigoer/changelog-writer' })
    h.answer({ decision: 'confirm', visibility: null, notes: null })
    expect((await again).structuredContent).toEqual({
      unlisted: true,
      listing: '@amigoer/changelog-writer',
    })
    expect(h.asks).toHaveLength(1)
    expect(h.calls.filter((c) => c.kind === 'update')).toHaveLength(1)
  })

  it('asks again in a later turn instead of handing over what the last one left', async () => {
    const h = harness()
    await waitedOnce(h)
    h.tools.turnEnded('s1')
    h.answer({ decision: 'ended' })
    await vi.waitFor(() => expect(h.drafts).toHaveLength(1))
    void publishCall(h)
    await vi.waitFor(() => expect(h.asks).toHaveLength(2))
  })
})

describe('publishing from a folder', () => {
  const folder = () => path.join(root, 'skills', 'changelog-writer')

  it('uploads nothing while the check finds a problem, nor while signed out', async () => {
    await writeFile(path.join(folder(), 'SKILL.md'), '---\nname: changelog-writer\n---\n')
    const h = harness()
    const plan = await h.tools.checkFolder(folder(), null)
    expect(plan.problems.length).toBeGreaterThan(0)
    await expect(
      h.tools.publishFolder(folder(), { draftId: null, visibility: null, notes: null }),
    ).rejects.toMatchObject({ code: 'invalid_params' })
    h.account.current = null
    await expect(h.tools.checkFolder(folder(), null)).rejects.toMatchObject({
      code: 'auth_required',
    })
    expect(h.calls.filter((c) => c.kind === 'publish')).toEqual([])
  })

  it('publishes a draft with its session and visibility, and keeps a refusal as a draft', async () => {
    const draft: PublishDraft = {
      id: 'd1',
      path: folder(),
      manifest: {
        slug: 'changelog-writer',
        name: 'Changelog writer',
        kind: 'skill',
        description: 'One line per change.',
        version: '1.0.0',
        visibility: 'private',
        agent: 'codex',
        session: 'Publish the changelog skill',
      },
      listingId: null,
      sessionId: 's9',
      sessionTitle: 'Publish the changelog skill',
      agentId: 'codex',
      createdAt: 0,
      error: null,
      problems: [],
    }
    const h = harness(undefined, publishedListing, [draft])
    const plan = await h.tools.checkFolder(folder(), 'd1')
    expect(plan).toMatchObject({ problems: [], ask: { visibility: 'private', version: '1.0.0' } })
    await h.tools.publishFolder(folder(), { draftId: 'd1', visibility: null, notes: null })
    const sent = h.calls.find((c) => c.kind === 'publish')
    expect(sent).toMatchObject({
      manifest: { visibility: 'private', agent: 'codex', session: 'Publish the changelog skill' },
    })
    expect(h.published).toEqual([
      {
        folder: expect.any(String),
        listingId: 'abcdefgh23',
        version: '1.0.0',
        sessionId: 's9',
        path: folder(),
      },
    ])

    const refused = harness(undefined, () => {
      throw new MarketCallError({
        code: 'check_failed',
        status: 422,
        message: 'Refused',
        problems: [{ message: 'Bad' }],
      })
    })
    await expect(
      refused.tools.publishFolder(folder(), { draftId: null, visibility: null, notes: null }),
    ).rejects.toMatchObject({ code: 'invalid_params', data: { problems: [{ message: 'Bad' }] } })
    expect(refused.drafts).toEqual([
      expect.objectContaining({ path: folder(), problems: [{ message: 'Bad' }] }),
    ])
    expect(refused.published).toEqual([])
  })
})

describe('publishing a draft from a folder whose manifest moved on', () => {
  it('takes the version an MCP server’s server.json now says, not the draft’s', async () => {
    const server = path.join(root, 'servers', 'everything')
    await mkdir(server, { recursive: true })
    const json = (version: string) =>
      JSON.stringify({
        name: 'io.github.someone/everything',
        description: 'Every feature.',
        version,
        packages: [
          { registryType: 'npm', identifier: 'everything', version, transport: { type: 'stdio' } },
        ],
      })
    await writeFile(path.join(server, 'server.json'), json('2.0.0'))
    const draft: PublishDraft = {
      id: 'd2',
      path: server,
      manifest: {
        slug: 'everything',
        name: 'everything',
        kind: 'mcp-server',
        description: 'Every feature.',
        version: '1.9.0',
      },
      listingId: null,
      sessionId: null,
      sessionTitle: null,
      agentId: null,
      createdAt: 0,
      error: 'Refused',
      problems: [],
    }
    const h = harness(undefined, publishedListing, [draft])
    const plan = await h.tools.checkFolder(server, 'd2')
    expect(plan.problems).toEqual([])
    expect(plan.ask).toMatchObject({ version: '2.0.0' })
  })
})

describe('the tools while signed out or in Local mode', () => {
  it('answer why, and reach neither the folder nor the service', async () => {
    const h = harness()
    h.account.current = null
    expect(h.tools.on).toBe(false)
    for (const name of [MARKET_CHECK, MARKET_PUBLISH, MARKET_MINE, MARKET_UNLIST]) {
      const result = await h.tools.call(caller(), name, { path: 'skills/changelog-writer' })
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({ code: 'signed_out' })
    }
    expect(h.calls).toEqual([])
    expect(h.asks).toEqual([])
  })
})

describe('lineChanges', () => {
  it('counts the lines added and removed', () => {
    expect(lineChanges('a\nb\nc\n', 'a\nc\nd\ne\n')).toEqual({ added: 2, removed: 1 })
    expect(lineChanges('', 'x\n')).toEqual({ added: 1, removed: 0 })
  })
})
