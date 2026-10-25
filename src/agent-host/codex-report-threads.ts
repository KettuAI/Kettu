// Removing the archived Codex threads that the plan limit reports left in the user's Codex
// history, through Codex's own `thread/list` and `thread/delete`, by talking to
// `codex app-server` as its client. codex-acp offers no list of archived threads, and deleting
// files under `~/.codex` by hand would leave Codex's thread database behind.

import os from 'node:os'
import type { AnyMessage } from '@agentclientprotocol/sdk/unstable'
import type { Platform } from '@shared/platform'
import { spawnAgent } from './agent-process'
import { needsShell, type Env } from './find-command'
import { samePath } from './paths'

export const REPORT_THREADS_TIMEOUT_MS = 30_000

export interface ReportThreadsOptions {
  /** Codex's own binary, which the adapter runs. */
  binary: string
  /** The agent environment, so a `CODEX_HOME` the user set holds. */
  env: Env
  /** The hidden folder the reports ran in: `<userData>/agent-reports`. */
  reportsDir: string
  platform: Platform
  /** This client's version for `initialize`, which Codex requires. */
  version: string
  timeoutMs?: number
  log(level: 'info' | 'warn' | 'error', message: string): void
}

interface ThreadPage {
  data?: { id?: unknown; cwd?: unknown }[]
  nextCursor?: unknown
}

interface Waiter {
  resolve(value: unknown): void
  reject(error: Error): void
}

/**
 * Deletes every archived Codex thread whose working directory is exactly `reportsDir`, page by
 * page, and resolves with how many it removed. Rejects on any error or once `timeoutMs` passes;
 * the app-server is killed either way.
 */
export async function removeReportThreads(options: ReportThreadsOptions): Promise<number> {
  const {
    binary,
    env,
    reportsDir,
    platform,
    version,
    timeoutMs = REPORT_THREADS_TIMEOUT_MS,
  } = options
  let stderr = ''
  const launched = spawnAgent(
    {
      command: binary,
      args: ['app-server'],
      env: {},
      shell: needsShell(binary, platform),
      display: { command: binary, args: ['app-server'], env: {} },
    },
    {
      platform,
      env,
      cwd: os.homedir(),
      onStderr: (text) => {
        stderr = (stderr + text).slice(-2_000)
      },
    },
  )
  // One rejection ends every request: the deadline, the process exiting, or a failed write.
  let end: (error: Error) => void = () => {}
  const ended = new Promise<never>((_, reject) => {
    end = reject
  })
  // A race that has already lost still listens to it, so the rejection stays handled.
  void ended.catch(() => {})
  const deadline = setTimeout(() => {
    end(new Error(`Codex did not answer within ${timeoutMs / 1_000} s.`))
  }, timeoutMs)
  void launched.exited.then((info) => {
    const exit =
      info.error ??
      (info.signal ? `was stopped by ${info.signal}` : `exited with code ${info.code}`)
    const tail = stderr.trim().split('\n').slice(-3).join(' ')
    end(new Error(`Codex ${exit}.${tail ? ` ${tail}` : ''}`))
  })

  const pending = new Map<number, Waiter>()
  const { stream } = launched.transport
  const writer = stream.writable.getWriter()
  const reader = stream.readable.getReader()
  const reading = (async () => {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      const message = value as AnyMessage
      if (!('id' in message) || typeof message.id !== 'number') continue
      const waiter = pending.get(message.id)
      if (!waiter) continue
      pending.delete(message.id)
      if ('error' in message && message.error) waiter.reject(new Error(message.error.message))
      else waiter.resolve('result' in message ? message.result : undefined)
    }
  })().catch((error: unknown) => {
    end(error as Error)
  })
  const send = (message: AnyMessage): void => {
    void writer.write(message).catch((error: unknown) => end(error as Error))
  }

  let nextId = 1
  const request = (method: string, params: unknown): Promise<unknown> => {
    const id = nextId++
    const answer = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      send({ jsonrpc: '2.0', id, method, params })
    })
    return Promise.race([answer, ended])
  }

  try {
    await request('initialize', { clientInfo: { name: 'overbench', version } })
    send({ jsonrpc: '2.0', method: 'initialized' })
    const threads: { id: string; cwd: string }[] = []
    const cursors = new Set<string>()
    let cursor: string | null = null
    do {
      const page = (await request('thread/list', {
        archived: true,
        cwd: reportsDir,
        ...(cursor ? { cursor } : {}),
      })) as ThreadPage | undefined
      for (const thread of page?.data ?? []) {
        if (typeof thread.id === 'string' && typeof thread.cwd === 'string') {
          threads.push({ id: thread.id, cwd: thread.cwd })
        }
      }
      cursor = typeof page?.nextCursor === 'string' ? page.nextCursor : null
      // A cursor that comes back is the end of the pages, however the server numbers them.
      if (cursor !== null && cursors.has(cursor)) cursor = null
      else if (cursor !== null) cursors.add(cursor)
    } while (cursor !== null)
    // Every page is read before anything goes: a delete shifts what the next cursor names.
    const found = threads.filter((thread) => samePath(thread.cwd, reportsDir, platform))
    for (const thread of found) await request('thread/delete', { threadId: thread.id })
    return found.length
  } finally {
    clearTimeout(deadline)
    pending.clear()
    await reader.cancel().catch(() => {})
    await launched.kill()
    await reading
    if (!launched.hasExited) {
      options.log('warn', 'Codex app-server did not stop after it was killed')
    }
  }
}
