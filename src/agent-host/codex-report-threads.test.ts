// The one-time removal of Codex's archived report threads, against a fake `codex app-server`.

import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Platform } from '@shared/platform'
import { removeReportThreads } from './codex-report-threads'
import type { Env } from './find-command'

const platform = process.platform as Platform
const windows = platform === 'win32'

interface Message {
  jsonrpc: string
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code: number; message: string }
}

// A client of Codex's app-server for the test: it answers `initialize`, the pages of
// `thread/list` its arguments name, and `thread/delete`, and records every message it gets.
// `silent` never answers `thread/list`; `fail-delete` fails `thread/delete` for an id.
const SERVER = `
import { appendFileSync, writeFileSync } from 'node:fs'
const log = process.env.FAKE_APP_SERVER_LOG
const mode = process.env.FAKE_APP_SERVER_MODE ?? 'ok'
const reportsDir = process.env.FAKE_APP_SERVER_REPORTS
const pages = [
  { data: [{ id: 'in-1', cwd: reportsDir }, { id: 'other', cwd: reportsDir + '-old' }], nextCursor: 'page-2' },
  { data: [{ id: 'in-2', cwd: reportsDir }], nextCursor: null },
]
writeFileSync(process.env.FAKE_APP_SERVER_PID, String(process.pid))
appendFileSync(log, JSON.stringify({ start: true }) + '\\n')
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (text) => {
  buffer += text
  let index
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    appendFileSync(log, JSON.stringify(message) + '\\n')
    if (message.id === undefined) continue
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: { userAgent: 'fake-codex' } })
    } else if (message.method === 'thread/list') {
      if (mode === 'silent') continue
      const page = pages[message.params?.cursor ? 1 : 0]
      send({ jsonrpc: '2.0', id: message.id, result: page })
    } else if (message.method === 'thread/delete') {
      if (mode === 'fail-delete' && message.params?.threadId === 'in-1') {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'no rollout found' } })
      } else {
        send({ jsonrpc: '2.0', id: message.id, result: {} })
      }
    }
  }
})
`

let tmp: string
let program: string
let reportsDir: string

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'kettu-codex-threads-'))
  reportsDir = path.join(tmp, 'agent-reports')
  const script = path.join(tmp, 'fake-app-server.mjs')
  await writeFile(script, SERVER)
  program = path.join(tmp, windows ? 'fake-codex.cmd' : 'fake-codex')
  const quote = (value: string): string => `"${value}"`
  await writeFile(
    program,
    windows
      ? `@${quote(process.execPath)} ${quote(script)} %*\r\n`
      : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
  )
  if (!windows) await chmod(program, 0o755)
})

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

interface Fixture {
  env: Env
  messages(): Promise<Message[]>
  pid(): Promise<number>
}

async function fixture(mode = 'ok'): Promise<Fixture> {
  const dir = await mkdtemp(path.join(tmp, `run-${mode}-`))
  const logPath = path.join(dir, 'requests.log')
  const pidPath = path.join(dir, 'server.pid')
  await writeFile(logPath, '')
  const env: Env = {
    ...process.env,
    FAKE_APP_SERVER_LOG: logPath,
    FAKE_APP_SERVER_PID: pidPath,
    FAKE_APP_SERVER_REPORTS: reportsDir,
    FAKE_APP_SERVER_MODE: mode,
  }
  const read = async (): Promise<Message[]> =>
    (await readFile(logPath, 'utf8'))
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Message)
  const messages = async (): Promise<Message[]> =>
    (await read()).filter((message) => !('start' in message))
  return {
    env,
    messages,
    pid: async () => Number(await readFile(pidPath, 'utf8')),
  }
}

const log = (): void => {}

async function gone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

function remove(f: Fixture, extra: { timeoutMs?: number } = {}): Promise<number> {
  return removeReportThreads({
    binary: program,
    env: f.env,
    reportsDir,
    platform,
    version: '0.0.0-test',
    log,
    ...extra,
  })
}

describe('removeReportThreads', () => {
  it('deletes only the threads in the reports folder, across pages', async () => {
    const f = await fixture()
    expect(await remove(f)).toBe(2)
    const sent = await f.messages()
    expect(sent[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'initialize',
      params: { clientInfo: { name: 'kettu', version: '0.0.0-test' } },
    })
    expect(sent[1]).toEqual({ jsonrpc: '2.0', method: 'initialized' })
    const lists = sent.filter((message) => message.method === 'thread/list')
    expect(lists.map((message) => message.params)).toEqual([
      { archived: true, cwd: reportsDir },
      { archived: true, cwd: reportsDir, cursor: 'page-2' },
    ])
    const deletes = sent.filter((message) => message.method === 'thread/delete')
    expect(deletes.map((message) => message.params)).toEqual([
      { threadId: 'in-1' },
      { threadId: 'in-2' },
    ])
    expect(await gone(await f.pid())).toBe(true)
  })

  it('rejects on a failed delete, and kills the app-server', async () => {
    const f = await fixture('fail-delete')
    await expect(remove(f)).rejects.toThrow('no rollout found')
    expect(await gone(await f.pid())).toBe(true)
  })

  it('rejects once the time is up, and kills the app-server', async () => {
    const f = await fixture('silent')
    await expect(remove(f, { timeoutMs: 500 })).rejects.toThrow('within 0.5 s')
    expect(await gone(await f.pid())).toBe(true)
  })

  it('rejects when the app-server cannot start', async () => {
    const f = await fixture()
    await expect(
      removeReportThreads({
        binary: path.join(tmp, 'missing-codex'),
        env: f.env,
        reportsDir,
        platform,
        version: '0.0.0-test',
        log,
      }),
    ).rejects.toThrow()
  })
})
