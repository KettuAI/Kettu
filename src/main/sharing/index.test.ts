import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactBrief } from '@shared/host-control'
import { Sharing } from './index'

const ARTIFACT = `art_${'A'.repeat(26)}`
const PAGE = 'abcdefghijklmnopqrst'
const PAGE_URL = `https://${PAGE}.pages.example/`
const ACCOUNT = { id: '6f9619ff-8b86-d011-b42d-00c04fc964ff', email: 'ada@example.com' }
const START = 1_000_000

type Answer = { status?: number; body?: unknown }
type Call = { method: string; url: string }

const listing = (pages: unknown[]): Answer => ({
  body: { pages, usage: { bytes: 1, limit: 10 } },
})

/** The service's answers to one page published as private. */
const made = (): Answer[] => [
  { status: 201, body: { id: PAGE, url: PAGE_URL, access: 'private', code: null } },
  listing([{ id: PAGE, url: PAGE_URL, bytes: 1, access: 'private', code: null }]),
]

/** An artifact made after `START`, so it is new to automatic publishing started then. */
const created = (): ArtifactBrief => ({
  id: ARTIFACT,
  version: 1,
  createdAt: START + 1_000,
  updatedAt: START + 1_000,
  deleted: false,
})

let dir: string
let clock = START

/** Loads the sharing of the data folder, with the service as a list of answers. */
async function sharingWith(answers: Answer[]) {
  const content = join(dir, 'content')
  await mkdir(content, { recursive: true })
  const file = join(content, 'index.html')
  await writeFile(file, '<h1>Hi</h1>')
  const calls: Call[] = []
  const sharing = await Sharing.load({
    userDataPath: dir,
    contentDir: content,
    host: {
      content: async (_id, version) => ({
        kind: 'found',
        version: version ?? 1,
        title: 'Hi',
        key: 'k',
        strict: false,
        files: [{ path: 'index.html', file, size: 11 }],
      }),
      artifacts: async () => [created()],
    },
    kettu: {
      base: 'https://account.example',
      account: () => ACCOUNT,
      withToken: (call) => call('token'),
    },
    cipher: { encrypt: async (text) => text, decrypt: async (text) => text },
    encryptionAvailable: async () => true,
    plainText: () => false,
    fetch: async (url, init) => {
      calls.push({ method: init.method ?? 'GET', url })
      const answer = answers.shift() ?? { status: 500 }
      return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
        status: answer.status ?? 200,
      })
    },
    now: () => clock,
  })
  return { sharing, calls }
}

/** Writes the file as an earlier run left it, with this state of automatic publishing. */
async function stored(auto: { enabled: boolean; confirmed: boolean }): Promise<void> {
  await writeFile(
    join(dir, 'published-artifacts.json'),
    JSON.stringify({
      version: 3,
      account: null,
      published: [],
      auto: { ...auto, since: START, accountId: ACCOUNT.id, declined: [] },
    }),
  )
}

async function savedAuto(sharing: Sharing): Promise<Record<string, unknown>> {
  await sharing.flush()
  const file = JSON.parse(await readFile(join(dir, 'published-artifacts.json'), 'utf8')) as {
    auto: Record<string, unknown>
  }
  return file.auto
}

