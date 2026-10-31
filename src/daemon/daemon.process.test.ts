// Process test: `kettu run` built as it ships, on a data folder and a home of its own. It runs a
// turn of the fake agent through the agent host's socket, answers `kettu status` and
// `kettu devices`, restarts a host that is killed, and stops everything on SIGTERM.

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HostEvent } from '@shared/agent-host'
import type { PortChannel } from '@shared/port-channel'
import type { FromPort } from '@shared/port-rpc'
import { connectPort } from '@shared/socket-port'
import { FAKE_AGENT_MAIN, TestPort } from '../agent-host/testing/harness'
import { callControl, type DaemonStatus } from './control'

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))

let dir = ''
let bundle = ''
let data = ''
let socket = ''
let env: NodeJS.ProcessEnv = {}
let daemon: ChildProcess | null = null
const clients: PortChannel[] = []

interface Run {
  code: number
  stdout: string
  stderr: string
}

function kettu(...args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(bundle, 'main.cjs'), ...args],
      { env },
      (error, stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, stdout, stderr }),
    )
  })
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  )

async function until<T>(check: () => Promise<T | null | false>, what: string, ms = 30_000) {
  const started = Date.now()
  for (;;) {
    const value = await check().catch(() => null)
    if (value) return value
    if (Date.now() - started > ms) throw new Error(`No ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const status = (): Promise<DaemonStatus> => callControl(socket, 'status', undefined)

async function agentPort(): Promise<TestPort> {
  const { path: agentSocket } = await callControl(socket, 'host.socket', { host: 'agent' })
  const client = await connectPort(agentSocket)
  clients.push(client)
  const port = new TestPort()
  port.onMessage((message) => client.send(message))
  client.onMessage((message) => port.send(message as FromPort<HostEvent>))
  return port
}

// The daemon runs on macOS and Linux only.
const describeUnix = describe.skipIf(process.platform === 'win32')

beforeAll(async () => {
  if (process.platform === 'win32') return
  // Short, so the control socket's path fits.
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kd-')))
  bundle = path.join(dir, 'bundle')
  data = path.join(dir, 'data')
  socket = path.join(data, 'control.sock')
  await mkdir(path.join(dir, 'home'))
  await build({
    configFile: path.join(root, 'vite.daemon.config.mts'),
    logLevel: 'silent',
    build: { outDir: bundle },
  })
  env = {
    ...process.env,
    // Its own home, so the shell probe and the agent lookup read nothing of the user's.
    HOME: path.join(dir, 'home'),
    SHELL: '/bin/sh',
    KETTU_DAEMON_DATA: data,
    KETTU_FAKE_AGENT: FAKE_AGENT_MAIN,
    FAKE_AGENT_DELAY_SCALE: '0',
    // node-pty is native, so the bundle outside the checkout loads it from there.
    NODE_PATH: path.join(root, 'node_modules'),
  }
  delete env.KETTU_DAEMON_SERVICE
}, 120_000)

afterAll(async () => {
  for (const client of clients) client.close()
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL')
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

describeUnix('kettu', () => {
  it('prints its version and help, and refuses what it does not know', async () => {
    expect(await kettu('--version')).toEqual({ code: 0, stdout: '0.0.0\n', stderr: '' })
    const help = await kettu('--help')
    expect(help.code).toBe(0)
    expect(help.stdout).toMatch(/^Usage: kettu <command>/)
    expect(await kettu('start')).toEqual({
      code: 2,
      stdout: '',
      stderr: "kettu: Unknown command 'start'. Run kettu --help for usage.\n",
    })
    expect((await kettu('status', '--all')).code).toBe(2)
  })

  it('says the daemon is not running before it starts', async () => {
    expect(await kettu('status')).toEqual({
      code: 3,
      stdout: `Kettu daemon is not running\nVersion:     0.0.0\nData folder: ${data}\n`,
      stderr: '',
    })
    expect(await kettu('devices')).toMatchObject({
      code: 1,
      stderr: 'kettu: The daemon is not running\n',
    })
  })

  it('runs the hosts, restarts one that dies and stops them all on SIGTERM', async () => {
    let output = ''
    daemon = spawn(process.execPath, [path.join(bundle, 'main.cjs'), 'run'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    daemon.stdout!.on('data', (chunk: Buffer) => (output += chunk.toString()))
    daemon.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()))
    const exited = new Promise<number | null>((resolve) => daemon!.once('exit', resolve))
    const ready = await until(
      async () => (await status()).hosts.agent.state === 'ready' && status(),
      `ready agent host\n${output}`,
    )
    expect(ready).toMatchObject({
      version: '0.0.0',
      pid: daemon.pid,
      dataPath: data,
      service: false,
      key: { storage: 'file', path: path.join(data, 'host.key'), private: true },
      hosts: { terminal: { state: 'idle', pid: null, restarts: 0 } },
      connectedDevices: null,
    })

    // The CLI against the running daemon.
    const printed = await kettu('status')
    expect(printed.code).toBe(0)
    expect(printed.stdout).toContain(
      `Kettu daemon 0.0.0 is running in the foreground (pid ${daemon.pid})`,
    )
    expect(printed.stdout).toContain(`Private key:       in a file only you can read, ${data}`)
    expect(printed.stdout).toContain(`Agent host:        ready (pid ${ready.hosts.agent.pid})`)
    expect(await kettu('devices')).toMatchObject({
      code: 1,
      stderr: 'kettu: Remote access is not running\n',
    })
    expect(await kettu('run')).toMatchObject({
      code: 1,
      stderr: `kettu: A Kettu daemon is already running on this data folder (pid ${daemon.pid})\n`,
    })

    // A turn of the fake agent over a port to the agent host's socket.
    const project = path.join(dir, 'project')
    await mkdir(project)
    const port = await agentPort()
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
    expect(
      port.entries(session.id).some((entry) => entry.kind === 'agent' && entry.markdown.length > 0),
    ).toBe(true)

    // The terminal host starts on its first use.
    await callControl(socket, 'host.socket', { host: 'terminal' })
    const both = await status()
    expect(both.hosts.terminal).toMatchObject({ state: 'ready', restarts: 0 })
    const terminalPid = both.hosts.terminal.pid!

    // A host killed is started again, on a new socket.
    const killed = both.hosts.agent.pid!
    process.kill(killed, 'SIGKILL')
    const restarted = await until(async () => {
      const { agent } = (await status()).hosts
      return agent.state === 'ready' && agent.pid !== null && agent.pid !== killed && agent
    }, `restarted agent host\n${output}`)
    expect(restarted.restarts).toBe(1)
    expect(output).toContain('[agent-host] Exited unexpectedly with signal SIGKILL')
    const again = await agentPort()
    const agents = await again.request('agents.list', undefined)
    expect(agents.map((agent) => agent.id)).toContain('fake-agent')

    daemon.kill('SIGTERM')
    expect(await exited).toBe(0)
    expect(alive(restarted.pid!)).toBe(false)
    expect(alive(terminalPid)).toBe(false)
    expect(await exists(socket)).toBe(false)
    expect(output).toContain('[daemon] Stopped')
    expect((await kettu('status')).code).toBe(3)
  }, 90_000)
})
