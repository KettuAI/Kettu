import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeCall, RuntimeCalls } from './runtime/calls'
import { parseLegacyKettuOwners, readLegacyKettuOwners } from './legacy-owners'
import { ArtifactStore } from './store'
import { ArtifactTools } from './tools'
import { startThreadService } from '../threads/service'
import { ThreadStoreError, type ThreadStore } from '../threads/store'
import { schemaAt, SCHEMA_VERSION, ThreadDb, ThreadDbError } from '../threads/db'
import { EMPTY_SESSION } from '../threads/model'

const ACCOUNT_A = '6f9619ff-8b86-d011-b42d-00c04fc964ff'
const ACCOUNT_B = '7a1122bb-9c00-4d11-9e22-00c04fc964aa'
const LEGACY_A = 'art_01J9Z3K4V5W6X7Y8Z9A0B1C2D1'
const LEGACY_B = 'art_01J9Z3K4V5W6X7Y8Z9A0B1C2D2'
const LEGACY_CF = 'art_01J9Z3K4V5W6X7Y8Z9A0B1C2D3'
const LEGACY_LOCAL = 'art_01J9Z3K4V5W6X7Y8Z9A0B1C2D4'

const dirs: string[] = []
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-artifact-iso-'))
  dirs.push(dir)
  return dir
}

/** Runs the thread service in-process against a real SQLite file on disk. */
function threadsAt(folder: string): { store: ThreadStore; close: () => Promise<void> } {
  const pending = new Map<number, { resolve(value: unknown): void; reject(e: unknown): void }>()
  let next = 0
  const handle = startThreadService(
    { file: path.join(folder, 'state', 'threads.db'), contentDir: path.join(folder, 'content') },
    (reply) => {
      if (reply.type !== 'result' && reply.type !== 'error') return
      const waiting = pending.get(reply.id)
      pending.delete(reply.id)
      if (reply.type === 'result') waiting?.resolve(reply.value)
      else waiting?.reject(new ThreadStoreError(reply.message, reply.code, reply.data))
    },
  )
  const ask =
    (op: 'artifact' | 'runtime') =>
    (name: string, params: unknown): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const id = ++next
        pending.set(id, { resolve, reject })
        handle({ id, op, call: { name, params } as never })
      })
  const outputs = (sessionId: string, accountId: string | null = null): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = ++next
      pending.set(id, { resolve, reject })
      handle({ id, op: 'outputs', sessionId, accountId })
    })
  const close = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const id = ++next
      pending.set(id, { resolve: () => resolve(), reject })
      handle({ id, op: 'close' })
    })
  return {
    store: {
      artifact: ask('artifact'),
      runtime: ask('runtime'),
      outputs,
    } as unknown as ThreadStore,
    close,
  }
}