/** Waits out the work a timer started, which reads and writes real files. */
async function settle(done: () => boolean = () => true): Promise<void> {
  for (let i = 0; i < 50 || (!done() && i < 10_000); i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/** Lets the artifacts be looked at once the new one is quiet, and the work that starts finish. */
async function lookAgain(sharing: Sharing, done?: () => boolean): Promise<void> {
  clock = START + 20_000
  sharing.artifactsChanged()
  vi.advanceTimersByTime(60_000)
  await settle(done)
  await sharing.flush()
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kettu-sharing-'))
  clock = START
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(async () => {
  vi.useRealTimers()
  await rm(dir, { recursive: true, force: true })
})

describe('Publishing on its own', () => {
  it('starts off on a computer without a state, and uploads nothing', async () => {
    const { sharing, calls } = await sharingWith(made())
    await lookAgain(sharing)
    expect(calls).toEqual([])
    expect(sharing.status().auto).toMatchObject({ enabled: false, notice: false })
    expect(sharing.status().published).toEqual([])
    expect(await savedAuto(sharing)).toMatchObject({ enabled: false, confirmed: false })
  })

  it('reads a state left on by default and never answered as off, and saves it so', async () => {
    await stored({ enabled: true, confirmed: false })
    const { sharing, calls } = await sharingWith(made())
    await lookAgain(sharing)
    expect(calls).toEqual([])
    expect(sharing.status().auto).toMatchObject({ enabled: false, notice: false })
    expect(await savedAuto(sharing)).toMatchObject({ enabled: false, confirmed: false })
  })

  it('keeps a state the user confirmed on, and one that is off off', async () => {
    await stored({ enabled: true, confirmed: true })
    const on = await sharingWith(made())
    await lookAgain(on.sharing, () => on.sharing.status().published.length > 0)
    expect(on.sharing.status().auto).toMatchObject({ enabled: true, notice: false })
    expect(on.sharing.status().published[0]).toMatchObject({ id: ARTIFACT, access: 'private' })

    await stored({ enabled: false, confirmed: true })
    const off = await sharingWith(made())
    await lookAgain(off.sharing)
    expect(off.calls).toEqual([])
    expect(off.sharing.status().auto).toMatchObject({ enabled: false, notice: false })
  })

  it('holds the first upload for the notice after the switch is turned on', async () => {
    const { sharing, calls } = await sharingWith(made())
    sharing.setAuto(true)
    await lookAgain(sharing)
    expect(calls).toEqual([])
    expect(sharing.status().auto).toMatchObject({ enabled: true, notice: true })
    expect(await savedAuto(sharing)).toMatchObject({ enabled: true, confirmed: false })

    // The notice's answer.
    sharing.setAuto(true)
    vi.advanceTimersByTime(1)
    await settle(() => sharing.status().published.length > 0)
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://account.example/api/v1/shares?access=private',
    })
    expect(sharing.status().auto).toMatchObject({ enabled: true, notice: false })
    expect(await savedAuto(sharing)).toMatchObject({ enabled: true, confirmed: true })
  })

  it('keeps a switch turned on but not yet answered on over a restart, still held', async () => {
    const first = await sharingWith(made())
    first.sharing.setAuto(true)
    await first.sharing.flush()

    const { sharing, calls } = await sharingWith(made())
    await lookAgain(sharing)
    expect(calls).toEqual([])
    expect(sharing.status().auto).toMatchObject({ enabled: true, notice: true })
  })

  it('turns off when the notice is declined, and asks again when turned on again', async () => {
    const { sharing, calls } = await sharingWith(made())
    sharing.setAuto(true)
    await lookAgain(sharing)
    sharing.setAuto(false)
    expect(sharing.status().auto).toMatchObject({ enabled: false, notice: false })
    expect(await savedAuto(sharing)).toMatchObject({ enabled: false, confirmed: false })

    clock = START
    sharing.setAuto(true)
    await lookAgain(sharing)
    expect(calls).toEqual([])
    expect(sharing.status().auto).toMatchObject({ enabled: true, notice: true })
  })

  it('does not ask a user who confirmed before again after off and on', async () => {
    await stored({ enabled: true, confirmed: true })
    const { sharing, calls } = await sharingWith(made())
    sharing.setAuto(false)
    sharing.setAuto(true)
    await lookAgain(sharing, () => sharing.status().published.length > 0)
    expect(calls[0]).toMatchObject({ method: 'POST' })
    expect(sharing.status().auto).toMatchObject({ enabled: true, notice: false })
    expect(sharing.status().published[0]).toMatchObject({ id: ARTIFACT, access: 'private' })
  })
})

describe('Account isolation for published artifacts', () => {
  const ACCOUNT_B = { id: '7a1122bb-9c00-4d11-9e22-00c04fc964aa', email: 'bob@example.com' }
  const ARTIFACT_B = `art_${'B'.repeat(26)}`
  const ARTIFACT_CF_A = `art_${'C'.repeat(26)}`
  const ARTIFACT_LOCAL = `art_${'D'.repeat(26)}`
  const CF_ACCOUNT = '0123456789abcdef0123456789abcdef'

  async function setupSwitchable(options: {
    initialAccount: { id: string; email: string } | null
    answers?: Answer[]
    briefs?: () => ArtifactBrief[]
    content?: (
      id: string,
      version: number | null,
    ) => Promise<
      | {
          kind: 'found'
          version: number
          title: string
          key: string
          strict: boolean
          files: { path: string; file: string; size: number }[]
          ownerAccountId?: string | null
        }
      | { kind: 'not_found' }
    >
  }) {
    const contentDir = join(dir, 'content')
    await mkdir(contentDir, { recursive: true })
    const file = join(contentDir, 'index.html')
    await writeFile(file, '<h1>Page</h1>')
    let activeAccount = options.initialAccount
    const answers = [...(options.answers ?? [])]
    const calls: Call[] = []
    const claimed: { id: string; accountId: string }[] = []
    const statuses: ReturnType<Sharing['status']>[] = []
    const sharing = await Sharing.load({
      userDataPath: dir,
      contentDir,
      host: {
        content:
          options.content ??
          (async (_id, version) => ({
            kind: 'found',
            version: version ?? 1,
            title: 'Page',
            key: 'k',
            strict: false,
            files: [{ path: 'index.html', file, size: 13 }],
            ownerAccountId: activeAccount?.id ?? null,
          })),
        artifacts: async () => options.briefs?.() ?? [],
        claimOwner: (id, accountId) => claimed.push({ id, accountId }),
      },
      kettu: {
        base: 'https://account.example',
        account: () => activeAccount,
        withToken: (call) => call('token'),
      },
      cipher: { encrypt: async (text) => text, decrypt: async (text) => text },
      encryptionAvailable: async () => true,
      plainText: () => false,
      fetch: async (url, init) => {
        calls.push({ method: init.method ?? 'GET', url })
        const answer = answers.shift() ?? {
          status: 200,
          body: { pages: [], usage: { bytes: 0, limit: 10 } },
        }
        return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
          status: answer.status ?? 200,
        })
      },
      changed: (status) => statuses.push(status),
      now: () => clock,
    })
    return {
      sharing,
      calls,
      claimed,
      statuses,
      file,
      switchTo(next: { id: string; email: string } | null) {
        activeAccount = next
        sharing.kettuChanged()
      },
    }
  }

  it('hides A published records across A -> B -> A and signed-out, blocks B management/openLink, and preserves underlying data', async () => {
    const ctx = await setupSwitchable({
      initialAccount: ACCOUNT,
      answers: [
        // Publish public page under A
        { status: 201, body: { id: PAGE, url: PAGE_URL, access: 'public', code: null } },
        listing([{ id: PAGE, url: PAGE_URL, bytes: 1, access: 'public', code: null }]),
        // Refresh when switching to B
        listing([]),
        // Refresh when switching back to A
        listing([{ id: PAGE, url: PAGE_URL, bytes: 1, access: 'public', code: null }]),
      ],
      briefs: () => [
        {
          id: ARTIFACT,
          version: 1,
          createdAt: START,
          updatedAt: START,
          deleted: false,
          ownerAccountId: ACCOUNT.id,
        },
      ],
    })

    const published = await ctx.sharing.publish(ARTIFACT, 1, 'kettu', 'public')
    expect('status' in published).toBe(true)
    expect(ctx.sharing.status().published.map((p) => p.id)).toEqual([ARTIFACT])
    expect(ctx.claimed).toEqual([{ id: ARTIFACT, accountId: ACCOUNT.id }])

    // Switch A -> B: A's published record disappears from B's status and every action is denied.
    ctx.calls.length = 0
    ctx.switchTo(ACCOUNT_B)
    await settle()
    expect(ctx.sharing.status().published).toEqual([])
    const callsAfterSwitch = ctx.calls.length

    expect(await ctx.sharing.openLink(ARTIFACT)).toMatchObject({ failed: 'not_found' })
    expect(await ctx.sharing.update(ARTIFACT, 2)).toMatchObject({ failed: 'not_found' })
    expect(await ctx.sharing.setAccess(ARTIFACT, 'private')).toMatchObject({ failed: 'not_found' })
    expect(await ctx.sharing.newCode(ARTIFACT)).toMatchObject({ failed: 'not_found' })
    expect(await ctx.sharing.visitors(ARTIFACT)).toBeNull()
    expect(await ctx.sharing.unpublish(ARTIFACT)).toMatchObject({ failed: 'not_found' })
    expect(await ctx.sharing.publish(ARTIFACT, 1, 'kettu', 'public')).toMatchObject({
      failed: 'not_found',
    })
    // No remote mutation calls were made on A's page.
    expect(ctx.calls.length).toBe(callsAfterSwitch)

    // Underlying file still preserves A's published record untouched.
    await ctx.sharing.flush()
    const saved = JSON.parse(await readFile(join(dir, 'published-artifacts.json'), 'utf8')) as {
      published: { id: string; url: string; accountId: string }[]
    }
    expect(saved.published).toHaveLength(1)
    expect(saved.published[0]).toMatchObject({
      id: ARTIFACT,
      url: PAGE_URL,
      accountId: ACCOUNT.id,
    })

    // Signed out: A's record stays hidden and inaccessible.
    ctx.switchTo(null)
    expect(ctx.sharing.status().published).toEqual([])
    expect(await ctx.sharing.openLink(ARTIFACT)).toMatchObject({ failed: 'not_found' })

    // Switch back to A: A's record and link return intact and remain manageable.
    ctx.switchTo(ACCOUNT)
    await settle()
    expect(ctx.sharing.status().published).toHaveLength(1)
    expect(ctx.sharing.status().published[0]).toMatchObject({
      id: ARTIFACT,
      url: PAGE_URL,
      access: 'public',
    })
    expect(await ctx.sharing.openLink(ARTIFACT)).toEqual({ url: PAGE_URL })
  })

  it('isolates legacy published-artifacts.json records across restarts without deleting other accounts links on reconcile', async () => {
    const cfPageA = 'ob-aaaaaaaaaaaaaaaa'
    const cfPageLocal = 'ob-bbbbbbbbbbbbbbbb'
    const pageB = 'bbbbbbbbbbbbbbbbbbbb'
    await writeFile(
      join(dir, 'published-artifacts.json'),
      JSON.stringify({
        version: 3,
        account: {
          accountId: CF_ACCOUNT,
          subdomain: 'demo',
          token: 'cf-token',
          plainText: false,
        },
        published: [
          {
            id: ARTIFACT,
            target: 'kettu',
            ref: PAGE,
            url: PAGE_URL,
            version: 1,
            publishedAt: START,
            accountId: ACCOUNT.id,
            accountEmail: ACCOUNT.email,
            access: 'public',
            code: null,
          },
          {
            id: ARTIFACT_B,
            target: 'kettu',
            ref: pageB,
            url: `https://${pageB}.pages.example/`,
            version: 1,
            publishedAt: START,
            accountId: ACCOUNT_B.id,
            accountEmail: ACCOUNT_B.email,
            access: 'private',
            code: null,
          },
          {
            id: ARTIFACT_CF_A,
            target: 'cloudflare',
            ref: cfPageA,
            url: `https://${cfPageA}.demo.workers.dev/`,
            version: 1,
            publishedAt: START,
            accountId: CF_ACCOUNT,
            accountEmail: null,
            ownerAccountId: ACCOUNT.id,
            access: 'public',
            code: null,
          },
          {
            id: ARTIFACT_LOCAL,
            target: 'cloudflare',
            ref: cfPageLocal,
            url: `https://${cfPageLocal}.demo.workers.dev/`,
            version: 1,
            publishedAt: START,
            accountId: CF_ACCOUNT,
            accountEmail: null,
            access: 'public',
            code: null,
          },
        ],
        auto: {
          enabled: false,
          confirmed: false,
          chosen: false,
          since: null,
          accountId: null,
          declined: [],
        },
      }),
    )

    const allBriefs = (): ArtifactBrief[] => [
      {
        id: ARTIFACT,
        version: 1,
        createdAt: START,
        updatedAt: START,
        deleted: false,
        ownerAccountId: ACCOUNT.id,
      },
      {
        id: ARTIFACT_B,
        version: 1,
        createdAt: START,
        updatedAt: START,
        deleted: false,
        ownerAccountId: ACCOUNT_B.id,
      },
      {
        id: ARTIFACT_CF_A,
        version: 1,
        createdAt: START,
        updatedAt: START,
        deleted: false,
        ownerAccountId: ACCOUNT.id,
      },
      {
        id: ARTIFACT_LOCAL,
        version: 1,
        createdAt: START,
        updatedAt: START,
        deleted: false,
        ownerAccountId: null,
      },
    ]

    // Restart as B: sees B's Kettu page and purely local Cloudflare page; A's Kettu & Cloudflare pages hidden.
    const runB = await setupSwitchable({
      initialAccount: ACCOUNT_B,
      briefs: allBriefs,
      answers: [
        listing([
          {
            id: pageB,
            url: `https://${pageB}.pages.example/`,
            bytes: 1,
            access: 'private',
            code: null,
          },
        ]),
        // Cloudflare existing check returns only the visible local worker
        { status: 200, body: { success: true, result: [{ id: cfPageLocal }] } },
      ],
    })
    expect(runB.sharing.status().published.map((p) => p.id)).toEqual([ARTIFACT_B, ARTIFACT_LOCAL])
    expect(await runB.sharing.openLink(ARTIFACT)).toMatchObject({ failed: 'not_found' })
    expect(await runB.sharing.openLink(ARTIFACT_CF_A)).toMatchObject({ failed: 'not_found' })
    expect(await runB.sharing.unpublish(ARTIFACT_CF_A)).toMatchObject({ failed: 'not_found' })

    // Reconcile under B must NOT delete or forget A's Kettu or Cloudflare pages.
    await runB.sharing.reconcile()
    await runB.sharing.flush()
    expect(runB.calls.some((c) => c.method === 'DELETE')).toBe(false)

    // Restart as A: A's Kettu page, A's Cloudflare page, and the unowned local Cloudflare page all appear.
    const runA = await setupSwitchable({
      initialAccount: ACCOUNT,
      briefs: allBriefs,
    })
    expect(runA.sharing.status().published.map((p) => p.id)).toEqual([
      ARTIFACT,
      ARTIFACT_CF_A,
      ARTIFACT_LOCAL,
    ])
    expect(await runA.sharing.openLink(ARTIFACT_B)).toMatchObject({ failed: 'not_found' })
  })
})
