import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { deviceId } from '@shared/remote/device'
import { generateKeyPair } from '@shared/remote/noise'
import { tempFolder } from '../agent-host/testing/temp'
import { HostStore, uniqueAddresses } from './hosts'

const quiet = (): void => {}
const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

async function newHost(name = 'Studio') {
  const key = await generateKeyPair()
  return {
    key,
    host: {
      publicKey: base64(key.publicKey),
      name,
      platform: 'linux' as const,
      version: '0.2.0',
      addresses: [
        { host: '192.168.1.8', port: 47821 },
        { host: '192.168.1.8', port: 47821 },
      ],
      deviceName: 'Lin MacBook',
    },
  }
}

describe('HostStore', () => {
  it('keeps hosts with the id their key gives, across loads', async () => {
    const dir = await tempFolder('kettu-hosts-')
    let now = 1000
    const store = await HostStore.load(dir, quiet, () => now)
    const { key, host } = await newHost()
    const added = await store.add(host)
    expect(added).toEqual({
      ...host,
      id: await deviceId(key.publicKey),
      addresses: [{ host: '192.168.1.8', port: 47821 }],
      addedAt: 1000,
      lastOnlineAt: 1000,
      removed: false,
    })
    now = 2000
    store.online(added!.id)
    store.update(added!.id, {
      deviceName: 'Desk',
      addresses: [{ host: 'dev.example.com', port: 7000 }],
    })
    await store.flush()
    const reloaded = await HostStore.load(dir, quiet)
    expect(reloaded.list()).toEqual([
      {
        ...added,
        deviceName: 'Desk',
        addresses: [{ host: 'dev.example.com', port: 7000 }],
        lastOnlineAt: 2000,
      },
    ])
    expect(await reloaded.remove(added!.id)).toBe(true)
    expect((await HostStore.load(dir, quiet)).list()).toEqual([])
  })

  it('replaces the entry of a host added again, which is no longer removed', async () => {
    const store = await HostStore.load(await tempFolder('kettu-hosts-'), quiet)
    const { host } = await newHost()
    const first = (await store.add(host))!
    store.update(first.id, { removed: true })
    await store.add({ ...host, name: 'Studio 2' })
    expect(store.list()).toEqual([expect.objectContaining({ name: 'Studio 2', removed: false })])
  })

  it('takes no change that would make an entry invalid', async () => {
    const store = await HostStore.load(await tempFolder('kettu-hosts-'), quiet)
    const { host } = await newHost()
    const added = (await store.add(host))!
    expect(store.update(added.id, { deviceName: '' })).toBeNull()
    expect(store.update(added.id, { addresses: [{ host: 'a b', port: 1 }] })).toBeNull()
    expect(store.update('f'.repeat(32), { name: 'x' })).toBeNull()
    expect(store.get(added.id)).toEqual(added)
    expect(await store.add({ ...host, publicKey: 'not a key' })).toBeNull()
  })

  it('drops an entry whose id is not its key', async () => {
    const dir = await tempFolder('kettu-hosts-')
    const store = await HostStore.load(dir, quiet)
    const added = (await store.add((await newHost()).host))!
    const file = path.join(dir, 'remote', 'hosts.json')
    const kept = JSON.parse(await readFile(file, 'utf8'))
    kept.hosts[0].id = 'a'.repeat(32)
    await writeFile(file, JSON.stringify(kept))
    const logs: string[] = []
    const reloaded = await HostStore.load(dir, (_, message) => logs.push(message))
    expect(reloaded.list()).toEqual([])
    expect(reloaded.get(added.id)).toBeNull()
    expect(logs).toEqual(['Dropped hosts whose id is not their key'])
  })
})

describe('uniqueAddresses', () => {
  it('keeps each address once, a host name in any case', () => {
    expect(
      uniqueAddresses([
        { host: 'Dev.Example.com', port: 7000 },
        { host: 'dev.example.com', port: 7000 },
        { host: 'dev.example.com', port: 7001 },
      ]),
    ).toEqual([
      { host: 'Dev.Example.com', port: 7000 },
      { host: 'dev.example.com', port: 7001 },
    ])
  })
})
