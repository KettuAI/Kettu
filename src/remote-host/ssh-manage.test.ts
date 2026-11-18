import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { generateKeyPair } from '@shared/remote/noise'
import { HostClient } from './client'
import { HostStore } from './hosts'

const log = (): void => {}
const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-ssh-manage-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const keyText = async (): Promise<string> =>
  Buffer.from((await generateKeyPair()).publicKey).toString('base64')

/**
 * An ssh that answers the setup script for each machine as its daemon would: `same` and `alias`
 * reach the host's daemon, `other` another daemon, `bare` a machine without Kettu, and `down`
 * nothing at all.
 */
function fakeSsh(dir: string, hostKey: string, otherKey: string) {
  const script = path.join(dir, 'ssh.cjs')
  writeFileSync(
    script,
    `
const args = process.argv.slice(2)
const target = args[args.indexOf('--') + 1]
process.stdin.resume()
process.stdin.on('end', () => {
  const host = (publicKey) => JSON.stringify({ publicKey, name: 'devbox', platform: 'linux', version: '0.1.9', port: 41234 })
  const say = (lines) => process.stdout.write(lines.map((line) => 'kettu-ssh ' + line + '\\n').join(''))
  if (target === 'down') {
    process.stderr.write('ssh: connect to host down port 22: Connection refused\\n')
    process.exit(255)
  }
  if (target === 'bare') say(['system Linux x86_64'])
  else say(['system Linux x86_64', 'version 0.1.9', 'host ' + host(target === 'other' ? ${JSON.stringify(otherKey)} : ${JSON.stringify(hostKey)})])
  process.exit(0)
})
`,
  )
  return { command: process.execPath, args: [script] }
}

async function setup() {
  const dir = tempDir()
  const hostKey = await keyText()
  const otherKey = await keyText()
  const hosts = await HostStore.load(dir, log)
  const host = await hosts.add({
    publicKey: hostKey,
    name: 'devbox',
    platform: 'linux',
    version: '0.1.9',
    addresses: [],
    deviceName: 'Laptop',
    ssh: { target: 'same', port: 41000 },
  })
  const client = new HostClient({
    key: await generateKeyPair(),
    hosts,
    client: { kind: 'desktop', version: '0.1.10', platform: 'macOS 26.1' },
    name: () => 'Laptop',
    changed: () => {},
    pairing: () => {},
    log,
    ssh: fakeSsh(dir, hostKey, otherKey),
    networkCheckMs: null,
  })
  cleanups.push(() => client.stop())
  return { hosts, id: host!.id, client }
}

describe('changing the SSH address of a host', () => {
  it('takes another address that reaches the same daemon, with its port there', async () => {
    const t = await setup()
    const address = { target: 'alias', sshPort: 2222, identityFile: '/keys/dev' }
    expect(await t.client.manageSsh(t.id, { kind: 'address', address })).toEqual({ ok: true })
    expect(t.hosts.get(t.id)?.ssh).toEqual({ ...address, port: 41234 })
  })

  it('refuses an address whose daemon has another key, keeping the old one', async () => {
    const t = await setup()
    const result = await t.client.manageSsh(t.id, {
      kind: 'address',
      address: { target: 'other' },
    })
    expect(result).toEqual({ ok: false, reason: 'other_host' })
    expect(t.hosts.get(t.id)?.ssh).toEqual({ target: 'same', port: 41000 })
  })

  it('refuses a machine without Kettu, and keeps the old address when ssh fails', async () => {
    const t = await setup()
    expect(
      await t.client.manageSsh(t.id, { kind: 'address', address: { target: 'bare' } }),
    ).toEqual({ ok: false, reason: 'other_host' })
    const down = await t.client.manageSsh(t.id, { kind: 'address', address: { target: 'down' } })
    expect(down).toMatchObject({ ok: false, reason: 'ssh_unreachable' })
    expect(t.hosts.get(t.id)?.ssh).toEqual({ target: 'same', port: 41000 })
  })
})
