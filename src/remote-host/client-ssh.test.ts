// The desktop app adding a machine over SSH, with a fake ssh that plays it and the real remote
// host in process behind the loopback listener: installing, updating or leaving the daemon,
// recording this computer's key, opening the channel through `ssh -W`, each way it fails, and
// reconnecting through SSH, asking for the port again when the daemon moved.

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deviceId } from '@shared/remote/device'
import type { HostPairingState } from '@shared/remote/hosts'
import { generateKeyPair } from '@shared/remote/noise'
import { tempFolder } from '../agent-host/testing/temp'
import { ActivityLog } from './activity'
import { HostClient } from './client'
import { DeviceStore } from './devices'
import { HostStore } from './hosts'
import { LoopbackListener } from './loopback'
import { PairingCodes } from './pairing'
import { RemoteServer } from './server'
import { memoryPorts } from './testing/memory'

const FAKE_SSH = path.resolve('src/remote-host/testing/fake-ssh.mts')
const quiet = (): void => {}

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** The fake daemon's `kettu`: its version, and what its ssh-setup prints or exits with. */
function kettuScript(version: string): string {
  return [
    '#!/bin/sh',
    `if [ "$1" = --version ]; then echo ${version}; exit 0; fi`,
    '[ "$1" = ssh-setup ] || { echo "Unknown command" >&2; exit 2; }',
    'printf "%s\\n" "$2" >> "$HOME/requests"',
    'if [ -f "$HOME/setup-exit" ]; then echo "kettu: it failed" >&2; exit "$(cat "$HOME/setup-exit")"; fi',
    'cat "$HOME/host.json"',
    '',
  ].join('\n')
}

