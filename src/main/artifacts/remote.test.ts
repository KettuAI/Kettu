import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeAnswer } from '@shared/artifact-capabilities'
import { artifactRef } from '@shared/artifacts'
import { ArtifactOrigins, originId } from './origins'
import { isStored } from './protocol'
import { parseRead, RemoteArtifacts } from './remote'

const HOST_A = 'a'.repeat(32)
const HOST_B = 'b'.repeat(32)
const ID = 'art_01J9Z3K4V5W6X7Y8Z9A0B1C2D3'
const FRAME = `/frame/${'t'.repeat(43)}/`

type Call = { hostId: string; method: string; params: Record<string, unknown> }

let dir: string
let calls: Call[]
let answer: (call: Call) => unknown
let remote: RemoteArtifacts

function remoteIn(folder: string, maxBytes?: number): RemoteArtifacts {
  return new RemoteArtifacts({
    dir: folder,
    ...(maxBytes === undefined ? {} : { maxBytes }),
    call: async (hostId, method, params) => {
      const call = { hostId, method, params: params as Record<string, unknown> }
      calls.push(call)
      return answer(call)
    },
  })
}

const fileCalls = () => calls.filter((c) => c.method === 'artifacts.file')

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-remote-'))
  calls = []
  answer = ({ hostId, method, params }) => {
    if (method === 'artifacts.read') {
      return {
        title: `On ${hostId[0]}`,
        version: (params.version as number | undefined) ?? 2,
        html: '',
        files: [
          { path: 'index.html', size: 1, type: 'text/html' },
          { path: 'img/a.png', size: 1, type: 'image/png' },
        ],
      }
    }
    if (method === 'artifacts.file') {
      const text = `${hostId[0]}:${String(params.path)}:v${String(params.version)}`
      return { type: '', bytes: new TextEncoder().encode(text) }
    }
    if (method === 'artifacts.openFrame') return { path: FRAME }
    throw { code: 'unknown_method', message: method }
  }
  remote = remoteIn(path.join(dir, 'remote'))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("another host's answer to artifacts.read", () => {
  const read = (files: unknown): unknown => ({ title: 'T', version: 1, html: '', files })

  it('is taken when every file has a path inside the artifact', () => {
    expect(parseRead(read([{ path: 'a/b.css', size: 3 }]))?.files).toEqual([
      { path: 'a/b.css', size: 3 },
    ])
  })

  it('is refused when a path leaves the artifact, is absolute or comes twice', () => {
    expect(parseRead(read([{ path: '../x', size: 1 }]))).toBeNull()
    expect(parseRead(read([{ path: '/etc/passwd', size: 1 }]))).toBeNull()
    expect(
      parseRead(
        read([
          { path: 'a', size: 1 },
          { path: 'a', size: 1 },
        ]),
      ),
    ).toBeNull()
  })

  it('is refused with more files or bytes than a version may have', () => {
    const many = Array.from({ length: 257 }, (_, i) => ({ path: `f${i}`, size: 1 }))
    expect(parseRead(read(many))).toBeNull()
    expect(parseRead(read([{ path: 'big', size: 65 * 1024 * 1024 }]))).toBeNull()
    expect(parseRead({ title: 'T', version: 0, html: '', files: [] })).toBeNull()
  })
})

