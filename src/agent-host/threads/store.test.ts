import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { ThreadEntry } from '@shared/thread'
import { inThreadWorker } from '../testing/thread-worker'
import type { ThreadWrite } from './model'
import type { ThreadWorkerData } from './protocol'
import { ThreadStore, type ThreadWorker } from './store'

const dirs: string[] = []
const stores: ThreadStore[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-thread-store-'))
  dirs.push(dir)
  return path.join(dir, 'threads.db')
}

const user = (id: string): ThreadEntry => ({
  kind: 'user',
  id,
  content: [{ type: 'text', text: id }],
})
const change = (...ids: string[]): ThreadWrite => ({
  head: { agentId: 'fake-agent', acpSessionId: 'acp' },
  entries: ids.map((id, pos) => ({ pos, entry: user(id) })),
})

/** The worker, whose exit a test can cause as a crash would. */
interface Crashable extends ThreadWorker {
  crash(): void
}

function crashable(worker: ThreadWorker): Crashable {
  let exit: ((error: Error | null) => void) | null = null
  let gone = false
  return {
    postMessage: (request) => {
      if (!gone) worker.postMessage(request)
    },
    onMessage: (listener) => worker.onMessage((reply) => !gone && listener(reply)),
    onExit: (listener) => {
      exit = listener
      worker.onExit((error) => !gone && listener(error))
    },
    terminate: () => worker.terminate(),
    crash: () => {
      gone = true
      void worker.terminate()
      exit?.(new Error('exited with code 1'))
    },
  }
}

/** A worker that answers in order, as a thread does, and holds a full load until `release`. */
function busy(worker: ThreadWorker, held: Promise<void>): ThreadWorker {
  let queue = Promise.resolve()
  return {
    ...worker,
    postMessage: (request) => {
      queue = queue.then(async () => {
        if (request.op === 'load') await held
        worker.postMessage(request)
      })
    },
  }
}

function open(createWorker: (data: ThreadWorkerData) => ThreadWorker): ThreadStore {
  const store = new ThreadStore({ file: tempFile(), createWorker, log: () => {} })
  stores.push(store)
  return store
}

it('starts its workers again after they exit, and answers the requests after that', async () => {
  const workers: Crashable[] = []
  const store = open((data) => {
    const worker = crashable(inThreadWorker(data))
    workers.push(worker)
    return worker
  })
  await store.ready
  await store.write('s1', change('u0'))
  expect((await store.page('s1'))?.entries.map((e) => e.id)).toEqual(['u0'])
  for (const worker of [...workers]) worker.crash()
  await store.write('s1', change('u0', 'u1'))
  expect((await store.page('s1'))?.entries.map((e) => e.id)).toEqual(['u0', 'u1'])
  expect((await store.load('s1'))?.entries).toHaveLength(2)
})

it('answers a page read while a full load is still running', async () => {
  let release = (): void => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const store = open((data) => busy(inThreadWorker(data), held))
  await store.ready
  await store.write('s1', change('u0'))
  await store.write('s2', change('v0'))
  const load = store.load('s1')
  const page = await Promise.race([
    store.page('s2'),
    new Promise((resolve) => setTimeout(() => resolve('waited'), 2_000)),
  ])
  expect(page).toMatchObject({ entries: [{ id: 'v0' }] })
  release()
  expect((await load)?.entries).toHaveLength(1)
})

it('reads what a write of the same session sent before it stored', async () => {
  const store = open((data) => inThreadWorker(data))
  await store.ready
  await store.write('s1', change('u0'))
  void store.write('s1', change('u0', 'u1'))
  expect((await store.page('s1'))?.entries.map((e) => e.id)).toEqual(['u0', 'u1'])
})
