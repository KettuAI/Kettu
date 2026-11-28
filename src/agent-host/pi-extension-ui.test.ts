import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PatchBatch } from '@shared/thread'
import type { AgentManager } from './agents'
import { PI } from './agents/pi'
import { Diagnostics } from './diagnostics'
import type { HostedSpawnOptions } from './driver'
import { PiConnection } from './pi/connection'
import { readJsonLines } from './pi/jsonl'
import type { Projects } from './projects'
import type { ScratchFolders } from './scratch'
import { SessionManager, type SessionEvents } from './sessions'
import { returnedFile, sessionsFile } from './storage'

type Command = Record<string, unknown> & { type: string; id?: string }

const MODELS = [{ provider: 'example', id: 'small-model', name: 'Small', contextWindow: 128_000 }]

class FakePiProc extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: string | null = null
  state: Record<string, unknown>

  constructor(sessionId: string, options: HostedSpawnOptions) {
    super()
    this.state = {
      model: MODELS[0],
      thinkingLevel: 'high',
      isStreaming: false,
      sessionId,
      autoCompactionEnabled: true,
      messageCount: 0,
    }
    void readJsonLines(this.stdin, {
      record: (value) => this.handle(value as Command),
      garbage: () => {},
    }).then(() => this.exit(0))
    options.signal?.addEventListener('abort', () => this.exit(0))
  }

  send(...events: unknown[]): void {
    for (const event of events) this.stdout.write(`${JSON.stringify(event)}\n`)
  }

  exit(code: number | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return
    if (code === null) this.signalCode = 'SIGTERM'
    else this.exitCode = code
    this.stdout.end()
    this.emit('exit', code, this.signalCode)
  }

  kill(): boolean {
    this.exit(null)
    return true
  }

  private handle(command: Command): void {
    if (command.type === 'extension_ui_response') return
    const base = { id: command.id, type: 'response', command: command.type }
    switch (command.type) {
      case 'get_state':
        this.send({ ...base, success: true, data: this.state })
        return
      case 'get_available_models':
        this.send({ ...base, success: true, data: { models: MODELS } })
        return
      case 'get_available_thinking_levels':
        this.send({ ...base, success: true, data: { levels: ['low', 'high'] } })
        return
      case 'get_commands':
        this.send({ ...base, success: true, data: { commands: [] } })
        return
      case 'get_entries':
        this.send({ ...base, success: true, data: { entries: [], leafId: null } })
        return
      case 'get_session_stats':
        this.send({ ...base, success: true, data: {} })
        return
      default:
        this.send({ ...base, success: false, error: `Unknown command: ${command.type}` })
    }
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25))

let dir: string
let connection: PiConnection | null = null
let sessions: SessionManager | null = null

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-pi-ext-ui-'))
})

afterEach(async () => {
  sessions?.shutdown()
  if (sessions) await sessions.flush()
  connection?.close()
  sessions = null
  connection = null
  await rm(dir, { recursive: true, force: true })
})

async function setupHost() {
  const project = path.join(dir, 'repo')
  const spawned: FakePiProc[] = []
  connection = new PiConnection({
    def: PI,
    spec: {
      command: '/usr/local/bin/pi',
      args: ['--mode', 'rpc'],
      env: {},
      shell: false,
      display: { command: 'pi', args: ['--mode', 'rpc'], env: {} },
    },
    env: { HOME: dir, PI_CODING_AGENT_DIR: path.join(dir, 'agent') },
    cliVersion: '1.5.2',
    spawn: (options) => {
      const proc = new FakePiProc(`pi-native-${spawned.length + 1}`, options)
      spawned.push(proc)
      return proc as unknown as ChildProcess
    },
    hooks: {
      account: () => {},
      log: () => {},
      traffic: () => {},
      ignored: () => {},
    },
  })
  const init = await connection.initialize()
  const runtime = { init, connection }
  const batches: PatchBatch[] = []
  const events: Partial<SessionEvents> = {
    patches: (batch) => batches.push(batch),
  }
  const agents = {
    has: () => true,
    name: () => 'Pi',
    assertEnabled: () => {},
    signedIn: () => {},
    needsSignIn: () => {},
    runningConfig: () => null,
    sessionsChanged: () => {},
    restoreConfig: (_agentId: string, config: unknown[]) => config,
    status: () => ({ id: 'pi', state: 'ready', capabilities: init.capabilities }),
    whileOpening: (_agentId: string, start: Promise<unknown>) => start,
    runtime: () => runtime,
    ensureReady: async () => runtime,
  } as unknown as AgentManager

  sessions = new SessionManager({
    platform: 'darwin',
    agents,
    projects: {
      list: () => [],
      resolveDirectory: async (folder: string) => folder,
      add: async () => {},
    } as unknown as Projects,
    scratch: { contains: () => false } as unknown as ScratchFolders,
    file: sessionsFile(dir, () => {}),
    returned: returnedFile(dir, () => {}),
    portOpen: () => false,
    threads: null,
    reportsDir: path.join(dir, 'reports'),
    diagnostics: new Diagnostics(),
    git: () => null,
    events: new Proxy(events, {
      get: (target, prop) => Reflect.get(target, prop) ?? (() => {}),
    }) as SessionEvents,
    settings: () => ({ startModes: {} }) as never,
    timings: { flushMs: 0 },
  })
  return { sessions, spawned, batches, project }
}

