import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findHolder, readLastRequest, readTail } from './outside-sessions'

const SESSION = '2fe6b9a7-d648-4721-8783-29cfccf98185'
const HOUR = 60 * 60_000

const line = (value: unknown): string => JSON.stringify(value)
const request = (querySource: string, model: string, effort: string): string =>
  line({
    type: 'api-request',
    querySource,
    params: { model, output_config: { effort }, betas: ['context-1m-2025-08-07'] },
  })
const reply = (
  timestamp: string,
  usage: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): string =>
  line({
    type: 'assistant',
    timestamp,
    message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'secret' }], usage },
    ...extra,
  })

describe('readLastRequest', () => {
  let folder: string

  beforeEach(async () => {
    folder = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kettu-outside-')))
  })

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true })
  })

  async function read(lines: string[], options?: { limit?: number; chunk?: number }) {
    const file = path.join(folder, `${SESSION}.jsonl`)
    await writeFile(file, `${lines.join('\n')}\n`)
    return readLastRequest(file, options)
  }

  it('reads the settings and usage of the main thread, not what a subagent or a title asked', async () => {
    const found = await read([
      line({ type: 'permission-mode', permissionMode: 'default' }),
      line({
        type: 'attachment',
        attachment: { type: 'model', identity: { modelId: 'claude-opus-5-5[1m]' } },
      }),
      reply('2026-11-17T03:02:00.000Z', {
        input_tokens: 10,
        cache_creation_input_tokens: 15_000,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 15_000 },
      }),
      line({ type: 'permission-mode', permissionMode: 'acceptEdits' }),
      request('repl_main_thread', 'claude-opus-5-5', 'xhigh'),
      // Read from the cache the reply before wrote, so the lifetime is that write's.
      reply('2026-11-17T03:02:50.000Z', {
        input_tokens: 399,
        cache_read_input_tokens: 15_360,
        cache_creation_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        speed: 'standard',
      }),
      request('session_title', 'claude-haiku-5-5', 'low'),
      reply(
        '2026-11-17T03:05:00.000Z',
        { input_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 9 } },
        { isSidechain: true },
      ),
    ])

    expect(found).toEqual({
      at: Date.parse('2026-11-17T03:02:50.000Z'),
      ttl: HOUR,
      model: 'claude-opus-5-5[1m]',
      effort: 'xhigh',
      fast: false,
      mode: 'acceptEdits',
      context: 15_759,
    })
  })

  it('takes the last reply of the main thread for its time and usage', async () => {
    const found = await read([
      reply('2026-11-17T03:00:00.000Z', {
        input_tokens: 10,
        cache_creation_input_tokens: 15_000,
        cache_creation: { ephemeral_5m_input_tokens: 15_000 },
      }),
      request('sdk', 'claude-sonnet-5-5', 'high'),
      reply('2026-11-17T03:02:50.000Z', {
        input_tokens: 399,
        cache_read_input_tokens: 15_360,
        speed: 'fast',
      }),
    ])

    expect(found).toMatchObject({
      at: Date.parse('2026-11-17T03:02:50.000Z'),
      ttl: 5 * 60_000,
      model: 'claude-sonnet-5-5',
      effort: 'high',
      fast: true,
      mode: null,
      context: 15_759,
    })
  })

  it('keeps the request model when the session was told of another one', async () => {
    const found = await read([
      line({
        type: 'attachment',
        attachment: { type: 'model', identity: { modelId: 'claude-opus-5-5[1m]' } },
      }),
      request('repl_main_thread', 'claude-sonnet-5-5', 'high'),
      reply('2026-11-17T03:02:50.000Z', { input_tokens: 1 }),
    ])

    expect(found?.model).toBe('claude-sonnet-5-5')
  })

  it('has nothing for a transcript without a reply', async () => {
    await expect(
      read([line({ type: 'user', message: { content: 'hi' } }), 'not json']),
    ).resolves.toBeNull()
  })

  it('reads across chunks and stops at the limit', async () => {
    const lines = [
      request('repl_main_thread', 'claude-opus-5-5', 'high'),
      reply('2026-11-17T03:02:50.000Z', { input_tokens: 1 }),
      ...Array.from({ length: 40 }, (_, i) => line({ type: 'queue-operation', index: i })),
    ]
    await expect(read(lines, { chunk: 64 })).resolves.toMatchObject({ effort: 'high' })
    await expect(read(lines, { chunk: 64, limit: 256 })).resolves.toBeNull()
  })
})

