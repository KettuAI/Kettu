// Process test: the agent host under plain Node.js, through node-main.ts. It is forked with its
// workers built beside it, takes one port over its socket, and runs a turn of the fake agent.

import { fork, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HostEvent } from '@shared/agent-host'
import type { HostToMain, MainToHost } from '@shared/host-control'
import type { PortChannel } from '@shared/port-channel'
import type { FromPort } from '@shared/port-rpc'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { connectPort, privateSocketPath, type SocketPath } from '@shared/socket-port'
import { FAKE_AGENT_MAIN, SESSION_ROUTER, TestPort } from './testing/harness'

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))

let dir: string | null = null
let bundle = ''
let socket: SocketPath | null = null
let child: ChildProcess | null = null
let client: PortChannel | null = null

beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kettu-node-host-')))
  bundle = path.join(dir, 'bundle')
  await build({
    configFile: false,
    logLevel: 'silent',
    root,
    resolve: { alias: { '@shared': path.join(root, 'src/shared') } },
    ssr: { noExternal: true },
    build: {
      ssr: true,
      outDir: bundle,
      emptyOutDir: true,
      minify: false,
      rolldownOptions: {
        input: {
          'node-main': path.join(root, 'src/agent-host/node-main.ts'),
          'thread-worker': path.join(root, 'src/agent-host/threads/worker.ts'),
          'usage-worker': path.join(root, 'src/agent-host/usage/worker.ts'),
        },
        external: [/^node:/],
        output: { format: 'cjs', entryFileNames: '[name].cjs', chunkFileNames: '[name].cjs' },
      },
    },
  })
}, 120_000)

afterAll(async () => {
  client?.close()
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await socket?.remove()
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

describe('the agent host under Node.js', () => {
  it('takes a port over its socket and runs a turn of the fake agent', async () => {
    const project = path.join(dir!, 'project')
    await mkdir(project)
    await mkdir(path.join(dir!, 'data'))
    socket = await privateSocketPath('agent-host')
    const sent: HostToMain[] = []
    let output = ''
    // The host's own home, so its shell probe and agent lookup read nothing of the user's.
    child = fork(path.join(bundle, 'node-main.cjs'), [], {
      env: { ...process.env, HOME: dir!, SHELL: '/bin/sh', FAKE_AGENT_DELAY_SCALE: '0' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    child.stdout!.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.on('message', (message) => sent.push(message as HostToMain))
    const exited = new Promise<number | null>((resolve) => child!.once('exit', resolve))
    const until = async (check: () => boolean, what: string): Promise<void> => {
      const started = Date.now()
      while (!check()) {
        if (child!.exitCode !== null) throw new Error(`The host exited before ${what}\n${output}`)
        if (Date.now() - started > 30_000) throw new Error(`No ${what}\n${output}`)
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }

    const init: MainToHost = {
      type: 'host:init',
      userDataPath: path.join(dir!, 'data'),
      appVersion: '0.0.0-test',
      platform: process.platform,
      isPackaged: false,
      nodeRuntime: { command: process.execPath, env: {} },
      fakeAgentPath: FAKE_AGENT_MAIN,
      threadWorkerPath: path.join(bundle, 'thread-worker.cjs'),
      usageWorkerPath: path.join(bundle, 'usage-worker.cjs'),
      sessionRouterPath: SESSION_ROUTER,
      settings: {
        locale: 'en',
        agents: DEFAULT_SETTINGS.agents,
        addedAgents: DEFAULT_SETTINGS.addedAgents,
        proxy: DEFAULT_SETTINGS.proxy,
        git: DEFAULT_SETTINGS.git,
        mcp: DEFAULT_SETTINGS.mcp,
        usage: { fromComputer: false },
        sessionTitles: true,
      },
      socketPath: socket.path,
    }
    child.send(init)
    await until(() => sent.some((message) => message.type === 'host:ready'), 'host:ready')

    client = await connectPort(socket.path)
    const port = new TestPort()
    port.onMessage((data) => client!.send(data))
    client.onMessage((data) => port.send(data as FromPort<HostEvent>))

    const session = await port.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: project,
    })
    await port.open(session.id)
    await port.request('sessions.prompt', {
      sessionId: session.id,
      content: [{ type: 'text', text: 'hello' }],
    })
    await port.untilEntry(session.id, (entry) => entry.kind === 'turn_end')
    const entries = port.entries(session.id)
    expect(entries.some((entry) => entry.kind === 'agent' && entry.markdown.length > 0)).toBe(true)
    // The turn streamed in batches rather than arriving at its end.
    expect(port.replicas.get(session.id)!.batches).toBeGreaterThan(1)
    expect(port.summary(session.id)).toMatchObject({ id: session.id, agentId: 'fake-agent' })

    // Node.js runs the fake agent and the shell probe as it is, with nothing added.
    const fake = (await port.request('agents.list', undefined)).find((a) => a.id === 'fake-agent')
    expect(fake?.launchCommand).toContain(FAKE_AGENT_MAIN)
    expect(fake?.launchCommand).not.toContain('ELECTRON_RUN_AS_NODE')
    const environment = await port.request('agents.environment', undefined)
    expect(environment.source).toBe(process.platform === 'win32' ? 'inherited' : 'login-shell')

    child.send({ type: 'host:shutdown' } satisfies MainToHost)
    expect(await exited).toBe(0)
    expect(sent.at(-1)).toEqual({ type: 'host:stopped' })
  }, 60_000)
})
