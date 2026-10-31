// Process test: the remote host under plain Node.js, through node-main.ts, beside the agent host run
// the same way. A device connects on the remote host's local socket and runs a turn of the fake
// agent through the session port the remote host opens on the agent host's socket.

import { fork, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  HostToMain,
  MainToHost,
  MainToRemoteHost,
  RemoteHostStatus,
  RemoteHostToMain,
} from '@shared/host-control'
import { generateKeyPair, importKeyPair } from '@shared/remote/noise'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { privateSocketPath, type SocketPath } from '@shared/socket-port'
import { FAKE_AGENT_MAIN, SESSION_ROUTER } from '../agent-host/testing/harness'
import { streamTransport } from './stream-transport'
import { connectDevice } from './testing/device'

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

let dir: string | null = null
let bundle = ''
const sockets: SocketPath[] = []
const children: ChildProcess[] = []

beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kettu-node-remote-')))
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
          'agent-host': path.join(root, 'src/agent-host/node-main.ts'),
          'remote-host': path.join(root, 'src/remote-host/node-main.ts'),
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
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  await Promise.all(sockets.map((socket) => socket.remove()))
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

interface Forked<Out> {
  child: ChildProcess
  sent: Out[]
  exited: Promise<number | null>
  until(check: () => boolean, what: string): Promise<void>
}

function start<Out>(entry: string): Forked<Out> {
  const sent: Out[] = []
  let output = ''
  // The hosts' own home, so the shell probe and agent lookup read nothing of the user's.
  const child = fork(path.join(bundle, `${entry}.cjs`), [], {
    env: { ...process.env, HOME: dir!, SHELL: '/bin/sh', FAKE_AGENT_DELAY_SCALE: '0' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  children.push(child)
  child.stdout!.on('data', (chunk: Buffer) => (output += chunk.toString()))
  child.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()))
  child.on('message', (message) => sent.push(message as Out))
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
  const until = async (check: () => boolean, what: string): Promise<void> => {
    const started = Date.now()
    while (!check()) {
      if (child.exitCode !== null) throw new Error(`${entry} exited before ${what}\n${output}`)
      if (Date.now() - started > 30_000) throw new Error(`No ${what}\n${output}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  return { child, sent, exited, until }
}

describe('the remote host under Node.js', () => {
  it("serves a device's session through the agent host's socket", async () => {
    const project = path.join(dir!, 'project')
    const data = path.join(dir!, 'data')
    await mkdir(project)
    await mkdir(data)
    const agentSocket = await privateSocketPath('agent-host')
    const remoteSocket = await privateSocketPath('remote-host')
    sockets.push(agentSocket, remoteSocket)

    const agent = start<HostToMain>('agent-host')
    agent.child.send({
      type: 'host:init',
      userDataPath: data,
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
      socketPath: agentSocket.path,
    } satisfies MainToHost)
    await agent.until(() => agent.sent.some((m) => m.type === 'host:ready'), 'host:ready')

    const privateKey = new Uint8Array(32).fill(7)
    const hostKey = await importKeyPair(privateKey)
    const remote = start<RemoteHostToMain>('remote-host')
    const statuses = (): RemoteHostStatus[] =>
      remote.sent.flatMap((m) => (m.type === 'remote-host:status' ? [m.status] : []))
    remote.child.send({
      type: 'remote-host:init',
      userDataPath: data,
      appVersion: '0.0.0-test',
      platform: process.platform,
      hostName: 'Studio',
      privateKey: base64(privateKey),
      plainTextKey: false,
      agentHostSocket: agentSocket.path,
      socketPath: remoteSocket.path,
    } satisfies MainToRemoteHost)
    await remote.until(() => statuses().length > 0, 'remote-host:status')
    expect(remote.sent[0]).toEqual({ type: 'remote-host:ready' })
    expect(statuses()[0]).toEqual({
      publicKey: base64(hostKey.publicKey),
      plainTextKey: false,
      devices: [],
      online: [],
      refused: 0,
      direct: { state: 'off' },
    })

    const phone = await generateKeyPair()
    remote.child.send({
      type: 'remote-host:add-device',
      device: { publicKey: base64(phone.publicKey), name: 'Phone', kind: 'ios', platform: 'ios' },
    } satisfies MainToRemoteHost)
    await remote.until(() => statuses().at(-1)!.devices.length === 1, 'the added device')
    const stored = JSON.parse(await readFile(path.join(data, 'remote', 'devices.json'), 'utf8'))
    expect(stored.devices).toMatchObject([{ name: 'Phone', publicKey: base64(phone.publicKey) }])

    const socket = connect(remoteSocket.path)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    const device = await connectDevice({
      transport: streamTransport(socket),
      hostKey: hostKey.publicKey,
      key: phone,
    })
    expect(await device.first).toMatchObject({
      type: 'welcome',
      protocol: 1,
      host: { name: 'Studio', platform: process.platform, version: '0.0.0-test' },
      role: 'owner',
    })
    const session = await device.port.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: project,
    })
    await device.port.open(session.id)
    await device.port.request('sessions.prompt', {
      sessionId: session.id,
      content: [{ type: 'text', text: 'hello' }],
    })
    await device.port.untilEntry(session.id, (entry) => entry.kind === 'turn_end')
    expect(
      device.port.entries(session.id).some((e) => e.kind === 'agent' && e.markdown.length > 0),
    ).toBe(true)
    // The agent host knows the port as the device's, so it refuses what needs main.
    await expect(device.port.request('projects.add', { path: project })).rejects.toMatchObject({
      code: 'forbidden',
    })
    await remote.until(() => statuses().at(-1)!.online.length === 1, 'the device online')

    remote.child.send({
      type: 'remote-host:shutdown',
      reason: 'stopping',
    } satisfies MainToRemoteHost)
    expect(await device.closing).toEqual({ type: 'closing', reason: 'stopping' })
    expect(await remote.exited).toBe(0)
    expect(remote.sent.at(-1)).toEqual({ type: 'remote-host:stopped' })
    const kept = JSON.parse(await readFile(path.join(data, 'remote', 'devices.json'), 'utf8'))
    expect(kept.devices[0].lastConnectedAt).toEqual(expect.any(Number))

    agent.child.send({ type: 'host:shutdown' } satisfies MainToHost)
    expect(await agent.exited).toBe(0)
  }, 90_000)
})