describe("another host's artifacts in main", () => {
  it('have an origin of their own, apart from the same id here and on a third host', () => {
    const origins = new Set([
      originId(ID),
      originId(artifactRef(HOST_A, ID)),
      originId(artifactRef(HOST_B, ID)),
    ])
    expect(origins.size).toBe(3)
    const served = new ArtifactOrigins()
    served.serve(artifactRef(HOST_A, ID))
    expect(served.artifactOf(originId(artifactRef(HOST_A, ID)))).toBe(artifactRef(HOST_A, ID))
    expect(served.artifactOf(originId(ID))).toBeUndefined()
    expect(served.artifactOf(originId(artifactRef(HOST_B, ID)))).toBeUndefined()
  })

  it("are served only from the folder main fetched into, and this computer's never from it", () => {
    const source = { contentDir: path.join(dir, 'content'), remoteDir: path.join(dir, 'remote') }
    const fetched = path.join(dir, 'remote', 'x', '0')
    const own = path.join(dir, 'content', 'ab')
    expect(isStored(source, artifactRef(HOST_A, ID), fetched)).toBe(true)
    expect(isStored(source, artifactRef(HOST_A, ID), own)).toBe(false)
    expect(isStored(source, ID, fetched)).toBe(false)
    expect(isStored(source, ID, own)).toBe(true)
    expect(isStored({ contentDir: source.contentDir }, artifactRef(HOST_A, ID), fetched)).toBe(
      false,
    )
  })

  it('fetches a version from its host into its own folder, apart from another host under the same id', async () => {
    const a = await remote.content(HOST_A, ID, 2)
    const b = await remote.content(HOST_B, ID, 2)
    await remote.fetch(HOST_A, ID, 2, null)
    await remote.fetch(HOST_B, ID, 2, null)
    if (a.kind !== 'found' || b.kind !== 'found') throw new Error('not found')
    expect(a.title).toBe('On a')
    expect(a.key).not.toBe(b.key)
    expect(a.strict).toBe(false)
    for (const file of [...a.files, ...b.files]) {
      expect(
        isStored(
          { contentDir: dir, remoteDir: path.join(dir, 'remote') },
          artifactRef(HOST_A, ID),
          file.file,
        ),
      ).toBe(true)
    }
    expect(a.files.map((f) => readFileSync(f.file, 'utf8'))).toEqual([
      'a:index.html:v2',
      'a:img/a.png:v2',
    ])
    expect(b.files.map((f) => readFileSync(f.file, 'utf8'))).toEqual([
      'b:index.html:v2',
      'b:img/a.png:v2',
    ])
    expect(
      calls.filter((c) => c.method === 'artifacts.file').every((c) => c.params.version === 2),
    ).toBe(true)
  })

  it('fetches the files of a version once, however often it is asked for', async () => {
    await Promise.all([remote.fetch(HOST_A, ID, 2, null), remote.fetch(HOST_A, ID, 2, null)])
    remote.changed()
    await remote.fetch(HOST_A, ID, 2, null)
    expect(fileCalls()).toHaveLength(2)
  })

  it('names the files of a version without fetching them, and fetches only those asked for', async () => {
    const found = await remote.content(HOST_A, ID, 2)
    if (found.kind !== 'found') throw new Error('not found')
    expect(fileCalls()).toHaveLength(0)
    await remote.fetch(HOST_A, ID, 2, ['index.html'])
    expect(fileCalls().map((c) => c.params.path)).toEqual(['index.html'])
    expect(readFileSync(found.files[0]!.file, 'utf8')).toBe('a:index.html:v2')
    expect(existsSync(found.files[1]!.file)).toBe(false)
    // A path the version does not list is never asked of the host.
    await remote.fetch(HOST_A, ID, 2, ['../other.html'])
    expect(fileCalls()).toHaveLength(1)
  })

  it('keeps fetched files for the next run, and fetches a new version anew', async () => {
    await remote.fetch(HOST_A, ID, 2, null)
    const again = remoteIn(path.join(dir, 'remote'))
    await again.prune()
    const kept = await again.content(HOST_A, ID, 2)
    await again.fetch(HOST_A, ID, 2, null)
    expect(fileCalls()).toHaveLength(2)
    if (kept.kind !== 'found') throw new Error('not found')
    expect(readFileSync(kept.files[0]!.file, 'utf8')).toBe('a:index.html:v2')
    const next = await again.content(HOST_A, ID, 3)
    await again.fetch(HOST_A, ID, 3, ['index.html'])
    if (next.kind !== 'found') throw new Error('not found')
    expect(fileCalls()).toHaveLength(3)
    expect(next.files[0]!.file).not.toBe(kept.files[0]!.file)
    expect(readFileSync(next.files[0]!.file, 'utf8')).toBe('a:index.html:v3')
  })

  it('fetches again a file a run left unfinished', async () => {
    const found = await remote.content(HOST_A, ID, 2)
    if (found.kind !== 'found') throw new Error('not found')
    await remote.fetch(HOST_A, ID, 2, ['index.html'])
    const folder = path.dirname(found.files[0]!.file)
    rmSync(found.files[0]!.file)
    writeFileSync(`${found.files[0]!.file}.1.part`, 'a:ind')
    const again = remoteIn(path.join(dir, 'remote'))
    await again.prune()
    expect(readdirSync(folder)).toEqual([])
    await again.fetch(HOST_A, ID, 2, ['index.html'])
    expect(fileCalls()).toHaveLength(2)
    expect(readFileSync(found.files[0]!.file, 'utf8')).toBe('a:index.html:v2')
  })

  it('stays within its size, the versions used longest ago going first', async () => {
    const small = remoteIn(path.join(dir, 'small'), 40)
    const two = await small.content(HOST_A, ID, 2)
    const three = await small.content(HOST_A, ID, 3)
    if (two.kind !== 'found' || three.kind !== 'found') throw new Error('not found')
    await small.fetch(HOST_A, ID, 2, null)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await small.fetch(HOST_A, ID, 3, null)
    await small.prune()
    expect(existsSync(two.files[0]!.file)).toBe(false)
    expect(existsSync(three.files[0]!.file)).toBe(true)
  })

  it('says not found, failed or nothing usable as the host answers', async () => {
    answer = () => {
      throw { code: 'not_found', message: 'gone' }
    }
    expect(await remote.content(HOST_A, ID, null)).toEqual({ kind: 'not_found' })
    answer = () => {
      throw { code: 'host_offline', message: 'offline' }
    }
    expect(await remote.content(HOST_A, ID, null)).toEqual({ kind: 'failed' })
    // A host that answers with another version than the one asked for.
    answer = () => ({ title: 'T', version: 9, html: '', files: [] })
    expect(await remote.content(HOST_A, ID, 2)).toEqual({ kind: 'failed' })
    answer = () => ({ title: 'T', version: 1, html: '', files: [{ path: '../../x', size: 1 }] })
    expect(await remote.content(HOST_A, ID, 1)).toEqual({ kind: 'failed' })
    expect(existsSync(path.join(dir, 'x'))).toBe(false)
  })

  it("passes a page's message to its host through a frame opened there, once", async () => {
    const base = answer
    answer = (call) =>
      call.method === 'artifacts.frameRuntime' ? { v: 1, id: 'm1', ok: true, value: 7 } : base(call)
    const answers: RuntimeAnswer[] = []
    const message = { v: 1, id: 'm1', kind: 'call', cap: 'db', op: 'get' }
    await new Promise<void>((resolve) => {
      remote.runtime(HOST_A, ID, message, (next) => {
        answers.push(next)
        resolve()
      })
    })
    await new Promise<void>((resolve) => remote.runtime(HOST_A, ID, message, () => resolve()))
    expect(answers).toEqual([{ v: 1, id: 'm1', ok: true, value: 7 }])
    expect(calls.filter((c) => c.method === 'artifacts.openFrame')).toEqual([
      { hostId: HOST_A, method: 'artifacts.openFrame', params: { id: ID } },
    ])
    const sent = calls.filter((c) => c.method === 'artifacts.frameRuntime')
    expect(sent).toHaveLength(2)
    expect(sent[0]).toEqual({
      hostId: HOST_A,
      method: 'artifacts.frameRuntime',
      params: { path: FRAME, message },
    })
  })

  it("gives a stream only its own host's events", async () => {
    const base = answer
    let end: (answer: RuntimeAnswer) => void = () => {}
    answer = (call) =>
      call.method === 'artifacts.frameRuntime'
        ? new Promise<RuntimeAnswer>((resolve) => (end = resolve))
        : base(call)
    const answers: RuntimeAnswer[] = []
    const done = new Promise<void>((resolve) => {
      remote.runtime(HOST_A, ID, { v: 1, id: 's1', kind: 'stream' }, (next) => {
        answers.push(next)
        if (!('event' in next)) resolve()
      })
    })
    await expect.poll(() => calls.some((c) => c.method === 'artifacts.frameRuntime')).toBe(true)
    const stream = calls.find((c) => c.method === 'artifacts.frameRuntime')!.params.stream
    remote.streamed(HOST_B, { stream, answer: { v: 1, id: 's1', event: 'other host' } })
    remote.streamed(HOST_A, { stream: 'main:999', answer: { v: 1, id: 's1', event: 'other' } })
    remote.streamed(HOST_A, { stream, answer: { v: 1, id: 's1', event: 'own' } })
    end({ v: 1, id: 's1', done: true })
    await done
    expect(answers).toEqual([
      { v: 1, id: 's1', event: 'own' },
      { v: 1, id: 's1', done: true },
    ])
  })
})
