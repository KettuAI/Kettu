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