describe('host Pi extension status and widget lifecycle (#1837)', () => {
  it('broadcasts live updates, isolates sessions A and B, syncs on open/reconnect snapshots, and clears on process exit', async () => {
    const { sessions: host, spawned, batches, project } = await setupHost()

    const sessionA = await host.create({ agentId: 'pi', projectPath: project })
    const sessionB = await host.create({ agentId: 'pi', projectPath: project })
    host.watch(sessionA.id, 'win-1')
    host.watch(sessionB.id, 'win-1')
    await host.open(sessionA.id)
    await host.open(sessionB.id)
    await tick()

    expect(spawned).toHaveLength(2)
    const [piA, piB] = spawned

    // Live setStatus and setWidget on session A.
    piA!.send(
      {
        type: 'extension_ui_request',
        id: 'a-s1',
        method: 'setStatus',
        statusKey: 'ci',
        statusText: '\x1b[32mCI green\x1b[0m',
      },
      {
        type: 'extension_ui_request',
        id: 'a-w1',
        method: 'setWidget',
        widgetKey: 'checklist',
        widgetLines: ['Step 1: done', 'Step 2: running'],
        widgetPlacement: 'aboveEditor',
      },
    )
    await tick()

    // Live broadcast patches reached only session A.
    const patchesA = batches.filter((b) => b.sessionId === sessionA.id)
    expect(
      patchesA.some((b) =>
        b.patches.some((p) => p.op === 'session.update' && p.changes.extensionUi != null),
      ),
    ).toBe(true)

    // Fresh open() and snapshot() (reconnect / second window) return session A's exact live state,
    // while session B stays completely isolated.
    const snapA = await host.open(sessionA.id)
    const reconnectA = await host.snapshot(sessionA.id)
    const snapB = await host.open(sessionB.id)

    const expectedA = {
      statuses: [{ key: 'ci', text: 'CI green' }],
      widgets: [
        {
          key: 'checklist',
          lines: ['Step 1: done', 'Step 2: running'],
          placement: 'aboveEditor',
        },
      ],
    }
    expect(snapA.session.extensionUi).toEqual(expectedA)
    expect(reconnectA.session.extensionUi).toEqual(expectedA)
    expect(snapB.session.extensionUi ?? null).toBeNull()

    // Session B sets its own status; session A stays unchanged.
    piB!.send({
      type: 'extension_ui_request',
      id: 'b-s1',
      method: 'setStatus',
      statusKey: 'env',
      statusText: 'staging',
    })
    await tick()

    expect((await host.snapshot(sessionA.id)).session.extensionUi).toEqual(expectedA)
    expect((await host.snapshot(sessionB.id)).session.extensionUi).toEqual({
      statuses: [{ key: 'env', text: 'staging' }],
      widgets: [],
    })

    // Clearing status & widget on A leaves A empty while B keeps its status.
    piA!.send(
      {
        type: 'extension_ui_request',
        id: 'a-s-clear',
        method: 'setStatus',
        statusKey: 'ci',
        statusText: undefined,
      },
      {
        type: 'extension_ui_request',
        id: 'a-w-clear',
        method: 'setWidget',
        widgetKey: 'checklist',
        widgetLines: undefined,
      },
    )
    await tick()

    expect((await host.snapshot(sessionA.id)).session.extensionUi).toBeNull()
    expect((await host.snapshot(sessionB.id)).session.extensionUi).toEqual({
      statuses: [{ key: 'env', text: 'staging' }],
      widgets: [],
    })

    // Process exit for session B clears ephemeral extension UI so no ghost state remains.
    piB!.exit(1)
    await tick()
    expect((await host.snapshot(sessionB.id)).session.extensionUi).toBeNull()
  })
})
