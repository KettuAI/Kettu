import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SharingOpenResult, SharingResult } from '@shared/sharing'
import { Sharing } from './index'

const ARTIFACT = `art_${'A'.repeat(26)}`
const PAGE = 'abcdefghijklmnopqrst'
const PAGE_URL = `https://${PAGE}.pages.example/`
const ACCOUNT = { id: '6f9619ff-8b86-d011-b42d-00c04fc964ff', email: 'ada@example.com' }

type Answer = { status?: number; body?: unknown }
type Call = { method: string; url: string; body: unknown }

/** The sharing service as a list of answers, one per request, and the requests it saw. */
function service(answers: Answer[]) {
  const calls: Call[] = []
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({
      method: init.method ?? 'GET',
      url,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    })
    const answer = answers.shift() ?? { status: 500 }
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status ?? 200,
    })
  }
  return { calls, fetch }
}

const listing = (pages: unknown[]) => ({ body: { pages, usage: { bytes: 1, limit: 10 } } })

let dir: string

async function sharingWith(answers: Answer[]) {
  const content = join(dir, 'content')
  await mkdir(content, { recursive: true })
  const file = join(content, 'index.html')
  await writeFile(file, '<h1>Hi</h1>')
  const net = service(answers)
  const sharing = await Sharing.load({
    userDataPath: dir,
    contentDir: content,
    host: {
      content: async () => ({
        kind: 'found',
        version: 1,
        title: 'Hi',
        key: 'k',
        strict: false,
        files: [{ path: 'index.html', file, size: 11 }],
      }),
      ids: async () => new Set([ARTIFACT]),
    },
    kettu: {
      base: 'https://account.example',
      account: () => ACCOUNT,
      withToken: (call) => call('token'),
    },
    cipher: { encrypt: async (text) => text, decrypt: async (text) => text },
    encryptionAvailable: async () => true,
    plainText: () => false,
    fetch: net.fetch,
  })
  return { sharing, calls: net.calls }
}

function status(result: SharingResult) {
  if (!('status' in result)) throw new Error(`Failed: ${result.failed}`)
  return result.status.published[0]
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kettu-sharing-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('Sharing levels', () => {
  it('refuses a level that is not one, before any request', async () => {
    const { sharing, calls } = await sharingWith([])
    for (const access of ['friends', undefined, null, 1]) {
      expect(await sharing.publish(ARTIFACT, 1, 'kettu', access)).toMatchObject({
        failed: 'failed',
      })
    }
    expect(await sharing.setAccess(ARTIFACT, 'everyone')).toMatchObject({ failed: 'failed' })
    expect(await sharing.setAccess('../x', 'public')).toMatchObject({ failed: 'failed' })
    expect(await sharing.openLink(42)).toMatchObject({ failed: 'failed' })
    expect(calls).toEqual([])
  })

  it('publishes at the level asked for and keeps the level the service gives', async () => {
    const { sharing, calls } = await sharingWith([
      { status: 201, body: { id: PAGE, url: PAGE_URL, access: 'code', code: 'k7m2' } },
      listing([{ id: PAGE, url: PAGE_URL, bytes: 1, access: 'code', code: 'k7m2' }]),
    ])
    const page = status(await sharing.publish(ARTIFACT, 1, 'kettu', 'code'))
    expect(calls[0]!.url).toBe('https://account.example/api/v1/shares?access=code')
    expect(page).toMatchObject({ access: 'code', code: 'k7m2', codeLocked: false })
  })

  it('shows a page as public when the service names no level', async () => {
    const { sharing } = await sharingWith([
      { status: 201, body: { id: PAGE, url: PAGE_URL } },
      listing([{ id: PAGE, url: PAGE_URL, bytes: 1 }]),
    ])
    expect(status(await sharing.publish(ARTIFACT, 1, 'kettu', 'private'))).toMatchObject({
      access: 'public',
      code: null,
    })
  })

  it('refuses a code that is not one, or a code without its level', async () => {
    for (const body of [
      { id: PAGE, url: PAGE_URL, access: 'code', code: 'K7M2' },
      { id: PAGE, url: PAGE_URL, access: 'nobody' },
    ]) {
      const { sharing } = await sharingWith([{ status: 201, body }])
      expect(await sharing.publish(ARTIFACT, 1, 'kettu', 'code')).toMatchObject({
        failed: 'failed',
      })
    }
  })

  it('changes the level and the code, and follows the lock the service reports', async () => {
    const { sharing, calls } = await sharingWith([
      { status: 201, body: { id: PAGE, url: PAGE_URL, access: 'private', code: null } },
      listing([{ id: PAGE, url: PAGE_URL, bytes: 1, access: 'private', code: null }]),
      { body: { access: 'code', code: 'k7m2', codeLocked: true } },
      { body: { access: 'code', code: 'p3q4', codeLocked: false } },
    ])
    await sharing.publish(ARTIFACT, 1, 'kettu', 'private')
    expect(status(await sharing.setAccess(ARTIFACT, 'code'))).toMatchObject({
      access: 'code',
      code: 'k7m2',
      codeLocked: true,
    })
    expect(calls[2]).toMatchObject({
      method: 'PATCH',
      url: `https://account.example/api/v1/shares/${PAGE}`,
      body: { access: 'code' },
    })
    expect(status(await sharing.newCode(ARTIFACT))).toMatchObject({
      code: 'p3q4',
      codeLocked: false,
    })
    expect(calls[3]!.body).toEqual({ newCode: true })
  })

  it('opens the publisher’s page only through an address on its own host', async () => {
    const { sharing } = await sharingWith([
      { status: 201, body: { id: PAGE, url: PAGE_URL, access: 'private', code: null } },
      listing([{ id: PAGE, url: PAGE_URL, bytes: 1, access: 'private', code: null }]),
      { body: { url: `${PAGE_URL}_kettu/access/grant?code=abc` } },
      { body: { url: 'https://evil.example/_kettu/access/grant?code=abc' } },
      { body: { url: `http://${PAGE}.pages.example/` } },
    ])
    await sharing.publish(ARTIFACT, 1, 'kettu', 'private')
    expect(await sharing.openLink(ARTIFACT)).toEqual({
      url: `${PAGE_URL}_kettu/access/grant?code=abc`,
    } satisfies SharingOpenResult)
    expect(await sharing.openLink(ARTIFACT)).toMatchObject({ failed: 'failed' })
    expect(await sharing.openLink(ARTIFACT)).toMatchObject({ failed: 'failed' })
  })

  it('opens a public page at its own address without asking the service', async () => {
    const { sharing, calls } = await sharingWith([
      { status: 201, body: { id: PAGE, url: PAGE_URL, access: 'public', code: null } },
      listing([{ id: PAGE, url: PAGE_URL, bytes: 1, access: 'public', code: null }]),
    ])
    await sharing.publish(ARTIFACT, 1, 'kettu', 'public')
    expect(await sharing.openLink(ARTIFACT)).toEqual({ url: PAGE_URL })
    expect(calls).toHaveLength(2)
  })
})