async function setup() {
  const dir = await tempFolder('kettu-client-ssh-')
  const home = path.join(dir, 'machine')
  const bin = path.join(home, '.local', 'bin')
  await mkdir(path.join(home, 'bin'), { recursive: true })
  await mkdir(bin, { recursive: true })
  const log = path.join(dir, 'ssh.log')

  const hostKey = await generateKeyPair()
  const deviceKey = await generateKeyPair()
  const devices = await DeviceStore.load(dir, quiet)
  const server = new RemoteServer({
    staticKey: hostKey,
    devices,
    activity: await ActivityLog.load(dir, quiet),
    pairing: new PairingCodes({ hostKey: hostKey.publicKey, addresses: () => [], send: quiet }),
    host: { name: 'Studio', platform: 'linux', version: '0.3.0' },
    uploads: path.join(dir, 'remote', 'uploads'),
    openAgentPort: async () => memoryPorts()[0],
    changed: quiet,
    log: quiet,
  })
  cleanups.push(() => server.stop('stopping'))
  let loopback = await LoopbackListener.start(server, null, quiet)
  cleanups.push(() => loopback.stop())
  const publicKey = Buffer.from(hostKey.publicKey).toString('base64')
  const writeHost = (port: number | null) =>
    writeFile(
      path.join(home, 'host.json'),
      `${JSON.stringify({ publicKey, name: 'Studio', platform: 'linux', version: '0.3.0', port })}\n`,
    )
  await writeHost(loopback.port)

  /** Puts the daemon of `version` on the machine. */
  const installed = async (version: string) => {
    await writeFile(path.join(bin, 'kettu'), kettuScript(version))
    await chmod(path.join(bin, 'kettu'), 0o755)
  }
  // What ssh-setup would do on a real daemon: the remote host takes the device's key.
  const recordDevice = () =>
    server.addDevice({
      publicKey: Buffer.from(deviceKey.publicKey).toString('base64'),
      name: 'Lin MacBook',
      kind: 'desktop',
      platform: 'macOS 26.1',
      model: '',
    })

  const pairings = new Map<number, HostPairingState[]>()
  const installs: string[] = []
  const store = await HostStore.load(dir, quiet)
  const client = new HostClient({
    key: deviceKey,
    hosts: store,
    client: { kind: 'desktop', version: '0.3.0', platform: 'macOS 26.1' },
    name: () => 'Lin MacBook',
    openMainPort: async () => memoryPorts()[0],
    changed: quiet,
    pairing: (pairId, state) => pairings.set(pairId, [...(pairings.get(pairId) ?? []), state]),
    log: quiet,
    ssh: {
      command: process.execPath,
      args: [FAKE_SSH],
      env: { ...process.env, FAKE_SSH_HOME: home, FAKE_SSH_LOG: log },
    },
    installScript: (version) => {
      installs.push(version)
      return [
        'if [ -f "$HOME/install-fails" ]; then',
        '  echo "Downloading kettu-daemon-linux-x64.tar.gz"',
        '  echo "kettu install: Could not download it" >&2',
        '  exit 1',
        'fi',
        'mkdir -p "$HOME/.local/bin"',
        `cat > "$HOME/.local/bin/kettu" <<'KETTU'`,
        kettuScript(version),
        'KETTU',
        'chmod +x "$HOME/.local/bin/kettu"',
        `echo "Installed the Kettu daemon ${version}"`,
      ].join('\n')
    },
    timeoutMs: 2_000,
    sshTimeoutMs: 5_000,
    retryDelay: () => 20,
  })
  cleanups.push(() => client.stop())

  const states = (pairId: number) => pairings.get(pairId) ?? []
  const end = async (pairId: number) => {
    await expect
      .poll(() => ['added', 'failed'].includes(states(pairId).at(-1)?.state ?? ''), {
        timeout: 15_000,
      })
      .toBe(true)
    return states(pairId).at(-1)!
  }
  const runs = async () =>
    (await readFile(log, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { pid: number; forward: string | null; args: string[] })
  const requests = async () =>
    (await readFile(path.join(home, 'requests'), 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown)
  const hostId = await deviceId(hostKey.publicKey)
  return {
    home,
    server,
    client,
    store,
    hostId,
    publicKey,
    installs,
    installed,
    recordDevice,
    writeHost,
    states,
    end,
    runs,
    requests,
    moveLoopback: async () => {
      loopback.stop()
      loopback = await LoopbackListener.start(server, null, quiet)
      await writeHost(loopback.port)
      return loopback.port
    },
    port: () => loopback.port,
  }
}

const describePosix = describe.skipIf(process.platform === 'win32')

describePosix('adding a machine over SSH', () => {
  it('installs the daemon, records this computer and connects through ssh -W', async () => {
    const t = await setup()
    await t.recordDevice()
    t.client.addSsh(1, 'lin@dev-box', 'MacBook Pro')
    const added = await t.end(1)
    expect(t.states(1).map((state) => (state.state === 'ssh' ? state.step : state.state))).toEqual([
      'connecting',
      'installing',
      'adding',
      'opening',
      'added',
    ])
    expect(t.states(1)[1]).toEqual({ state: 'ssh', step: 'installing', version: '0.3.0' })
    expect(added).toMatchObject({
      state: 'added',
      host: {
        id: t.hostId,
        name: 'Studio',
        addresses: [],
        ssh: { target: 'lin@dev-box', port: t.port() },
        connection: { state: 'online', address: { host: '127.0.0.1', port: t.port() } },
      },
    })
    expect(t.installs).toEqual(['0.3.0'])
    // The setup after the install recorded this computer as pairing would have added it.
    expect(await t.requests()).toEqual([
      {
        device: {
          publicKey: expect.any(String),
          name: 'Lin MacBook',
          kind: 'desktop',
          platform: 'macOS 26.1',
          model: 'MacBook Pro',
        },
      },
    ])
    const forwards = (await t.runs()).filter((run) => run.forward)
    expect(forwards.map((run) => run.forward)).toEqual([`127.0.0.1:${t.port()}`])
    await t.store.flush()
    const kept = (await HostStore.load(path.dirname(t.home), quiet)).get(t.hostId)
    expect(kept).toMatchObject({ publicKey: t.publicKey, ssh: { target: 'lin@dev-box' } })
  })

  it('updates an older daemon, and leaves one as new or newer', async () => {
    const t = await setup()
    await t.recordDevice()
    await t.installed('0.2.4')
    t.client.addSsh(1, 'lin@dev-box', '')
    expect(await t.end(1)).toMatchObject({ state: 'added' })
    expect(t.states(1)[1]).toEqual({ state: 'ssh', step: 'updating', from: '0.2.4', to: '0.3.0' })

    await t.installed('0.4.0')
    t.client.addSsh(2, 'lin@dev-box', '')
    expect(await t.end(2)).toMatchObject({ state: 'added' })
    expect(t.states(2).map((state) => (state.state === 'ssh' ? state.step : state.state))).toEqual([
      'connecting',
      'opening',
      'added',
    ])
    expect(t.installs).toEqual(['0.3.0'])
  })

  it.each([
    ['auth@dev-box', 'ssh_auth'],
    ['unknown@dev-box', 'ssh_host_unknown'],
    ['changed@dev-box', 'ssh_host_changed'],
    ['down@dev-box', 'ssh_unreachable'],
    ['windows@dev-box', 'ssh_unsupported'],
  ])('says why %s cannot be added', async (target, reason) => {
    const t = await setup()
    t.client.addSsh(1, target, '')
    expect(await t.end(1)).toMatchObject({ state: 'failed', reason })
    expect(t.client.list()).toEqual([])
    expect(t.installs).toEqual([])
  })

  it('names a system without a package', async () => {
    const t = await setup()
    const uname = path.join(t.home, 'bin', 'uname')
    await writeFile(uname, '#!/bin/sh\n[ "$1" = -s ] && echo FreeBSD || echo amd64\n')
    await chmod(uname, 0o755)
    t.client.addSsh(1, 'lin@dev-box', '')
    expect(await t.end(1)).toEqual({
      state: 'failed',
      reason: 'ssh_unsupported',
      detail: 'FreeBSD amd64',
    })
  })

  it("shows the end of a failed install's output", async () => {
    const t = await setup()
    await writeFile(path.join(t.home, 'install-fails'), '')
    t.client.addSsh(1, 'lin@dev-box', '')
    expect(await t.end(1)).toEqual({
      state: 'failed',
      reason: 'ssh_install',
      detail: 'Downloading kettu-daemon-linux-x64.tar.gz\nkettu install: Could not download it',
    })
  })

  it('says when the daemon is not running, or anything else went wrong', async () => {
    const t = await setup()
    await t.installed('0.3.0')
    await writeFile(path.join(t.home, 'setup-exit'), '3')
    t.client.addSsh(1, 'lin@dev-box', '')
    expect(await t.end(1)).toEqual({ state: 'failed', reason: 'ssh_not_running' })
    await writeFile(path.join(t.home, 'setup-exit'), '1')
    t.client.addSsh(2, 'lin@dev-box', '')
    expect(await t.end(2)).toEqual({
      state: 'failed',
      reason: 'ssh_failed',
      detail: 'kettu: it failed',
    })
  })

  it('says when the server forwards nothing, or nothing takes the forward', async () => {
    const t = await setup()
    await t.installed('0.3.0')
    t.client.addSsh(1, 'noforward@dev-box', '')
    expect(await t.end(1)).toMatchObject({ state: 'failed', reason: 'ssh_forwarding' })
    await t.writeHost(1)
    t.client.addSsh(2, 'lin@dev-box', '')
    expect(await t.end(2)).toMatchObject({ state: 'failed', reason: 'ssh_not_running' })
  })

  it('fails without ssh, and stops when Add host closes', async () => {
    const t = await setup()
    const lone = new HostClient({
      ...t.client.options,
      ssh: { command: path.join(t.home, 'no-ssh'), args: [] },
    })
    cleanups.push(() => lone.stop())
    lone.addSsh(1, 'lin@dev-box', '')
    await expect
      .poll(() => t.states(1).at(-1))
      .toEqual({
        state: 'failed',
        reason: 'ssh_missing',
        detail: expect.any(String),
      })

    await t.installed('0.3.0')
    await writeFile(path.join(t.home, 'bin', 'uname'), '#!/bin/sh\nsleep 5\n')
    await chmod(path.join(t.home, 'bin', 'uname'), 0o755)
    t.client.addSsh(2, 'lin@dev-box', '')
    await expect.poll(() => t.states(2).length).toBe(1)
    t.client.closePairing(2)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(t.states(2)).toEqual([{ state: 'ssh', step: 'connecting' }])
    expect(t.client.list()).toEqual([])
  })

  it('reconnects through ssh, and asks the daemon for its port when it moved', async () => {
    const t = await setup()
    await t.recordDevice()
    await t.installed('0.3.0')
    t.client.addSsh(1, 'lin@dev-box', '')
    expect(await t.end(1)).toMatchObject({ state: 'added' })
    const online = () => t.client.list()[0]?.connection

    // The ssh carrying the channel goes, as when the network drops.
    const [first] = (await t.runs()).filter((run) => run.forward)
    process.kill(first!.pid)
    await expect.poll(() => online()?.state, { timeout: 10_000 }).not.toBe('online')
    await expect.poll(() => online()?.state, { timeout: 10_000 }).toBe('online')
    expect((await t.runs()).filter((run) => run.forward)).toHaveLength(2)

    // The daemon starts again on another port: the forward is refused, so it asks.
    const runs = (await t.runs()).length
    const port = await t.moveLoopback()
    const [, second] = (await t.runs()).filter((run) => run.forward)
    process.kill(second!.pid)
    await expect.poll(() => t.client.list()[0]?.ssh?.port, { timeout: 10_000 }).toBe(port)
    await expect
      .poll(() => online(), { timeout: 10_000 })
      .toEqual({
        state: 'online',
        address: { host: '127.0.0.1', port },
      })
    const after = (await t.runs()).slice(runs)
    // A refused forward, the setup script for the port alone, and the forward to the new port.
    expect(after.map((run) => run.forward ?? 'setup')).toEqual([
      expect.stringMatching(/^127\.0\.0\.1:/),
      'setup',
      `127.0.0.1:${port}`,
    ])
    expect((await t.requests()).at(-1)).toEqual({})
  })
})