function makeStore(
  folder: string,
  threads: ThreadStore,
  initialAccountId: string | null,
  hooks: {
    changed?: () => void
    accountChanged?: () => void
    unwatched?: (id: string) => void
    now?: () => number
  } = {},
): ArtifactStore {
  let tick = Date.now()
  return new ArtifactStore({
    threads,
    contentDir: path.join(folder, 'content'),
    log: () => {},
    initialAccountId,
    changed: () => hooks.changed?.(),
    accountChanged: () => hooks.accountChanged?.(),
    unwatched: (id) => hooks.unwatched?.(id),
    now: hooks.now ?? (() => ++tick),
    version: () => {},
    activity: () => {},
  })
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('artifact account isolation (A -> B -> A, signed-out, restart, legacy)', () => {
  it('isolates A-owned artifacts across A -> B -> A switches while keeping unowned local artifacts unowned and preserving all underlying data', async () => {
    const dir = tempDir()
    const project = path.join(dir, 'project')
    mkdirSync(project, { recursive: true })
    const { store: threads, close } = threadsAt(dir)
    const unwatched: string[] = []
    let changedCalls = 0
    let accountChangedCalls = 0
    const store = makeStore(dir, threads, null, {
      changed: () => changedCalls++,
      accountChanged: () => accountChangedCalls++,
      unwatched: (id) => unwatched.push(id),
    })
    const tools = new ArtifactTools({
      store,
      sessionTitle: () => 'Session',
      runningTurn: () => null,
    })
    const caller = { sessionId: 's1', project }

    // Signed out: create a purely local unowned artifact.
    const local = await store.create({
      project,
      sessionId: 's1',
      title: 'Purely Local',
      files: [{ path: 'index.html', data: bytes('<p>local</p>') }],
      pages: 1,
      note: null,
    })
    expect((await store.get(local.id)).artifact.ownerAccountId).toBeNull()

    // Sign in as A: create an owned artifact, add a second version, a comment, runtime data, and consent.
    store.setAccount(ACCOUNT_A)
    const ownedA = await store.create({
      project,
      sessionId: 's1',
      title: 'Account A Secret Plan',
      files: [{ path: 'index.html', data: bytes('<h1>Secret A</h1>') }],
      pages: 1,
      note: null,
      declaration: { capabilities: ['db', 'files'], runtime: 1 },
    })
    expect((await store.get(ownedA.id)).artifact.ownerAccountId).toBe(ACCOUNT_A)
    await store.write({
      id: ownedA.id,
      baseVersion: 1,
      changes: [{ path: 'index.html', data: bytes('<h1>Secret A v2</h1>') }],
      pages: 1,
      author: 's1',
      note: 'v2',
    })
    const threadA = await store.addThread(ownedA.id, {
      anchor: {
        version: 2,
        path: 'index.html',
        page: null,
        offset: 0,
        tag: 'h1',
        text: 'Secret A v2',
        missing: false,
      },
      author: { person: 'owner', session: null },
      body: 'Private note from A',
    })
    await store.runtime('dataPut', {
      id: ownedA.id,
      project: null,
      collection: 'notes',
      docId: 'n1',
      mode: 'set',
      json: JSON.stringify({ secret: true }),
      baseVersion: null,
      docLimit: 1024,
      limit: 4096,
      at: 10,
    })
    await store.runtime('consentGrant', { id: ownedA.id, capability: 'files', at: 11 })
    await store.watch(ownedA.id, 'port-a')
    expect(await store.changes(ownedA.id, 1, 2)).toEqual({ kind: 'files', paths: ['index.html'] })

    // Also create a soft-deleted artifact owned by A to verify Recently deleted isolation.
    const deletedA = await store.create({
      project,
      sessionId: 's1',
      title: 'Deleted By A',
      files: [{ path: 'index.html', data: bytes('<p>trash A</p>') }],
      pages: 1,
      note: null,
    })
    await store.delete(deletedA.id)

    // Switch A -> B.
    const changedBefore = changedCalls
    const accountBefore = accountChangedCalls
    store.setAccount(ACCOUNT_B)
    expect(changedCalls).toBeGreaterThan(changedBefore)
    expect(accountChangedCalls).toBe(accountBefore + 1)
    expect(unwatched).toContain(ownedA.id)

    // B sees only the unowned local artifact; A's live and deleted artifacts are hidden.
    expect((await store.list()).map((a) => a.id)).toEqual([local.id])
    expect((await store.list({ deleted: true })).map((a) => a.id)).toEqual([])
    expect(new Set(await store.hiddenIds())).toEqual(new Set([ownedA.id, deletedA.id]))
    // The unowned local artifact was NOT claimed by B on account switch.
    expect((await store.get(local.id)).artifact.ownerAccountId).toBeNull()

    // B is denied every read, write, comment, watch, canvas, runtime data, and consent call on A's artifacts.
    await expect(store.get(ownedA.id)).rejects.toMatchObject({ reason: 'not_found' })
    await expect(store.read(ownedA.id)).rejects.toMatchObject({ reason: 'not_found' })
    await expect(store.versions(ownedA.id)).rejects.toMatchObject({ reason: 'not_found' })
    await expect(store.changes(ownedA.id, 1, 2)).rejects.toMatchObject({ reason: 'not_found' })
    await expect(store.content(ownedA.id)).rejects.toMatchObject({ reason: 'not_found' })
    await expect(
      store.write({
        id: ownedA.id,
        baseVersion: 2,
        changes: [{ path: 'index.html', data: bytes('<p>tamper</p>') }],
        pages: 1,
        author: null,
        note: null,
      }),
    ).rejects.toMatchObject({ reason: 'not_found' })
    await expect(
      store.restore({ id: ownedA.id, version: 1, baseVersion: 2, author: null }),
    ).rejects.toMatchObject({ reason: 'not_found' })
    await expect(store.rename(ownedA.id, 'Hijacked')).rejects.toMatchObject({ reason: 'not_found' })
    await expect(store.delete(ownedA.id)).rejects.toMatchObject({ reason: 'not_found' })
    await expect(store.undelete(deletedA.id)).rejects.toMatchObject({ reason: 'not_found' })
    await expect(store.erase(deletedA.id)).rejects.toMatchObject({ reason: 'not_found' })
    await expect(store.see(ownedA.id, 2)).rejects.toMatchObject({ reason: 'not_found' })
    await expect(store.threads(ownedA.id)).rejects.toMatchObject({ reason: 'not_found' })
    await expect(
      store.addThread(ownedA.id, {
        anchor: threadA.anchor,
        author: { person: 'owner', session: null },
        body: 'Intrusion',
      }),
    ).rejects.toMatchObject({ reason: 'not_found' })
    await expect(
      store.reply(ownedA.id, threadA.id, {
        author: { person: 'owner', session: null },
        body: 'Intrusion',
      }),
    ).rejects.toMatchObject({ reason: 'not_found' })
    await expect(store.resolve(ownedA.id, threadA.id, true)).rejects.toMatchObject({
      reason: 'not_found',
    })
    await expect(store.deleteThread(ownedA.id, threadA.id)).rejects.toMatchObject({
      reason: 'not_found',
    })
    await expect(store.repin(ownedA.id, threadA.id, threadA.anchor)).rejects.toMatchObject({
      reason: 'not_found',
    })
    await expect(store.markSent(ownedA.id, [threadA.id], 's1')).rejects.toMatchObject({
      reason: 'not_found',
    })
    await expect(store.watch(ownedA.id, 'port-b')).rejects.toMatchObject({ reason: 'not_found' })
    await expect(
      store.editElement({
        id: ownedA.id,
        baseVersion: 2,
        path: 'index.html',
        offset: 0,
        change: { style: null, text: 'x' },
      }),
    ).rejects.toMatchObject({ reason: 'not_found' })
    await expect(store.canvases.state(ownedA.id)).rejects.toMatchObject({ reason: 'not_found' })
    await expect(
      store.runtime('declaration', { id: ownedA.id, project: null, version: null }),
    ).rejects.toMatchObject({ reason: 'not_found' })
    await expect(
      store.runtime('dataGet', {
        id: ownedA.id,
        project: null,
        collection: 'notes',
        docId: 'n1',
      }),
    ).rejects.toMatchObject({ reason: 'not_found' })
    await expect(
      store.runtime('dataPut', {
        id: ownedA.id,
        project: null,
        collection: 'notes',
        docId: 'n2',
        mode: 'set',
        json: '{}',
        baseVersion: null,
        docLimit: 1024,
        limit: 4096,
        at: 20,
      }),
    ).rejects.toMatchObject({ reason: 'not_found' })
    await expect(store.runtime('consentRevoke', { id: ownedA.id })).rejects.toMatchObject({
      reason: 'not_found',
    })
    expect(await store.runtime('consentOf', { id: ownedA.id })).toEqual([])
    expect(await store.runtime('consents', undefined)).toEqual([])

    // MCP artifact tools under B also hide A and reject direct id access.
    const listedByTool = await tools.call(caller, 'list_artifacts', {})
    expect(listedByTool.isError).toBeFalsy()
    expect(
      ((listedByTool.structuredContent as { artifacts: { id: string }[] }).artifacts ?? []).map(
        (a) => a.id,
      ),
    ).toEqual([local.id])
    for (const [toolName, args] of [
      ['read_artifact', { id: ownedA.id }],
      ['update_artifact', { id: ownedA.id, base_version: 2, html: '<p>x</p>' }],
      ['delete_artifact', { id: ownedA.id }],
      ['read_comments', { id: ownedA.id }],
    ] as const) {
      const res = await tools.call(caller, toolName, args)
      expect(res.isError).toBe(true)
      expect((res.structuredContent as { code: string }).code).toBe('not_found')
    }

    // Create an artifact owned by B.
    const ownedB = await store.create({
      project,
      sessionId: 's1',
      title: 'Account B Artifact',
      files: [{ path: 'index.html', data: bytes('<h1>B</h1>') }],
      pages: 1,
      note: null,
    })
    expect((await store.list()).map((a) => a.id)).toEqual([ownedB.id, local.id])

    // Signed out: both A and B artifacts are hidden, purely local stays visible and unowned.
    store.setAccount(null)
    expect((await store.list()).map((a) => a.id)).toEqual([local.id])
    expect(new Set(await store.hiddenIds())).toEqual(new Set([ownedA.id, deletedA.id, ownedB.id]))
    await expect(store.get(ownedA.id)).rejects.toMatchObject({ reason: 'not_found' })
    await expect(store.get(ownedB.id)).rejects.toMatchObject({ reason: 'not_found' })

    // Switch back to A: all of A's artifacts, versions, comments, data, and consents return intact;
    // B's artifact is now hidden, and local remains unowned.
    store.setAccount(ACCOUNT_A)
    expect((await store.list()).map((a) => a.id)).toEqual([ownedA.id, local.id])
    expect((await store.list({ deleted: true })).map((a) => a.id)).toEqual([deletedA.id])
    expect(await store.hiddenIds()).toEqual([ownedB.id])
    expect((await store.get(local.id)).artifact.ownerAccountId).toBeNull()
    const restoredA = await store.get(ownedA.id)
    expect(restoredA.artifact.title).toBe('Account A Secret Plan')
    expect(restoredA.version.version).toBe(2)
    expect((await store.threads(ownedA.id)).map((t) => t.comments[0]?.body)).toEqual([
      'Private note from A',
    ])
    expect(
      (
        await store.runtime('dataGet', {
          id: ownedA.id,
          project: null,
          collection: 'notes',
          docId: 'n1',
        })
      )?.value,
    ).toEqual({ secret: true })
    expect(await store.runtime('consentOf', { id: ownedA.id })).toEqual(['files'])
    expect((await store.runtime('consents', undefined)).map((c) => c.id)).toEqual([ownedA.id])
    await expect(store.get(ownedB.id)).rejects.toMatchObject({ reason: 'not_found' })

    // Claiming an unowned local artifact when A publishes it to Kettu binds ownership to A.
    expect(await store.claimOwner(local.id, ACCOUNT_A)).toBe(true)
    expect((await store.get(local.id)).artifact.ownerAccountId).toBe(ACCOUNT_A)
    // Claiming never overwrites an existing owner.
    expect(await store.claimOwner(local.id, ACCOUNT_B)).toBe(false)
    store.setAccount(ACCOUNT_B)
    expect((await store.list()).map((a) => a.id)).toEqual([ownedB.id])
    await expect(store.get(local.id)).rejects.toMatchObject({ reason: 'not_found' })

    await close()
  })

  it('persists ownership and isolation across restarts', async () => {
    const dir = tempDir()
    const project = path.join(dir, 'project')
    mkdirSync(project, { recursive: true })

    // Run 1: create A-owned, unowned local, and B-owned artifacts, then shut down.
    let ownedAId: string
    let ownedBId: string
    let localId: string
    {
      const { store: threads, close } = threadsAt(dir)
      const store = makeStore(dir, threads, ACCOUNT_A)
      ownedAId = (
        await store.create({
          project,
          sessionId: 's1',
          title: 'A Persisted',
          files: [{ path: 'index.html', data: bytes('<p>A</p>') }],
          pages: 1,
          note: null,
        })
      ).id
      store.setAccount(null)
      localId = (
        await store.create({
          project,
          sessionId: 's1',
          title: 'Local Persisted',
          files: [{ path: 'index.html', data: bytes('<p>L</p>') }],
          pages: 1,
          note: null,
        })
      ).id
      store.setAccount(ACCOUNT_B)
      ownedBId = (
        await store.create({
          project,
          sessionId: 's1',
          title: 'B Persisted',
          files: [{ path: 'index.html', data: bytes('<p>B</p>') }],
          pages: 1,
          note: null,
        })
      ).id
      await close()
    }

    // Run 2: restart signed into B.
    {
      const { store: threads, close } = threadsAt(dir)
      const store = makeStore(dir, threads, ACCOUNT_B)
      expect((await store.list()).map((a) => a.id)).toEqual([ownedBId, localId])
      expect(await store.hiddenIds()).toEqual([ownedAId])
      await expect(store.get(ownedAId)).rejects.toMatchObject({ reason: 'not_found' })
      expect((await store.get(localId)).artifact.ownerAccountId).toBeNull()
      await close()
    }

    // Run 3: restart signed into A.
    {
      const { store: threads, close } = threadsAt(dir)
      const store = makeStore(dir, threads, ACCOUNT_A)
      expect((await store.list()).map((a) => a.id)).toEqual([localId, ownedAId])
      expect(await store.hiddenIds()).toEqual([ownedBId])
      await expect(store.get(ownedBId)).rejects.toMatchObject({ reason: 'not_found' })
      expect((await store.get(ownedAId)).artifact.title).toBe('A Persisted')
      expect((await store.get(localId)).artifact.ownerAccountId).toBeNull()
      await close()
    }
  })

  it('migrates schema v13 databases and backfills ownership only from reliable legacy Kettu publish records', async () => {
    const dir = tempDir()
    const dbFile = path.join(dir, 'state', 'threads.db')
    const contentDir = path.join(dir, 'content')
    mkdirSync(path.dirname(dbFile), { recursive: true })
    mkdirSync(contentDir, { recursive: true })

    // Build a genuine schema v13 database with four legacy artifacts (no owner_account_id column).
    const raw = new DatabaseSync(dbFile)
    raw.exec(`BEGIN; ${schemaAt(13)} PRAGMA user_version = 13; COMMIT;`)
    for (const [id, title, at] of [
      [LEGACY_A, 'Legacy A Kettu', 1],
      [LEGACY_B, 'Legacy B Kettu', 2],
      [LEGACY_CF, 'Legacy Cloudflare Only', 3],
      [LEGACY_LOCAL, 'Legacy Purely Local', 4],
    ] as const) {
      raw
        .prepare(
          'INSERT INTO artifacts (id, project, title, head, session_id, created_at, updated_at, seen) VALUES (?, ?, ?, 1, ?, ?, ?, 1)',
        )
        .run(id, '/p', title, 's1', at, at)
      raw
        .prepare(
          'INSERT INTO artifact_versions (artifact_id, n, size, pages, author, note, created_at) VALUES (?, 1, 10, 1, NULL, NULL, ?)',
        )
        .run(id, at)
      raw
        .prepare(
          'INSERT INTO artifact_files (artifact_id, n, path, hash, size) VALUES (?, 1, ?, ?, 10)',
        )
        .run(id, 'index.html', 'a'.repeat(64))
    }
    raw.close()

    // Legacy v2 published-artifacts.json with reliable Kettu accountIds and a Cloudflare entry.
    writeFileSync(
      path.join(dir, 'published-artifacts.json'),
      JSON.stringify({
        version: 2,
        account: null,
        published: [
          {
            id: LEGACY_A,
            target: 'kettu',
            ref: 'aaaaaaaaaa',
            url: 'https://aaaaaaaaaa.pages.example/',
            version: 1,
            publishedAt: 10,
            accountId: ACCOUNT_A,
            accountEmail: 'a@example.com',
          },
          {
            id: LEGACY_B,
            target: 'kettu',
            ref: 'bbbbbbbbbb',
            url: 'https://bbbbbbbbbb.pages.example/',
            version: 1,
            publishedAt: 20,
            accountId: ACCOUNT_B,
            accountEmail: 'b@example.com',
          },
          {
            id: LEGACY_CF,
            target: 'cloudflare',
            ref: 'ob-abcdefghijklmnop',
            url: 'https://ob-abcdefghijklmnop.user.workers.dev/',
            version: 1,
            publishedAt: 30,
            accountId: '0123456789abcdef0123456789abcdef',
            accountEmail: null,
          },
        ],
      }),
    )

    const owners = await readLegacyKettuOwners(dir)
    expect(owners).toEqual([
      { id: LEGACY_A, accountId: ACCOUNT_A },
      { id: LEGACY_B, accountId: ACCOUNT_B },
    ])

    const db = ThreadDb.open(
      dbFile,
      () => {},
      () => 100,
      contentDir,
    )
    expect(db.status).toBe('ok')
    expect(db.claimArtifactOwners(owners)).toEqual({ changed: 2 })
    // Re-running backfill is idempotent and never alters existing owners.
    expect(db.claimArtifactOwners(owners)).toEqual({ changed: 0 })

    // Under B: LEGACY_A is isolated; LEGACY_B, LEGACY_CF, and LEGACY_LOCAL are visible.
    expect(
      db.listArtifacts({ project: null, deleted: false, accountId: ACCOUNT_B }).map((a) => a.id),
    ).toEqual([LEGACY_LOCAL, LEGACY_CF, LEGACY_B])
    expect(db.hiddenArtifactIds(ACCOUNT_B)).toEqual([LEGACY_A])
    expect(() =>
      db.getArtifact({ id: LEGACY_A, version: null, project: null, accountId: ACCOUNT_B }),
    ).toThrow(ThreadDbError)

    // Unowned legacy artifacts remain NULL even after listing/opening under B and A.
    expect(
      db.getArtifact({ id: LEGACY_LOCAL, version: null, project: null, accountId: ACCOUNT_B })
        .artifact.ownerAccountId,
    ).toBeNull()
    expect(
      db.getArtifact({ id: LEGACY_CF, version: null, project: null, accountId: ACCOUNT_B }).artifact
        .ownerAccountId,
    ).toBeNull()

    // Under A: LEGACY_A is restored; LEGACY_B is hidden; unowned legacy artifacts remain NULL.
    expect(
      db.listArtifacts({ project: null, deleted: false, accountId: ACCOUNT_A }).map((a) => a.id),
    ).toEqual([LEGACY_LOCAL, LEGACY_CF, LEGACY_A])
    expect(db.hiddenArtifactIds(ACCOUNT_A)).toEqual([LEGACY_B])
    expect(
      db.getArtifact({ id: LEGACY_LOCAL, version: null, project: null, accountId: ACCOUNT_A })
        .artifact.ownerAccountId,
    ).toBeNull()

    // Under signed-out: both legacy Kettu artifacts are hidden; unowned local ones stay visible.
    expect(
      db.listArtifacts({ project: null, deleted: false, accountId: null }).map((a) => a.id),
    ).toEqual([LEGACY_LOCAL, LEGACY_CF])

    // Session outputs filter out artifacts owned by another account while keeping visible ones.
    db.write('s1', {
      replace: true,
      head: { agentId: 'claude-code', acpSessionId: 'acp-1' },
      session: { ...EMPTY_SESSION, title: 'Mixed Session' },
      entries: [
        {
          pos: 0,
          entry: {
            kind: 'artifact',
            id: 'e1',
            artifactId: LEGACY_A,
            title: 'Legacy A Kettu',
            action: 'create',
            version: 1,
            writes: 1,
            after: 't1',
          },
        },
        {
          pos: 1,
          entry: {
            kind: 'artifact',
            id: 'e2',
            artifactId: LEGACY_LOCAL,
            title: 'Legacy Purely Local',
            action: 'create',
            version: 1,
            writes: 1,
            after: 't2',
          },
        },
        {
          pos: 2,
          entry: {
            kind: 'artifact',
            id: 'e3',
            artifactId: LEGACY_B,
            title: 'Legacy B Kettu',
            action: 'create',
            version: 1,
            writes: 1,
            after: 't3',
          },
        },
      ],
    })
    expect(db.outputs('s1', ACCOUNT_B)?.outputs.artifacts.map((a) => a.id)).toEqual([
      LEGACY_B,
      LEGACY_LOCAL,
    ])
    expect(db.outputs('s1', ACCOUNT_A)?.outputs.artifacts.map((a) => a.id)).toEqual([
      LEGACY_LOCAL,
      LEGACY_A,
    ])
    expect(db.outputs('s1', null)?.outputs.artifacts.map((a) => a.id)).toEqual([LEGACY_LOCAL])

    // Verify all physical briefs are still reported for sharing reconciliation.
    const briefs = db.artifactBriefs()
    expect(briefs).toHaveLength(4)
    expect(briefs.find((b) => b.id === LEGACY_A)?.ownerAccountId).toBe(ACCOUNT_A)
    expect(briefs.find((b) => b.id === LEGACY_LOCAL)?.ownerAccountId).toBeNull()

    // Runtime call helper check: schema upgraded to SCHEMA_VERSION.
    const callRuntime = <K extends keyof RuntimeCalls>(
      name: K,
      params: RuntimeCalls[K]['params'],
    ) => db.runtime({ name, params } as RuntimeCall) as RuntimeCalls[K]['result']
    expect(
      callRuntime('declaration', {
        id: LEGACY_A,
        project: null,
        version: null,
        accountId: ACCOUNT_A,
      }).id,
    ).toBe(LEGACY_A)
    expect(() =>
      callRuntime('declaration', {
        id: LEGACY_A,
        project: null,
        version: null,
        accountId: ACCOUNT_B,
      }),
    ).toThrow(ThreadDbError)

    db.close()
    const check = new DatabaseSync(dbFile)
    expect(check.prepare('PRAGMA user_version').get()!.user_version).toBe(SCHEMA_VERSION)
    check.close()
  })

  it('ignores malformed or v1 published-artifacts payloads when reading legacy owners', () => {
    expect(parseLegacyKettuOwners(null)).toEqual([])
    expect(
      parseLegacyKettuOwners({
        version: 1,
        published: [{ id: LEGACY_A, target: 'kettu', accountId: ACCOUNT_A }],
      }),
    ).toEqual([])
    expect(
      parseLegacyKettuOwners({
        version: 3,
        published: [
          { id: 'bad-id', target: 'kettu', accountId: ACCOUNT_A },
          { id: LEGACY_A, target: 'kettu', accountId: '' },
          { id: LEGACY_CF, target: 'cloudflare', accountId: '0123456789abcdef0123456789abcdef' },
        ],
      }),
    ).toEqual([])
  })
})
