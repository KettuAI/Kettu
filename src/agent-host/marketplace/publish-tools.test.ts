import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import { claudePluginFiles, writeFiles } from '../plugins/claude-plugin-fixture'
import { PluginConverter } from './plugin-conversions'
import type { NewDraft } from './publish-drafts'
import {
  lineChanges,
  MARKET_CHECK,
  MARKET_CONVERT,
  MARKET_MINE,
  MARKET_PUBLISH,
  MARKET_UNLIST,
  MarketCallError,
  MarketTools,
  type MarketAnswer,
  type MarketAsk,
  type MarketToolsDeps,
} from './publish-tools'

const APP = '0.3.0'

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
  /** What the session was told of cards no call took. */
  told: { sessionId: string; text: string }[]
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
  extra: Partial<MarketToolsDeps> = {},
): Harness {
  const calls: MarketCall[] = []
  const asks: MarketAsk[] = []
  const outcomes: MarketPublishOutcome[] = []
  const told: Harness['told'] = []
  const drafts: NewDraft[] = []
  const published: Harness['published'] = []
  const account = { current: ACCOUNT as MarketAccount | null }
  let resolve: ((answer: MarketAnswer) => void) | null = null
  const call = (async (made: MarketCall) => {
    calls.push(made)
    if (made.kind === 'mine') return mine
    return serve(made)
  }) as never
  const tools = new MarketTools({
    account: () => account.current,
    call,
    converter: new PluginConverter({
      call,
      appVersion: APP,
      folder: path.join(root, 'conversions'),
    }),
    appVersion: APP,
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
    tell: (sessionId, text) => told.push({ sessionId, text }),
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
    ...extra,
  })
  return {
    tools,
    calls,
    asks,
    outcomes,
    told,
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

  it('uploads nothing on Not now, a timeout or the session closing, and keeps a draft', async () => {
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
      {
        kind: 'failed',
        message: 'The Kettu Marketplace’s check didn’t pass.',
        problems: [{ message: 'Bad' }],
      },
    ])
    expect(h.drafts).toEqual([
      expect.objectContaining({
        error: 'The Kettu Marketplace’s check didn’t pass.',
        problems: [{ message: 'Bad' }],
      }),
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

  it('returns every call waiting on the card once it expires, keeping one draft', async () => {
    const h = harness()
    const first = publishCall(h)
    await asked(h)
    const joined = publishCall(h)
    h.answer({ decision: 'expired' })
    const results = await Promise.all([first, joined])
    for (const result of results) {
      expect(result.isError).toBeUndefined()
      expect(result.structuredContent).toEqual({ published: false, draft: true })
    }
    expect(h.asks).toHaveLength(1)
    expect(h.drafts).toHaveLength(1)
    expect(uploads(h)).toEqual([])
  })

  it('returns a call that joined after the first one gave up, once the card expires', async () => {
    const h = harness()
    await waitedOnce(h)
    const again = publishCall(h)
    await vi.advanceTimersByTimeAsync(CONTROL_WAIT_MS / 2)
    h.answer({ decision: 'expired' })
    expect((await again).structuredContent).toEqual({ published: false, draft: true })
    expect(h.asks).toHaveLength(1)
  })

  it('keeps the card past the turn that opened it, and tells the session what came of it', async () => {
    const h = harness()
    await waitedOnce(h)
    h.tools.turnEnded('s1')
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(h.drafts).toEqual([])
    h.answer({ decision: 'confirm', visibility: null, notes: null })
    await vi.waitFor(() => expect(h.told).toHaveLength(1))
    expect(uploads(h)).toHaveLength(1)
    expect(h.told[0]!.sessionId).toBe('s1')
    expect(h.told[0]!.text).toContain('Changelog writer')
    expect(h.told[0]!.text).toContain('Published @amigoer/changelog-writer 1.0.0')
    // A call of the turn it woke gets the same outcome, with no second card.
    const again = await publishCall(h)
    expect(again.structuredContent).toMatchObject({ published: true, version: '1.0.0' })
    expect(h.asks).toHaveLength(1)
    expect(uploads(h)).toHaveLength(1)
  })

  it('tells the session of Not now or a card that expired after its turn', async () => {
    for (const decision of ['later', 'expired'] as const) {
      const h = harness()
      await waitedOnce(h)
      h.tools.turnEnded('s1')
      h.answer({ decision })
      await vi.waitFor(() => expect(h.told).toHaveLength(1))
      expect(h.told[0]!.text).toContain(decision === 'later' ? 'Not now' : 'did not answer')
      expect(h.drafts).toHaveLength(1)
    }
  })

  it('hands the outcome to a call of a later turn instead of telling it', async () => {
    const h = harness()
    await waitedOnce(h)
    h.tools.turnEnded('s1')
    const later = publishCall(h)
    await vi.advanceTimersByTimeAsync(1_000)
    h.answer({ decision: 'confirm', visibility: null, notes: null })
    expect((await later).structuredContent).toMatchObject({ published: true })
    expect(h.told).toEqual([])
    expect(h.asks).toHaveLength(1)
  })

  it('tells an outcome no call took once the turn ends', async () => {
    const h = harness()
    await waitedOnce(h)
    h.answer({ decision: 'confirm', visibility: null, notes: null })
    await vi.waitFor(() => expect(h.outcomes).toHaveLength(1))
    // The turn still runs, so its agent may call again for it.
    expect(h.told).toEqual([])
    h.tools.turnEnded('s1')
    expect(h.told).toHaveLength(1)
    expect(h.told[0]!.text).toContain('Published')
  })

  it('tells the outcome a call of an ended turn was still waiting for', async () => {
    const h = harness()
    const call = publishCall(h)
    await asked(h)
    h.tools.turnEnded('s1')
    h.answer({ decision: 'later' })
    await call
    await vi.waitFor(() => expect(h.told).toHaveLength(1))
  })

  it('tells nothing of a card that ended with its session, and asks again after it', async () => {
    const h = harness()
    await waitedOnce(h)
    h.tools.turnEnded('s1')
    h.answer({ decision: 'ended' })
    await vi.waitFor(() => expect(h.drafts).toHaveLength(1))
    expect(h.told).toEqual([])
    void publishCall(h)
    await vi.waitFor(() => expect(h.asks).toHaveLength(2))
  })
})

// The agent writes no file of its own, so publishing a task's workflow asks only in Kettu's card.
describe('a workflow handed as text for the task Kettu asked to publish it from', () => {
  const TASK_WORKFLOW = `format: 1
name: Review the login change
description: Review the login change on another agent.
steps:
  - id: review
    name: Review
    prompt: Review the login change.
    outcomes:
      - name: Approved
        end: done
`
  const GENERAL = TASK_WORKFLOW.replaceAll('the login change', 'a change')
  const copy = () => path.join(root, 'to-publish', 't-1')

  function taskHarness(): Harness {
    return harness(undefined, publishedListing, [], {
      taskWorkflowFolder: (taskId) => (taskId === 't-1' ? copy() : null),
      taskWorkflow: async (taskId) =>
        taskId === 't-1' ? { title: 'Review the login change', text: TASK_WORKFLOW } : null,
    })
  }

  const kept = () => readFile(path.join(copy(), 'workflow.yaml'), 'utf8')

  it('checks and publishes it from the task’s folder, with one card for repeated calls', async () => {
    const h = taskHarness()
    const checked = await h.tools.call(caller(), MARKET_CHECK, {
      workflow: GENERAL,
      from_task: 't-1',
    })
    expect(checked.structuredContent).toMatchObject({
      ready: true,
      kind: 'workflow',
      name: 'Review a change',
    })
    expect(await kept()).toBe(GENERAL)

    const args = { workflow: GENERAL, from_task: 't-1', changes: 'Took out the login change.' }
    const first = h.tools.call(caller(), MARKET_PUBLISH, args)
    await asked(h)
    const again = h.tools.call(caller(), MARKET_PUBLISH, args)
    expect(h.asks[0]).toMatchObject({
      item: { kind: 'workflow', name: 'Review a change' },
      fromTask: {
        taskId: 't-1',
        sameFlow: true,
        changes: 'Took out the login change.',
        before: TASK_WORKFLOW,
        after: GENERAL,
      },
    })
    h.answer({ decision: 'confirm', visibility: 'private', notes: null })
    for (const result of await Promise.all([first, again])) {
      expect(result.structuredContent).toMatchObject({ published: true, version: '1.0.0' })
    }
    expect(h.asks).toHaveLength(1)
    expect(uploads(h)).toHaveLength(1)
  })

  it('leaves the folder as the waiting card shows it', async () => {
    const h = taskHarness()
    void h.tools.call(caller(), MARKET_PUBLISH, { workflow: GENERAL, from_task: 't-1' })
    await asked(h)
    const checked = await h.tools.call(caller(), MARKET_CHECK, {
      workflow: TASK_WORKFLOW,
      from_task: 't-1',
    })
    expect(checked.isError).toBe(true)
    expect(await kept()).toBe(GENERAL)
  })

  it('refuses a task Kettu did not ask about and malformed arguments, writing nothing', async () => {
    const h = taskHarness()
    const refusals: [Record<string, unknown>, string][] = [
      [{ workflow: GENERAL, from_task: 't-2' }, 'not_found'],
      [{ workflow: GENERAL, from_task: '../t-1' }, 'invalid'],
      [{ workflow: GENERAL }, 'invalid'],
      [{ workflow: GENERAL, from_task: 't-1', path: 'skills/changelog-writer' }, 'invalid'],
      [{ from_task: 't-1' }, 'invalid'],
      [{ workflow: 'x'.repeat(256 * 1024 + 1), from_task: 't-1' }, 'invalid'],
    ]
    for (const name of [MARKET_CHECK, MARKET_PUBLISH]) {
      for (const [input, code] of refusals) {
        const result = await h.tools.call(caller(), name, input)
        expect(result.isError, `${name} ${JSON.stringify(input).slice(0, 80)}`).toBe(true)
        expect(result.structuredContent).toMatchObject({ code })
      }
    }
    await expect(kept()).rejects.toThrow()
    expect(h.asks).toEqual([])
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

describe('plugins', () => {
  const SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
  const scriptPlugin = (folder: string) =>
    writeFiles(path.join(root, folder), {
      'plugin.json': JSON.stringify({
        $schema: SCHEMA,
        name: 'scripted',
        version: '1.0.0',
        description: 'Runs a script.',
        extensions: {
          'sh.kettu': { format: 1, script: './sh.kettu/main.js', api: 1, permissions: ['tools'] },
        },
      }),
      'sh.kettu/main.js': 'export default {}',
    })
  const somebody = (handle: string): MarketMine => ({
    publisher: { handle, since: 'x' },
    listings: [],
    storage: { bytes: 0, limit: 1 },
  })

  it('converts a Claude Code plugin, then publishes it as a Kettu plugin once confirmed', async () => {
    await writeFiles(path.join(root, 'release-tools'), claudePluginFiles())
    const h = harness()
    const original = await h.tools.call(caller(), MARKET_CHECK, { path: 'release-tools' })
    expect(original.structuredContent).toMatchObject({ ready: false, convertible: 'claude-code' })
    expect(h.asks).toEqual([])

    const converted = await h.tools.call(caller(), MARKET_CONVERT, { path: 'release-tools' })
    expect(converted.isError).toBeUndefined()
    const made = converted.structuredContent as {
      path: string
      leftOut: { kind: string }[]
    }
    expect(made.path).toBe(path.join(root, 'release-tools-kettu'))
    expect(made.leftOut.filter((item) => item.kind === 'hook')).toHaveLength(2)

    const checked = await h.tools.call(caller(), MARKET_CHECK, { path: 'release-tools-kettu' })
    expect(checked.structuredContent).toMatchObject({
      ready: true,
      kind: 'agent-plugin',
      slug: 'release-tools',
      version: '1.2.0',
    })
    const call = h.tools.call(caller(), MARKET_PUBLISH, { path: 'release-tools-kettu' })
    await asked(h)
    expect(h.asks[0]).toMatchObject({
      item: { kind: 'agent-plugin', slug: 'release-tools', harness: null },
      version: '1.2.0',
      plugin: { script: null, permissions: [] },
      converted: { from: 'claude-code' },
    })
    expect(h.asks[0]!.converted!.leftOut.map((item) => item.kind)).toContain('hook')
    expect(uploads(h)).toEqual([])
    h.answer({ decision: 'confirm', visibility: 'public', notes: null })
    expect((await call).isError).toBeUndefined()
    const upload = uploads(h)[0] as Extract<MarketCall, { kind: 'publish' }>
    expect(upload.manifest).toMatchObject({
      kind: 'agent-plugin',
      slug: 'release-tools',
      version: '1.2.0',
    })
    expect(upload.manifest.harness).toBeUndefined()
    expect(upload.files.map((file) => file.path)).toContain('plugin.json')
    expect(upload.files.map((file) => file.path)).not.toContain('hooks/hooks.json')
  })

  it('leaves the original folder as it was', async () => {
    await writeFiles(path.join(root, 'release-tools'), claudePluginFiles())
    const h = harness()
    await h.tools.call(caller(), MARKET_CONVERT, { path: 'release-tools' })
    const again = await h.tools.call(caller(), MARKET_CHECK, { path: 'release-tools' })
    expect(again.structuredContent).toMatchObject({ convertible: 'claude-code' })
  })

  it('refuses a script from anyone but Kettu’s own publisher before a card or an upload', async () => {
    await scriptPlugin('scripted')
    const h = harness(somebody('bea'))
    const checked = await h.tools.call(caller(), MARKET_CHECK, { path: 'scripted' })
    expect(checked.structuredContent).toMatchObject({ ready: false, script: expect.anything() })
    const refused = await h.tools.call(caller(), MARKET_PUBLISH, { path: 'scripted' })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.structuredContent)).toContain('Kettu’s own publisher')
    expect(h.asks).toEqual([])
    expect(uploads(h)).toEqual([])
    await expect(h.tools.checkFolder(path.join(root, 'scripted'), null)).resolves.toMatchObject({
      ask: expect.anything(),
      problems: [expect.objectContaining({ message: expect.stringContaining('own publisher') })],
    })
  })

  it('shows a script and its permissions on the card of Kettu’s own publisher', async () => {
    await scriptPlugin('scripted')
    const h = harness(somebody('kettu-labs'))
    const call = h.tools.call(caller(), MARKET_PUBLISH, { path: 'scripted' })
    await asked(h)
    expect(h.asks[0]).toMatchObject({
      plugin: { script: { entry: 'sh.kettu/main.js', api: 1 }, permissions: ['tools'] },
    })
    h.answer({ decision: 'later' })
    await call
  })

  it('shows the service’s own refusal of a script plainly, and keeps a draft', async () => {
    await scriptPlugin('scripted')
    const h = harness(somebody('kettu-labs'), () => {
      throw new MarketCallError({
        code: 'script_not_allowed',
        status: 403,
        message: 'Only Kettu may publish a script.',
      })
    })
    const call = h.tools.call(caller(), MARKET_PUBLISH, { path: 'scripted' })
    await asked(h)
    h.answer({ decision: 'confirm', visibility: null, notes: null })
    const result = await call
    expect(result.isError).toBe(true)
    expect(h.outcomes).toEqual([
      expect.objectContaining({ kind: 'failed', message: expect.stringContaining('script') }),
    ])
    expect(h.drafts).toHaveLength(1)
  })

  it('names a listing of the closed kind when a plugin takes its name', async () => {
    await writeFiles(path.join(root, 'release-tools'), claudePluginFiles())
    const h = harness({
      publisher: { handle: 'bea', since: 'x' },
      listings: [listing({ slug: 'release-tools', kind: 'plugin', harness: 'claude-code' })],
      storage: { bytes: 0, limit: 1 },
    })
    await h.tools.call(caller(), MARKET_CONVERT, { path: 'release-tools' })
    const checked = await h.tools.call(caller(), MARKET_CHECK, { path: 'release-tools-kettu' })
    expect(checked.structuredContent).toMatchObject({ ready: false })
    expect(JSON.stringify(checked.structuredContent)).toContain('takes no new versions')
  })

  it('converts a closed listing from the files the service still serves', async () => {
    const source = claudePluginFiles()
    const mine: MarketMine = {
      publisher: { handle: 'bea', since: 'x' },
      listings: [listing({ slug: 'release-tools', kind: 'plugin', harness: 'claude-code' })],
      storage: { bytes: 0, limit: 1 },
    }
    const serve = (call: MarketCall): unknown => {
      if (call.kind === 'version') {
        return {
          files: Object.entries(source).map(([name, text]) => ({
            path: name,
            size: Buffer.byteLength(text),
            sha256: createHash('sha256').update(text).digest('hex'),
          })),
        }
      }
      if (call.kind === 'file') {
        const text = source[call.path]!
        return {
          data: Buffer.from(text).toString('base64'),
          sha256: createHash('sha256').update(text).digest('hex'),
        }
      }
      return null
    }
    const converter = new PluginConverter({
      call: (async (call: MarketCall) => (call.kind === 'mine' ? mine : serve(call))) as never,
      appVersion: APP,
      folder: path.join(root, 'conversions'),
    })
    const made = await converter.listing('abcdefgh23')
    expect(made.path).toBe(path.join(root, 'conversions', 'release-tools'))
    expect(made.conversion.leftOut.filter((item) => item.kind === 'hook')).toHaveLength(2)
    expect(converter.conversionOf(made.path)).toBe(made.conversion)
    await expect(converter.listing('zzzzzzzzzz')).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('lineChanges', () => {
  it('counts the lines added and removed', () => {
    expect(lineChanges('a\nb\nc\n', 'a\nc\nd\ne\n')).toEqual({ added: 2, removed: 1 })
    expect(lineChanges('', 'x\n')).toEqual({ added: 1, removed: 0 })
  })
})