describe('readTail', () => {
  let folder: string

  beforeEach(async () => {
    folder = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kettu-tail-')))
  })

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true })
  })

  async function read(lines: string[], own: string | null = null) {
    const file = path.join(folder, `${SESSION}.jsonl`)
    await writeFile(file, `${lines.join('\n')}\n`)
    return readTail(file, own)
  }

  const message = (
    type: 'user' | 'assistant',
    uuid: string,
    entrypoint?: string,
    extra: Record<string, unknown> = {},
  ): string => line({ type, uuid, ...(entrypoint ? { entrypoint } : {}), ...extra })

  it('says a terminal wrote the last message of the main thread', async () => {
    await expect(
      read([
        message('user', 'u1', 'sdk-ts'),
        message('assistant', 'a1', 'sdk-ts'),
        message('user', 'u2', 'cli'),
        message('assistant', 'a2', 'cli'),
        line({ type: 'last-prompt', lastPrompt: 'x' }),
        message('assistant', 'side', 'sdk-ts', { isSidechain: true }),
      ]),
    ).resolves.toEqual({ uuid: 'a2', outside: true })
  })

  it('says Kettu wrote it when an SDK host did, or the entry point Kettu runs under', async () => {
    await expect(
      read([message('user', 'u1', 'cli'), message('assistant', 'a1', 'sdk-ts')]),
    ).resolves.toEqual({
      uuid: 'a1',
      outside: false,
    })
    await expect(read([message('assistant', 'a1', 'company-app')], 'company-app')).resolves.toEqual(
      {
        uuid: 'a1',
        outside: false,
      },
    )
  })

  it('does not say it for a message that records no writer, and has nothing without a message', async () => {
    await expect(read([message('assistant', 'a1')])).resolves.toEqual({
      uuid: 'a1',
      outside: false,
    })
    await expect(read([line({ type: 'custom-title' }), 'not json'])).resolves.toBeNull()
  })
})

describe('findHolder', () => {
  let folder: string

  beforeEach(async () => {
    folder = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kettu-holders-')))
  })

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true })
  })

  async function entry(pid: number, value: Record<string, unknown>): Promise<void> {
    await writeFile(path.join(folder, `${pid}.json`), JSON.stringify({ pid, ...value }))
  }

  it('finds a terminal that has the session open', async () => {
    await entry(101, { sessionId: 'other', entrypoint: 'cli', status: 'idle' })
    await entry(102, { sessionId: SESSION, entrypoint: 'cli', status: 'busy' })

    await expect(findHolder(folder, SESSION, () => true)).resolves.toEqual({
      pid: 102,
      entrypoint: 'cli',
      busy: true,
    })
  })

  it('leaves out SDK hosts, ended processes and unreadable files', async () => {
    await entry(201, { sessionId: SESSION, entrypoint: 'sdk-ts', status: 'idle' })
    await entry(202, { sessionId: SESSION, entrypoint: 'cli', status: 'idle' })
    await writeFile(path.join(folder, '203.json'), '{')
    await writeFile(
      path.join(folder, `${SESSION}.json`),
      JSON.stringify({ pid: 204, sessionId: SESSION }),
    )

    await expect(findHolder(folder, SESSION, (pid) => pid !== 202)).resolves.toBeNull()
  })

  it('has none when the folder is missing', async () => {
    await expect(findHolder(path.join(folder, 'missing'), SESSION, () => true)).resolves.toBeNull()
  })
})
