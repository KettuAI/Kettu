// The session router against children run as the fake agent: it starts one adapter process per
// session, so an adapter that keeps one live session per process serves them all.

import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'

const ROUTER = path.resolve('src/agent-host/session-router/router.ts')
const FAKE_AGENT = path.resolve('tools/fake-agent/main.ts')

interface RpcMessage {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}

/** The router under test, its stdio, and the answers it owes by request id. */
class RouterProcess {
  private readonly child: ChildProcess
  private readonly pending = new Map<number, (message: RpcMessage) => void>()
  private readonly notices: RpcMessage[] = []
  private nextId = 1
  /** Called for each request a child makes through the router. */
  onRequest: ((message: RpcMessage) => void) | null = null
  readonly exited: Promise<number | null>
  stderr = ''

  constructor(env: Record<string, string> = {}) {
    this.child = spawn(process.execPath, [ROUTER, process.execPath, FAKE_AGENT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FAKE_AGENT_DELAY_SCALE: '0', ...env },
    })
    this.exited = new Promise((resolve) => {
      this.child.once('exit', (code) => {
        for (const answer of this.pending.values()) answer({})
        this.pending.clear()
        resolve(code)
      })
    })
    const lines = createInterface({ input: this.child.stdout! })
    lines.on('line', (line) => this.receive(JSON.parse(line) as RpcMessage))
    this.child.stderr!.setEncoding('utf8').on('data', (text: string) => (this.stderr += text))
    this.child.stdin!.on('error', () => {})
  }

  private receive(message: RpcMessage): void {
    if (message.method !== undefined) {
      if (message.id !== undefined) this.onRequest?.(message)
      else this.notices.push(message)
      return
    }
    if (message.id === undefined) return
    const answer = this.pending.get(message.id as number)
    this.pending.delete(message.id as number)
    answer?.(message)
  }

  /** Sends a request; the answer, whether it holds a result or an error. */
  request(method: string, params: unknown): Promise<RpcMessage> {
    const id = this.nextId++
    return new Promise<RpcMessage>((resolve) => {
      this.pending.set(id, resolve)
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** Sends a request that answers with its result, failing the test on an error. */
  async result<T = Record<string, unknown>>(method: string, params: unknown): Promise<T> {
    const message = await this.request(method, params)
    if (message.error) throw new Error(`${method}: ${message.error.message}`)
    return message.result as T
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  answer(id: number | string, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result })
  }

  /** The `session/update` notifications sent so far for a session. */
  updates(sessionId: string): { sessionUpdate: string }[] {
    return this.notices
      .filter(
        (message) =>
          message.method === 'session/update' &&
          (message.params as { sessionId: string }).sessionId === sessionId,
      )
      .map((message) => (message.params as { update: { sessionUpdate: string } }).update)
  }

  /** Ends the router's input, as a host stopping the agent does. */
  stop(): void {
    this.child.stdin?.end()
  }

  kill(): void {
    this.child.kill('SIGKILL')
  }

  private write(message: RpcMessage): void {
    this.child.stdin?.write(`${JSON.stringify(message)}\n`)
  }
}

const started: RouterProcess[] = []

function start(env: Record<string, string> = {}): RouterProcess {
  const router = new RouterProcess(env)
  started.push(router)
  return router
}

afterEach(() => {
  for (const router of started.splice(0)) router.kill()
})

async function initialize(router: RouterProcess): Promise<Record<string, unknown>> {
  return router.result('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'Kettu', version: '0.0.0-test' },
    clientCapabilities: { auth: { terminal: true } },
  })
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${check.toString()}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('the session router', () => {
  it('answers initialize with close added to the session capabilities', async () => {
    // The child leaves close out, as pi-acp 0.0.34 does.
    const router = start({ FAKE_AGENT_WITHOUT: 'close' })
    const init = await initialize(router)
    const capabilities = init.agentCapabilities as {
      sessionCapabilities: Record<string, unknown>
    }
    expect(capabilities.sessionCapabilities).toMatchObject({ list: {}, delete: {}, close: {} })
    router.stop()
  })

  it('maps each session to an adapter process of its own, and keeps both turns running', async () => {
    const router = start()
    await initialize(router)
    const first = await router.result<{ sessionId: string }>('session/new', {
      cwd: process.cwd(),
      mcpServers: [],
    })
    const second = await router.result<{ sessionId: string }>('session/new', {
      cwd: process.cwd(),
      mcpServers: [],
    })
    expect(first.sessionId).not.toBe(second.sessionId)
    // The second `session/new` ends nothing of the first: both turns run to their end.
    await Promise.all([
      router.result('session/prompt', {
        sessionId: first.sessionId,
        prompt: [{ type: 'text', text: 'First' }],
      }),
      router.result('session/prompt', {
        sessionId: second.sessionId,
        prompt: [{ type: 'text', text: 'Second' }],
      }),
    ])
    expect(router.updates(first.sessionId).length).toBeGreaterThan(0)
    expect(router.updates(second.sessionId).length).toBeGreaterThan(0)
    router.stop()
  })

  it('answers an unknown session with -32602 and drops its notifications', async () => {
    const router = start()
    await initialize(router)
    const answer = await router.request('session/prompt', {
      sessionId: 'nope',
      prompt: [{ type: 'text', text: 'Hello' }],
    })
    expect(answer.error).toEqual({ code: -32602, message: 'Unknown session nope' })
    router.notify('session/cancel', { sessionId: 'nope' })
    // The router answers the next request all the same, so the dropped notification did not stop it.
    expect(await router.result('session/list', { cwd: process.cwd() })).toBeDefined()
    router.stop()
  })

  it('answers close at once, and ends only that session', async () => {
    const router = start()
    await initialize(router)
    const kept = await router.result<{ sessionId: string }>('session/new', {
      cwd: process.cwd(),
      mcpServers: [],
    })
    const gone = await router.result<{ sessionId: string }>('session/new', {
      cwd: process.cwd(),
      mcpServers: [],
    })
    const before = router.updates(kept.sessionId).length
    expect(await router.result('session/close', { sessionId: gone.sessionId })).toEqual({})
    await router.result('session/prompt', {
      sessionId: kept.sessionId,
      prompt: [{ type: 'text', text: 'Still here' }],
    })
    expect(router.updates(kept.sessionId).length).toBeGreaterThan(before)
    // The closed session is gone.
    expect(
      (
        await router.request('session/prompt', {
          sessionId: gone.sessionId,
          prompt: [{ type: 'text', text: 'Hello' }],
        })
      ).error,
    ).toMatchObject({ code: -32602 })
    router.stop()
  })

  it('loads a session with a child of its own, in place of the one it had', async () => {
    const router = start()
    await initialize(router)
    const { sessionId } = await router.result<{ sessionId: string }>('session/new', {
      cwd: process.cwd(),
      mcpServers: [],
    })
    await router.result('session/load', { sessionId, cwd: process.cwd(), mcpServers: [] })
    await router.result('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'After the load' }],
    })
    expect(router.updates(sessionId).length).toBeGreaterThan(0)
    router.stop()
  })

  it('waits for the session child to exit before the delete reaches the control child', async () => {
    // This child ignores EOF, so the router has to wait its limit and kill it before the delete.
    const router = start({ FAKE_AGENT_IGNORE_EOF: '1' })
    await initialize(router)
    const { sessionId } = await router.result<{ sessionId: string }>('session/new', {
      cwd: process.cwd(),
      mcpServers: [],
    })
    const started = Date.now()
    expect(await router.result('session/delete', { sessionId })).toBeDefined()
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_500)
    router.stop()
  }, 20_000)

  it('ends the session child before the delete, which the control child answers', async () => {
    const router = start()
    await initialize(router)
    const { sessionId } = await router.result<{ sessionId: string }>('session/new', {
      cwd: process.cwd(),
      mcpServers: [],
    })
    expect(await router.result('session/delete', { sessionId })).toBeDefined()
    expect(
      (await router.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'x' }] }))
        .error,
    ).toMatchObject({ code: -32602 })
    router.stop()
  })

  it('gives a request a child makes an id of its own, and answers the child', async () => {
    const router = start()
    await initialize(router)
    const { sessionId } = await router.result<{ sessionId: string }>('session/new', {
      cwd: process.cwd(),
      mcpServers: [],
    })
    const asked: RpcMessage[] = []
    router.onRequest = (message) => {
      asked.push(message)
      router.answer(
        message.id!,
        message.method === 'session/request_permission'
          ? { outcome: { outcome: 'selected', optionId: 'allow_once' } }
          : {},
      )
    }
    await router.result('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '/permission' }],
    })
    expect(asked.map((message) => message.method)).toContain('session/request_permission')
    // The answer reached the child, whose turn then ended as chosen.
    await until(() =>
      router.updates(sessionId).some((update) => update.sessionUpdate === 'tool_call_update'),
    )
    router.stop()
  })

  it('ends its children and exits 0 when its own input ends', async () => {
    const router = start()
    await initialize(router)
    await router.result('session/new', { cwd: process.cwd(), mcpServers: [] })
    router.stop()
    expect(await router.exited).toBe(0)
  })

  it('exits with code 1 when a child exits without being ended', async () => {
    const router = start()
    await initialize(router)
    const { sessionId } = await router.result<{ sessionId: string }>('session/new', {
      cwd: process.cwd(),
      mcpServers: [],
    })
    void router.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '/crash --code 7' }],
    })
    expect(await router.exited).toBe(1)
  })
})
