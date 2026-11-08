import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { generateKeyPair } from '@shared/remote/noise'
import { DEFAULT_CHOICES, type DevicePush } from '@shared/remote/push'
import { DeviceStore } from './devices'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function folder(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'kettu-devices-'))
  dirs.push(dir)
  return dir
}

const log = (): void => {}

async function phone(store: DeviceStore) {
  const key = await generateKeyPair()
  return (await store.add({
    publicKey: Buffer.from(key.publicKey).toString('base64'),
    name: 'Phone',
    kind: 'ios',
    platform: 'iOS 26.1',
    model: 'iPhone 17 Pro',
  }))!
}

const PUSH: DevicePush = {
  target: {
    apns: { token: 'a1'.repeat(32), environment: 'production' },
    activity: { start: 'c3'.repeat(80) },
  },
  choices: { ...DEFAULT_CHOICES, routines: true, muted: ['s1'] },
}

const file = (dir: string) => path.join(dir, 'remote', 'devices.json')

describe("a device's notifications", () => {
  it('are kept with the device across a restart, but never in its listing', async () => {
    const dir = await folder()
    const store = await DeviceStore.load(dir, log)
    const device = await phone(store)
    expect(await store.setPush(device.id, PUSH)).toBe(true)
    expect(store.list()[0]).not.toHaveProperty('push')

    const again = await DeviceStore.load(dir, log)
    expect(again.push(device.id)).toEqual(PUSH)
    expect(again.list()).toEqual([device])
    // A rename and a connection keep them.
    await again.rename(device.id, 'iPhone')
    again.connected(device.id)
    await again.flush()
    expect((await DeviceStore.load(dir, log)).push(device.id)).toEqual(PUSH)
  })

  it('go with the device when it is removed or paired again', async () => {
    const dir = await folder()
    const store = await DeviceStore.load(dir, log)
    const device = await phone(store)
    await store.setPush(device.id, PUSH)
    await store.remove(device.id)
    expect(store.push(device.id)).toBeNull()
    expect(await readFile(file(dir), 'utf8')).not.toContain(PUSH.target!.apns.token)
    expect(await store.setPush(device.id, PUSH)).toBe(false)

    const other = await phone(store)
    await store.setPush(other.id, PUSH)
    await store.add({ ...other })
    expect(store.push(other.id)).toBeNull()
  })

  it('are forgotten with null', async () => {
    const dir = await folder()
    const store = await DeviceStore.load(dir, log)
    const device = await phone(store)
    await store.setPush(device.id, PUSH)
    await store.setPush(device.id, null)
    expect((await DeviceStore.load(dir, log)).push(device.id)).toBeNull()
  })

  it('that do not read are dropped, and the device kept', async () => {
    const dir = await folder()
    const store = await DeviceStore.load(dir, log)
    const device = await phone(store)
    await store.setPush(device.id, PUSH)
    const written = JSON.parse(await readFile(file(dir), 'utf8'))
    written.devices[0].push.target.apns.token = 'not hex'
    await writeFile(file(dir), JSON.stringify(written))
    const again = await DeviceStore.load(dir, log)
    expect(again.list()).toEqual([device])
    expect(again.push(device.id)).toBeNull()
  })
})
