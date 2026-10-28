// The rules of a new origin, the session sets, the project's stored ones, and the wait.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORIGIN_WAIT_MS } from '@shared/browser'
import { BrowserOrigins, BrowserOriginStore, originOf, opensFreely, parseOrigins } from './origins'

const folders: string[] = []

afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})

async function tempFolder(): Promise<string> {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'overbench-origins-'))
  folders.push(folder)
  return folder
}

describe('originOf', () => {
  it('takes the scheme, the host and a port that is not the scheme default', () => {
    expect(originOf('https://example.com/a?b=1')).toBe('https://example.com')
    expect(originOf('http://localhost:5173/login')).toBe('http://localhost:5173')
    expect(originOf('http://EXAMPLE.com/')).toBe('http://example.com')
    expect(originOf('https://example.com:8443/')).toBe('https://example.com:8443')
  })

  it('tells an http origin from its https one, and a port from no port', () => {
    expect(originOf('http://example.com/')).not.toBe(originOf('https://example.com/'))
    expect(originOf('http://example.com:8080/')).not.toBe(originOf('http://example.com/'))
  })

  it('has none for a scheme without one, or for text that is no URL', () => {
    expect(originOf('about:blank')).toBeNull()
    expect(originOf('file:///etc/passwd')).toBeNull()
    expect(originOf('not a url')).toBeNull()
  })
})

describe('opensFreely', () => {
  it('takes a local dev host and the empty document', () => {
    for (const url of [
      'http://localhost:5173/',
      'http://127.0.0.1:3000/app',
      'http://[::1]:8080/',
      'https://app.localhost/',
      'http://myapp.test/login',
      'about:blank',
    ]) {
      expect(opensFreely(url), url).toBe(true)
    }
  })

  it('leaves every other site to the user', () => {
    for (const url of ['https://example.com/', 'http://localhost.example.com/', 'file:///x']) {
      expect(opensFreely(url), url).toBe(false)
    }
  })
})

describe('parseOrigins', () => {
  it('keeps the projects origins that are origins, once each', () => {
    expect(
      parseOrigins({
        version: 1,
        projects: { '/p': ['https://example.com', 'https://example.com', 'x'], '/q': [] },
      }),
    ).toEqual({ '/p': ['https://example.com'] })
  })

  it('reads anything else as no projects at all', () => {
    expect(parseOrigins(null)).toEqual({})
    expect(parseOrigins([])).toEqual({})
    expect(parseOrigins({ version: 1 })).toEqual({})
    expect(parseOrigins({ projects: 'x' })).toEqual({})
  })
})

describe('BrowserOriginStore', () => {
  it('writes a project it always allows, and reads it back after a restart', async () => {
    const folder = await tempFolder()
    const store = await BrowserOriginStore.load(folder)
    store.add('/p', 'https://example.com')
    store.add('/p', 'https://example.com')
    await store.flush()
    const written = JSON.parse(
      await readFile(path.join(folder, 'state', 'browser-origins.json'), 'utf8'),
    )
    expect(written).toEqual({ version: 1, projects: { '/p': ['https://example.com'] } })

    const reopened = await BrowserOriginStore.load(folder)
    expect(reopened.allows('/p', 'https://example.com')).toBe(true)
    expect(reopened.allows('/q', 'https://example.com')).toBe(false)
    expect(reopened.list()).toEqual([{ projectPath: '/p', origins: ['https://example.com'] }])
  })

  it('forgets a project once its last site goes', async () => {
    const folder = await tempFolder()
    const store = await BrowserOriginStore.load(folder)
    store.add('/p', 'https://example.com')
    store.add('/p', 'https://other.test.example')
    store.remove('/p', 'https://example.com')
    await store.flush()
    const reopened = await BrowserOriginStore.load(folder)
    expect(reopened.list()).toEqual([
      { projectPath: '/p', origins: ['https://other.test.example'] },
    ])
    reopened.remove('/p', 'https://other.test.example')
    await reopened.flush()
    expect(
      JSON.parse(await readFile(path.join(folder, 'state', 'browser-origins.json'), 'utf8')),
    ).toEqual({ version: 1, projects: {} })
  })

  it('reads a damaged file as no sites, and never moves it aside', async () => {
    const folder = await tempFolder()
    const file = path.join(folder, 'state', 'browser-origins.json')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, '{ not json')
    const store = await BrowserOriginStore.load(folder)
    expect(store.list()).toEqual([])
    expect(await readFile(file, 'utf8')).toBe('{ not json')
  })
})

function origins(deps: Partial<ConstructorParameters<typeof BrowserOrigins>[1]> = {}) {
  const asked: { id: number; sessionId: string; origin: string }[] = []
  const settled: {
    id: number
    sessionId: string
    origin: string
    decision: string
  }[] = []
  const changed: string[] = []
  const store = new BrowserOriginStoreStub()
  const rules = new BrowserOrigins(store as never, {
    asked: (request) => asked.push(request),
    settled: (request) => settled.push(request),
    changed: (sessionId) => changed.push(sessionId),
    ...deps,
  })
  return { rules, asked, settled, changed, store }
}

/** A store that keeps its projects in memory, as the browser-origins file does on disk. */
class BrowserOriginStoreStub {
  readonly projects = new Map<string, string[]>()

  allows(projectPath: string, origin: string): boolean {
    return (this.projects.get(projectPath) ?? []).includes(origin)
  }

  add(projectPath: string, origin: string): void {
    this.projects.set(projectPath, [...(this.projects.get(projectPath) ?? []), origin])
  }

