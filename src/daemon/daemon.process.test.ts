// Process test: `kettu run` built as it ships, on a data folder and a home of its own. It runs a
// turn of the fake agent through the agent host's socket, answers `kettu status` and
// `kettu devices` with the remote host's devices, restarts a host that is killed, and stops
// everything on SIGTERM. A paired device connects to it directly while `kettu direct` moves the
// port and adds and removes an address.

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HostEvent } from '@shared/agent-host'
import type { PortChannel } from '@shared/port-channel'
import type { FromPort } from '@shared/port-rpc'
import { deviceId, type PairedDevice } from '@shared/remote/device'
import { generateKeyPair, importKeyPair, type KeyPair } from '@shared/remote/noise'
import { parsePairingLink } from '@shared/remote/pairing'
import type { DirectAddress } from '@shared/remote/protocol'
import { connectPort } from '@shared/socket-port'
import { FAKE_AGENT_MAIN, TestPort } from '../agent-host/testing/harness'
import { connectTransport } from '../remote-host/direct'
import { connectDevice, type TestDevice } from '../remote-host/testing/device'
import { callControl, type DaemonStatus } from './control'

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))

let dir = ''
let bundle = ''
let data = ''
let socket = ''
let env: NodeJS.ProcessEnv = {}
let daemon: ChildProcess | null = null
const daemons: ChildProcess[] = []
const clients: PortChannel[] = []
const devices: TestDevice[] = []

interface Run {
  code: number
  stdout: string
  stderr: string
}

function kettu(...args: string[]): Promise<Run> {
  return kettuOn(data, ...args)
}

function kettuOn(dataFolder: string, ...args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(bundle, 'main.cjs'), ...args],
      { env: { ...env, KETTU_DAEMON_DATA: dataFolder } },
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

const status = (at = socket): Promise<DaemonStatus> => callControl(at, 'status', undefined)

