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
  return { key, device: { publicKey: base64(key.publicKey), name, kind: 'ios', platform: 'ios' } }
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
    ]
    for (const entry of invalid) expect(await store.add(entry)).toBeNull()
    expect(store.list()).toEqual([])
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