  remove(projectPath: string, origin: string): void {
    this.projects.set(
      projectPath,
      (this.projects.get(projectPath) ?? []).filter((known) => known !== origin),
    )
  }

  list(): { projectPath: string; origins: string[] }[] {
    return [...this.projects].map(([projectPath, origins]) => ({ projectPath, origins }))
  }

  flush(): Promise<void> {
    return Promise.resolve()
  }
}

describe('BrowserOrigins', () => {
  it('lets a dev host and the empty document open, and asks for anything else', () => {
    const { rules } = origins()
    rules.setProject('s1', '/p')
    expect(rules.needsAsking('s1', 'http://localhost:5173/')).toBe(false)
    expect(rules.needsAsking('s1', 'about:blank')).toBe(false)
    expect(rules.needsAsking('s1', 'https://example.com/')).toBe(true)
  })

  it('lets an origin the session allowed open, and its scheme or port apart', async () => {
    const { rules } = origins()
    rules.setProject('s1', '/p')
    const answer = rules.ask('s1', 'https://example.com')
    rules.answer('s1', 1, 'session')
    expect(await answer).toBe('session')
    expect(rules.needsAsking('s1', 'https://example.com/a')).toBe(false)
    expect(rules.needsAsking('s1', 'http://example.com/a')).toBe(true)
    expect(rules.needsAsking('s1', 'https://example.com:8443/a')).toBe(true)
    // A session's set does not reach another session's page.
    expect(rules.needsAsking('s2', 'https://example.com/')).toBe(true)
  })

  it("stores a project's origin, and asks no longer for any of its sessions", async () => {
    const { rules, store } = origins()
    rules.setProject('s1', '/p')
    const answer = rules.ask('s1', 'https://example.com')
    rules.answer('s1', 1, 'project')
    expect(await answer).toBe('project')
    expect(store.allows('/p', 'https://example.com')).toBe(true)
    rules.setProject('s2', '/p')
    expect(rules.needsAsking('s2', 'https://example.com/x')).toBe(false)
    // Another project asks again.
    rules.setProject('s3', '/other')
    expect(rules.needsAsking('s3', 'https://example.com/')).toBe(true)
  })

  it('opens a project site without asking after a restart', async () => {
    const folder = await tempFolder()
    const first = await BrowserOriginStore.load(folder)
    const rules = new BrowserOrigins(first, {
      asked: () => {},
      settled: () => {},
      changed: () => {},
    })
    rules.setProject('s1', '/p')
    const answer = rules.ask('s1', 'https://example.com')
    rules.answer('s1', 1, 'project')
    await answer
    await first.flush()

    // A launch after the app quit reads the file again.
    const reopened = await BrowserOriginStore.load(folder)
    const after = new BrowserOrigins(reopened, {
      asked: () => {},
      settled: () => {},
      changed: () => {},
    })
    after.setProject('s2', '/p')
    expect(after.needsAsking('s2', 'https://example.com/x')).toBe(false)
  })

  it('refuses an origin the user denies, in the thread and to the call', async () => {
    const { rules, settled, changed } = origins()
    rules.setProject('s1', '/p')
    const answer = rules.ask('s1', 'https://example.com')
    expect(rules.requestOf('s1')).toMatchObject({
      origin: 'https://example.com',
      decision: null,
    })
    rules.answer('s1', 1, 'deny')
    expect(await answer).toBe('deny')
    expect(settled).toContainEqual({
      id: 1,
      sessionId: 's1',
      origin: 'https://example.com',
      decision: 'deny',
    })
    expect(changed).toContain('s1')
    expect(rules.needsAsking('s1', 'https://example.com/')).toBe(true)
  })

  it('turns no answer in 2 minutes into a refusal', async () => {
    vi.useFakeTimers()
    try {
      const { rules, settled } = origins()
      rules.setProject('s1', '/p')
      const answer = rules.ask('s1', 'https://example.com')
      await vi.advanceTimersByTimeAsync(ORIGIN_WAIT_MS)
      expect(await answer).toBe('timeout')
      expect(settled.at(-1)).toMatchObject({ decision: 'timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers only the request the session is shown, and ignores one that ended', async () => {
    const { rules, settled } = origins()
    rules.setProject('s1', '/p')
    const answer = rules.ask('s1', 'https://example.com')
    rules.answer('s2', 1, 'session')
    rules.answer('s1', 99, 'session')
    expect(rules.requestOf('s1')?.decision).toBeNull()
    rules.answer('s1', 1, 'session')
    expect(await answer).toBe('session')
    rules.answer('s1', 1, 'deny')
    expect(settled).toHaveLength(1)
  })

  it('refuses whatever a closed page waited for, and forgets its session', async () => {
    const { rules, settled } = origins()
    rules.setProject('s1', '/p')
    const answer = rules.ask('s1', 'https://example.com')
    rules.close('s1')
    expect(await answer).toBe('deny')
    expect(settled.at(-1)).toMatchObject({ decision: 'deny' })
    expect(rules.needsAsking('s1', 'https://example.com/')).toBe(true)
  })

  it('shows the answer in the pane for a while, then clears it', async () => {
    vi.useFakeTimers()
    try {
      const { rules, changed } = origins()
      rules.setProject('s1', '/p')
      const answer = rules.ask('s1', 'https://example.com')
      rules.answer('s1', 1, 'deny')
      await answer
      expect(rules.requestOf('s1')).toMatchObject({ decision: 'deny' })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(rules.requestOf('s1')).toBeNull()
      expect(changed.length).toBeGreaterThan(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