async function agentPort(at = socket): Promise<TestPort> {
  const { path: agentSocket } = await callControl(at, 'host.socket', { host: 'agent' })
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

interface Running {
  child: ChildProcess
  exited: Promise<number | null>
  output(): string
}

/** `kettu run` on a data folder of its own. */
function run(dataFolder: string): Running {
  let output = ''
  const child = spawn(process.execPath, [path.join(bundle, 'main.cjs'), 'run'], {
    env: { ...env, KETTU_DAEMON_DATA: dataFolder },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  daemons.push(child)
  child.stdout!.on('data', (chunk: Buffer) => (output += chunk.toString()))
  child.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()))
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
  return { child, exited, output: () => output }
}

afterAll(async () => {
  for (const client of clients) client.close()
  for (const device of devices) device.close()
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL')
  for (const child of daemons) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
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
    for (const args of [
      ['direct'],
      ['direct', 'port', '4567', '--yes'],
      ['direct', 'add', 'frp.example.com:60021'],
      ['direct', 'remove', 'frp.example.com:60021'],
    ]) {
      expect(await kettu(...args)).toEqual({
        code: 3,
        stdout: '',
        stderr: 'kettu: The daemon is not running\n',
      })
    }
  })

  it('runs the hosts, restarts one that dies and stops them all on SIGTERM', async () => {
    // A device paired before, as the remote host keeps it.
    const { publicKey } = await generateKeyPair()
    const phone: PairedDevice = {
      id: await deviceId(publicKey),
      publicKey: Buffer.from(publicKey).toString('base64'),
      name: "Ada's iPhone",
      kind: 'ios',
      platform: 'ios',
      model: 'iPhone 17 Pro',
      addedAt: Date.now(),
      lastConnectedAt: null,
    }
    await mkdir(path.join(data, 'remote'), { recursive: true })
    await writeFile(
      path.join(data, 'remote', 'devices.json'),
      JSON.stringify({ version: 1, devices: [phone] }),
    )

    let output = ''
    daemon = spawn(process.execPath, [path.join(bundle, 'main.cjs'), 'run'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    daemon.stdout!.on('data', (chunk: Buffer) => (output += chunk.toString()))
    daemon.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()))
    const exited = new Promise<number | null>((resolve) => daemon!.once('exit', resolve))
    // Remote access is on from the start, once the agent host it connects to is ready.
    const ready = await until(async () => {
      const current = await status()
      return current.hosts.remote.state === 'ready' && current.connectedDevices !== null && current
    }, `ready remote host\n${output}`)
    const keyFile = path.join(data, 'remote', 'identity.json')
    expect(ready).toMatchObject({
      version: '0.0.0',
      pid: daemon.pid,
      dataPath: data,
      service: false,
      key: { storage: 'file', path: keyFile, private: true },
      hosts: {
        agent: { state: 'ready', restarts: 0 },
        terminal: { state: 'idle', pid: null, restarts: 0 },
        remote: { state: 'ready', restarts: 0 },
      },
      connectedDevices: 0,
    })
    // The key is kept as the app keeps it without the system's encryption.
    expect(JSON.parse(await readFile(keyFile, 'utf8'))).toMatchObject({
      encrypted: false,
      plainText: true,
    })

    // The CLI against the running daemon.
    const printed = await kettu('status')
    expect(printed.code).toBe(0)
    expect(printed.stdout).toContain(
      `Kettu daemon 0.0.0 is running in the foreground (pid ${daemon.pid})`,
    )
    expect(printed.stdout).toContain(`Private key:        in a file only you can read, ${keyFile}`)
    expect(printed.stdout).toContain(`Agent host:         ready (pid ${ready.hosts.agent.pid})`)
    expect(printed.stdout).toContain(`Remote host:        ready (pid ${ready.hosts.remote.pid})`)
    expect(printed.stdout).toContain('Connected devices:  0')
    expect(ready.direct).toMatchObject({ state: 'listening', port: expect.any(Number) })
    expect(printed.stdout).toContain(
      `Direct connections: listening on port ${(ready.direct as { port: number }).port}`,
    )
    const listed = await kettu('devices')
    expect(listed).toMatchObject({ code: 0, stderr: '' })
    expect(listed.stdout.split('\n')[1]).toMatch(
      new RegExp(`^${phone.id}  Ada's iPhone  ios +ios +never$`),
    )
    expect(await kettu('devices', 'remove', 'phone')).toEqual({
      code: 1,
      stdout: '',
      stderr: "kettu: A device's id is 32 hexadecimal digits\n",
    })
    const stranger = 'f'.repeat(32)
    expect(await kettu('devices', 'remove', stranger)).toMatchObject({
      code: 1,
      stderr: `kettu: No device ${stranger} is paired with this computer\n`,
    })
    expect(await kettu('devices', 'remove', phone.id)).toEqual({
      code: 0,
      stdout: `Removed the device ${phone.id}.\n`,
      stderr: '',
    })
    expect((await kettu('devices')).stdout).toBe('No devices are paired with this computer.\n')
    expect(await kettu('run')).toMatchObject({
      code: 1,
      stderr: `kettu: A Kettu daemon is already running on this data folder (pid ${daemon.pid})\n`,
    })

    // A pairing code from the remote host, void once the command is stopped.
    const pairing = spawn(process.execPath, [path.join(bundle, 'main.cjs'), 'pair'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let paired = ''
    pairing.stdout!.on('data', (chunk: Buffer) => (paired += chunk.toString()))
    pairing.stderr!.on('data', (chunk: Buffer) => (paired += chunk.toString()))
    const pairExit = new Promise<number | null>((resolve) => pairing.once('exit', resolve))
    const link = await until(
      async () => /https:\/\/kettu\.sh\/pair#\S+/.exec(paired)?.[0] ?? null,
      `pairing link\n${paired}`,
    )
    // The code carries the addresses direct connections listen at.
    const { direct } = await status()
    expect(direct?.state).toBe('listening')
    expect(parsePairingLink(link)).toMatchObject({
      version: 1,
      addresses: direct?.state === 'listening' ? direct.addresses : null,
    })
    expect(paired).toContain('the code expires in 5:00.')
    pairing.kill('SIGINT')
    expect(await pairExit).toBe(130)
    expect(paired).toMatch(/Stopped; the code is void\.\n$/)

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

    // A host killed is started again, on its socket, which the remote host keeps using.
    const killed = both.hosts.agent.pid!
    const remotePid = both.hosts.remote.pid!
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
    expect((await status()).hosts.remote).toMatchObject({ state: 'ready', pid: remotePid })

    daemon.kill('SIGTERM')
    expect(await exited).toBe(0)
    expect(alive(restarted.pid!)).toBe(false)
    expect(alive(terminalPid)).toBe(false)
    expect(alive(remotePid)).toBe(false)
    expect(await exists(socket)).toBe(false)
    // Devices are told before their sessions' agent host stops.
    expect(output.indexOf('[remote-host] Stopped')).toBeGreaterThan(0)
    expect(output.indexOf('[remote-host] Stopped')).toBeLessThan(
      output.indexOf('[agent-host] Stopped with code 0'),
    )
    expect(output).toContain('[daemon] Stopped')
    expect((await kettu('status')).code).toBe(3)
  }, 90_000)

  it('lists a session it wrote after the agent host is killed and restarted', async () => {
    const folder = path.join(dir, 'data-restart')
    const control = path.join(folder, 'control.sock')
    const daemonRun = run(folder)
    const first = await until(async () => {
      const { agent } = (await status(control)).hosts
      return agent.state === 'ready' && agent
    }, `ready agent host\n${daemonRun.output()}`)

    const project = path.join(dir, 'project-restart')
    await mkdir(project)
    const port = await agentPort(control)
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
    expect((await port.request('sessions.list', {})).map((s) => s.id)).toContain(session.id)

    // A restarted host lists what its index holds, which it writes 500 ms after a change: a host
    // killed sooner starts without the session, whichever process restarts it.
    const index = path.join(folder, 'state', 'sessions.json')
    await until(async () => {
      const written = JSON.parse(await readFile(index, 'utf8')) as { sessions: { id: string }[] }
      return written.sessions.some((record) => record.id === session.id)
    }, 'the session in the index')

    process.kill(first.pid!, 'SIGKILL')
    await until(async () => {
      const { agent } = (await status(control)).hosts
      return agent.state === 'ready' && agent.pid !== null && agent.pid !== first.pid
    }, `restarted agent host\n${daemonRun.output()}`)
    const again = await agentPort(control)
    const listed = await again.request('sessions.list', {})
    expect(listed.map((summary) => summary.id)).toContain(session.id)
    expect(listed.find((summary) => summary.id === session.id)).toMatchObject({
      agentId: 'fake-agent',
      projectPath: project,
    })

    daemonRun.child.kill('SIGTERM')
    expect(await daemonRun.exited).toBe(0)
  }, 90_000)

  it('takes direct connections, on a port and at addresses kettu direct changes', async () => {
    const folder = path.join(dir, 'data-direct')
    const phone = await generateKeyPair()
    const paired: PairedDevice = {
      id: await deviceId(phone.publicKey),
      publicKey: Buffer.from(phone.publicKey).toString('base64'),
      name: "Ada's iPhone",
      kind: 'ios',
      platform: 'ios',
      model: 'iPhone 17 Pro',
      addedAt: Date.now(),
      lastConnectedAt: null,
    }
    await mkdir(path.join(folder, 'remote'), { recursive: true })
    await writeFile(
      path.join(folder, 'remote', 'devices.json'),
      JSON.stringify({ version: 1, devices: [paired] }),
    )
    const daemonRun = run(folder)
    const cli = (...args: string[]): Promise<Run> => kettuOn(folder, ...args)

    // The first run turns direct connections on, on a port picked for it.
    const shown = await until(async () => {
      const printed = await cli('direct')
      return (
        printed.code === 0 && /^Direct connections listen on port (\d+)\.\n/.exec(printed.stdout)
      )
    }, `direct connections listening\n${daemonRun.output()}`)
    const first = Number(shown[1])
    expect(first).toBeGreaterThanOrEqual(49152)
    // Saved shortly after, as every change to the settings is.
    const saved = await until(
      async () => JSON.parse(await readFile(path.join(folder, 'settings.json'), 'utf8')),
      'the saved settings',
    )
    expect(saved.remote.direct).toEqual({ enabled: true, port: first, addresses: [] })

    const identity = JSON.parse(
      await readFile(path.join(folder, 'remote', 'identity.json'), 'utf8'),
    )
    const hostKey = (await importKeyPair(Buffer.from(identity.privateKey, 'base64'))).publicKey
    const connect = async (port: number, key: KeyPair = phone): Promise<TestDevice> => {
      const transport = await connectTransport({ host: '127.0.0.1', port })
      const device = await connectDevice({ transport, hostKey, key })
      devices.push(device)
      return device
    }
    const ada = await connect(first)
    expect(await ada.first).toMatchObject({ type: 'welcome', role: 'owner' })

    // A new port needs --yes without a terminal to ask on, then listens instead of the old one.
    const second = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as { port: number }
        probe.close(() => resolve(port))
      })
    })
    const refused = await cli('direct', 'port', String(second))
    expect(refused).toMatchObject({
      code: 1,
      stderr: 'kettu: Changing the port needs --yes when there is no terminal to ask on\n',
    })
    expect(refused.stdout).toMatch(/^Direct connections move to port \d+\. Devices online get/)
    expect((await status(path.join(folder, 'control.sock'))).direct).toMatchObject({ port: first })
    const moved = await cli('direct', 'port', String(second), '--yes')
    expect(moved).toMatchObject({ code: 0, stderr: '' })
    expect(moved.stdout).toContain(`Direct connections listen on port ${second}.\n`)
    await expect(connectTransport({ host: '127.0.0.1', port: first })).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    })
    const again = await connect(second)
    expect(await again.first).toMatchObject({ type: 'welcome', role: 'owner' })
    expect((await cli('status')).stdout).toContain(
      `Direct connections: listening on port ${second}`,
    )

    // An address of the owner's own reaches the devices connected on either port, first.
    const latest = (device: TestDevice): DirectAddress[] | null =>
      device.addresses.at(-1)?.addresses ?? null
    const hasFrp = (device: TestDevice): boolean =>
      latest(device)?.some((address) => address.host === 'frp.example.com') ?? false
    expect(await cli('direct', 'add', 'frp.example.com:60021')).toEqual({
      code: 0,
      stdout: 'Added frp.example.com:60021, which devices try first.\n',
      stderr: '',
    })
    for (const device of [ada, again]) {
      await until(async () => latest(device)?.[0]?.host === 'frp.example.com', 'the address')
      expect(latest(device)![0]).toEqual({ host: 'frp.example.com', port: 60021 })
    }
    expect((await cli('direct')).stdout).toMatch(/^ {2}frp\.example\.com:60021 +yours$/m)
    expect(await cli('direct', 'add', 'FRP.example.com:60021')).toEqual({
      code: 1,
      stdout: '',
      stderr: 'kettu: This address is already in the list\n',
    })
    expect((await cli('direct', 'add', 'https://frp.example.com')).code).toBe(2)
    expect(await cli('direct', 'add', '[fd00::1]:4567')).toMatchObject({
      code: 0,
      stdout: 'Added [fd00::1]:4567, which devices try first.\n',
    })
    // Passed on without waiting for the remote host, whose report follows.
    await until(
      async () => /^ {2}\[fd00::1\]:4567 +yours$/m.test((await cli('direct')).stdout),
      'the IPv6 address listed',
    )
    expect((await cli('direct', 'remove', '[fd00::1]:4567')).code).toBe(0)
    const sentBefore = [ada.addresses.length, again.addresses.length]
    expect(await cli('direct', 'remove', 'frp.example.com:60021')).toEqual({
      code: 0,
      stdout: 'Removed frp.example.com:60021.\n',
      stderr: '',
    })
    for (const [index, device] of [ada, again].entries()) {
      await until(
        async () => device.addresses.length > sentBefore[index]! && !hasFrp(device),
        'the address removed',
      )
    }

    daemonRun.child.kill('SIGTERM')
    expect(await daemonRun.exited).toBe(0)
    const kept = JSON.parse(await readFile(path.join(folder, 'settings.json'), 'utf8'))
    expect(kept.remote.direct).toEqual({ enabled: true, port: second, addresses: [] })
  }, 90_000)
})
