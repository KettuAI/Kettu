import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { deviceId } from '@shared/remote/device'
import { generateKeyPair } from '@shared/remote/noise'
import { tempFolder } from '../agent-host/testing/temp'
import { DeviceStore } from './devices'

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')
const quiet = (): void => {}

async function newDevice(name = 'Phone') {
  const key = await generateKeyPair()
  return {
    key,
    device: {
      publicKey: base64(key.publicKey),
      name,
      kind: 'ios',
      platform: 'ios',
      model: 'iPhone',
    },
  }
}

describe('DeviceStore', () => {
  it('keeps devices with the id their key gives, across loads', async () => {
    const dir = await tempFolder('kettu-devices-')
    let now = 1000
    const store = await DeviceStore.load(dir, quiet, () => now)
    const { key, device } = await newDevice()
    const added = await store.add(device)
    expect(added).toEqual({
      ...device,
      id: await deviceId(key.publicKey),
      addedAt: 1000,
      lastConnectedAt: null,
    })
    expect(store.withKey(key.publicKey)).toEqual(added)
    expect(store.withKey((await generateKeyPair()).publicKey)).toBeNull()

    now = 2000
    store.connected(added!.id)
    await store.flush()
    const reloaded = await DeviceStore.load(dir, quiet)
    expect(reloaded.list()).toEqual([{ ...added, lastConnectedAt: 2000 }])
    expect(await reloaded.remove(added!.id)).toBe(true)
    expect((await DeviceStore.load(dir, quiet)).list()).toEqual([])
  })

  it('replaces the entry of a key paired again', async () => {
    const store = await DeviceStore.load(await tempFolder('kettu-devices-'), quiet)
    const { device } = await newDevice()
    await store.add(device)
    await store.add({ ...device, name: 'New phone' })
    expect(store.list().map((entry) => entry.name)).toEqual(['New phone'])
  })

  it('takes no device without a key, a name, a kind and a platform', async () => {
    const store = await DeviceStore.load(await tempFolder('kettu-devices-'), quiet)
    const { device } = await newDevice()
    const invalid = [
      { ...device, publicKey: base64(new Uint8Array(31)) },
      { ...device, publicKey: 'not base64!' },
      { ...device, name: '' },
      { ...device, name: ' Phone' },
      { ...device, name: 'x'.repeat(65) },
      { ...device, name: 'Line\nbreak' },
      { ...device, kind: '' },
      { ...device, platform: 'x'.repeat(65) },
      { ...device, model: 'x'.repeat(65) },
      { ...device, model: 'Line\nbreak' },
    ]
    for (const entry of invalid) expect(await store.add(entry)).toBeNull()
    expect(store.list()).toEqual([])
  })

  it('renames a device under a name it can keep', async () => {
    const dir = await tempFolder('kettu-devices-')
    const store = await DeviceStore.load(dir, quiet)
    const added = (await store.add((await newDevice()).device))!
    expect(await store.rename(added.id, 'Work phone')).toEqual({ ...added, name: 'Work phone' })
    expect(await store.rename(added.id, ' Padded')).toBeNull()
    expect(await store.rename('f'.repeat(32), 'Other')).toBeNull()
    expect((await DeviceStore.load(dir, quiet)).list()).toEqual([{ ...added, name: 'Work phone' }])
  })

  it('reads a device kept before models were, with none', async () => {
    const dir = await tempFolder('kettu-devices-')
    const { key, device } = await newDevice()
    const { publicKey, name, kind, platform } = device
    const id = await deviceId(key.publicKey)
    const entry = { id, publicKey, name, kind, platform, addedAt: 1, lastConnectedAt: 2 }
    await mkdir(path.join(dir, 'remote'))
    await writeFile(
      path.join(dir, 'remote', 'devices.json'),
      JSON.stringify({ version: 1, devices: [entry] }),
    )
    expect((await DeviceStore.load(dir, quiet)).list()).toEqual([{ ...entry, model: '' }])
  })

  it('keeps the key of a device it removes, across loads', async () => {
    const dir = await tempFolder('kettu-devices-')
    let now = 1000
    const store = await DeviceStore.load(dir, quiet, () => now)
    const { key, device } = await newDevice()
    const added = (await store.add(device))!
    expect(store.removedWithKey(key.publicKey)).toBeNull()
    now = 5000
    expect(await store.remove(added.id)).toBe(true)
    const removed = { id: added.id, publicKey: device.publicKey, removedAt: 5000 }
    expect(store.removedWithKey(key.publicKey)).toEqual(removed)
    expect(store.withKey(key.publicKey)).toBeNull()
    expect(store.removedWithKey((await generateKeyPair()).publicKey)).toBeNull()

    const reloaded = await DeviceStore.load(dir, quiet)
    expect(reloaded.list()).toEqual([])
    expect(reloaded.removedWithKey(key.publicKey)).toEqual(removed)
    const file = JSON.parse(await readFile(path.join(dir, 'remote', 'devices.json'), 'utf8'))
    expect(file).toEqual({ version: 1, devices: [], removed: [removed] })
  })

  it('takes a removed key off the list when it pairs again', async () => {
    const dir = await tempFolder('kettu-devices-')
    const store = await DeviceStore.load(dir, quiet)
    const { key, device } = await newDevice()
    await store.remove((await store.add(device))!.id)
    const again = await store.add(device)
    expect(store.withKey(key.publicKey)).toEqual(again)
    expect(store.removedWithKey(key.publicKey)).toBeNull()
    expect((await DeviceStore.load(dir, quiet)).removedWithKey(key.publicKey)).toBeNull()
  })

  it('empties the removed list for a reset', async () => {
    const dir = await tempFolder('kettu-devices-')
    const store = await DeviceStore.load(dir, quiet)
    const { key, device } = await newDevice()
    await store.remove((await store.add(device))!.id)
    await store.clearRemoved()
    expect(store.removedWithKey(key.publicKey)).toBeNull()
    expect((await DeviceStore.load(dir, quiet)).removedWithKey(key.publicKey)).toBeNull()
  })

  it('keeps at most 1000 removed keys, dropping the oldest first', async () => {
    const dir = await tempFolder('kettu-devices-')
    const removed = await Promise.all(
      Array.from({ length: 1000 }, async (_, index) => {
        const publicKey = crypto.getRandomValues(new Uint8Array(32))
        return { id: await deviceId(publicKey), publicKey: base64(publicKey), removedAt: index }
      }),
    )
    await mkdir(path.join(dir, 'remote'))
    const file = path.join(dir, 'remote', 'devices.json')
    await writeFile(file, JSON.stringify({ version: 1, devices: [], removed }))
    const store = await DeviceStore.load(dir, quiet, () => 2000)
    expect(store.removedWithKey(Buffer.from(removed[0]!.publicKey, 'base64'))).toEqual(removed[0])

    const { key, device } = await newDevice()
    await store.remove((await store.add(device))!.id)
    expect(store.removedWithKey(Buffer.from(removed[0]!.publicKey, 'base64'))).toBeNull()
    expect(store.removedWithKey(Buffer.from(removed[1]!.publicKey, 'base64'))).toEqual(removed[1])
    expect(store.removedWithKey(key.publicKey)).toMatchObject({ removedAt: 2000 })
    const kept = JSON.parse(await readFile(file, 'utf8')).removed
    expect(kept).toHaveLength(1000)
    expect(kept[0]).toEqual(removed[1])
    expect(kept.at(-1)).toMatchObject({ publicKey: device.publicKey, removedAt: 2000 })
  })

  it('reads a file kept before removed devices were, with none removed', async () => {
    const dir = await tempFolder('kettu-devices-')
    const { key, device } = await newDevice()
    const entry = { ...device, id: await deviceId(key.publicKey), addedAt: 1, lastConnectedAt: 2 }
    await mkdir(path.join(dir, 'remote'))
    await writeFile(
      path.join(dir, 'remote', 'devices.json'),
      JSON.stringify({ version: 1, devices: [entry] }),
    )
    const store = await DeviceStore.load(dir, quiet)
    expect(store.list()).toEqual([entry])
    expect(store.removedWithKey(key.publicKey)).toBeNull()
    await store.remove(entry.id)
    expect(store.removedWithKey(key.publicKey)).toMatchObject({ id: entry.id })
  })

  it('drops a removed entry whose id is not its key', async () => {
    const dir = await tempFolder('kettu-devices-')
    const { key, device } = await newDevice()
    const kept = { id: await deviceId(key.publicKey), publicKey: device.publicKey, removedAt: 1 }
    const other = await newDevice('Other')
    const forged = { id: kept.id, publicKey: other.device.publicKey, removedAt: 1 }
    await mkdir(path.join(dir, 'remote'))
    const file = path.join(dir, 'remote', 'devices.json')
    await writeFile(file, JSON.stringify({ version: 1, devices: [], removed: [kept, forged] }))
    const logs: string[] = []
    const store = await DeviceStore.load(dir, (_, message) => logs.push(message))
    expect(store.removedWithKey(key.publicKey)).toEqual(kept)
    expect(store.removedWithKey(other.key.publicKey)).toBeNull()
    expect(logs).toEqual(['Dropped devices whose id is not their key'])
    await store.flush()
    expect(JSON.parse(await readFile(file, 'utf8')).removed).toEqual([kept])
  })

  it('treats a removed list that is not one as a damaged file', async () => {
    const dir = await tempFolder('kettu-devices-')
    await mkdir(path.join(dir, 'remote'))
    const file = path.join(dir, 'remote', 'devices.json')
    for (const removed of [{}, [{ id: 'x', publicKey: 'not a key', removedAt: 1 }]]) {
      await writeFile(file, JSON.stringify({ version: 1, devices: [], removed }))
      const logs: string[] = []
      await DeviceStore.load(dir, (level, message) => logs.push(`${level}: ${message}`))
      expect(logs).toEqual([expect.stringMatching(/^error: devices\.json could not be read/)])
    }
  })

  it('drops an entry whose id is not its key', async () => {
    const dir = await tempFolder('kettu-devices-')
    const { key, device } = await newDevice()
    const kept = { ...device, id: await deviceId(key.publicKey), addedAt: 1, lastConnectedAt: null }
    const forged = { ...(await newDevice('Other')).device, id: kept.id.replace(/./, 'f') }
    await mkdir(path.join(dir, 'remote'))
    const file = path.join(dir, 'remote', 'devices.json')
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        devices: [kept, { ...forged, addedAt: 1, lastConnectedAt: null }],
      }),
    )
    const logs: string[] = []
    const store = await DeviceStore.load(dir, (_, message) => logs.push(message))
    expect(store.list()).toEqual([kept])
    expect(logs).toEqual(['Dropped devices whose id is not their key'])
    await store.flush()
    expect(JSON.parse(await readFile(file, 'utf8')).devices).toEqual([kept])
  })
})
