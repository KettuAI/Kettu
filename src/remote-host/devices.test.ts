import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deviceId } from '@shared/remote/device'
import { generateKeyPair } from '@shared/remote/noise'
import { DeviceStore } from './devices'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const log = (): void => {}

async function folder(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-devices-'))
  dirs.push(dir)
  return dir
}

describe("a paired device's account", () => {
  it('reads as none from a file kept before accounts, and is kept as its hellos name it', async () => {
    const dir = await folder()
    const key = await generateKeyPair()
    const publicKey = Buffer.from(key.publicKey).toString('base64')
    const id = await deviceId(key.publicKey)
    await mkdir(path.join(dir, 'remote'), { recursive: true })
    const device = { id, publicKey, name: 'Phone', kind: 'ios', platform: 'iOS 26.1' }
    const old = { ...device, model: '', addedAt: 1, lastConnectedAt: null }
    await writeFile(
      path.join(dir, 'remote', 'devices.json'),
      JSON.stringify({ version: 1, devices: [old] }),
    )
    const store = await DeviceStore.load(dir, log)
    expect(store.get(id)?.account).toBeNull()

    store.noteAccount(id, 'acc_a')
    store.connected(id)
    expect(store.get(id)?.account).toBe('acc_a')
    await store.flush()
    expect((await DeviceStore.load(dir, log)).get(id)?.account).toBe('acc_a')
    store.noteAccount(id, null)
    expect(store.get(id)?.account).toBeNull()
  })

  it('is taken from pairing, and refused when it is no account id', async () => {
    const store = await DeviceStore.load(await folder(), log)
    const key = await generateKeyPair()
    const base = {
      publicKey: Buffer.from(key.publicKey).toString('base64'),
      name: 'Laptop',
      kind: 'desktop',
      platform: 'macOS 26.1',
      model: '',
    }
    expect(await store.add({ ...base, account: 'a\nb' })).toBeNull()
    expect((await store.add({ ...base, account: 'acc_a' }))?.account).toBe('acc_a')
    expect((await store.add(base))?.account).toBeNull()
  })
})
