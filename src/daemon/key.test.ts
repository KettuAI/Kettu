import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { keyIsPrivate, loadHostKey, newHostKey, prepareDataFolder } from './key'

// Unix modes mean nothing on Windows, which the daemon does not run on.
const describeUnix = describe.skipIf(process.platform === 'win32')

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-daemon-key-'))
})

afterEach(() => rm(dir, { recursive: true, force: true }))

const mode = async (file: string): Promise<number> => (await stat(file)).mode & 0o777
const keyFile = (): string => path.join(dir, 'remote', 'identity.json')

describeUnix('prepareDataFolder', () => {
  it('makes the folder only the user can open', async () => {
    const data = path.join(dir, 'a', 'kettu')
    await prepareDataFolder(data)
    expect(await mode(data)).toBe(0o700)
  })

  it('narrows a folder others can open', async () => {
    const data = path.join(dir, 'kettu')
    await mkdir(data, { mode: 0o755 })
    await chmod(data, 0o755)
    await prepareDataFolder(data)
    expect(await mode(data)).toBe(0o700)
  })
})

describeUnix('loadHostKey', () => {
  it('makes the key on first start, in a file only the user can read', async () => {
    const identity = await loadHostKey(dir, () => {})
    expect(Buffer.from(identity.privateKey, 'base64')).toHaveLength(32)
    // The remote host is told the key is kept without the system's encryption.
    expect(identity.plainText).toBe(true)
    expect(await mode(keyFile())).toBe(0o600)
    expect(await mode(path.dirname(keyFile()))).toBe(0o700)
    expect(await keyIsPrivate(keyFile())).toBe(true)
    expect(JSON.parse(await readFile(keyFile(), 'utf8'))).toEqual({
      version: 1,
      privateKey: identity.privateKey,
      encrypted: false,
      plainText: true,
    })
  })

  it('keeps the key from then on', async () => {
    const first = await loadHostKey(dir, () => {})
    const second = await loadHostKey(dir, () => {})
    expect(second.privateKey).toBe(first.privateKey)
  })

  it('makes the file private again when others could read it, and says so', async () => {
    await loadHostKey(dir, () => {})
    await chmod(keyFile(), 0o644)
    expect(await keyIsPrivate(keyFile())).toBe(false)
    const warnings: string[] = []
    await loadHostKey(dir, (message) => warnings.push(message))
    expect(await mode(keyFile())).toBe(0o600)
    expect(warnings).toEqual([`Others could read ${keyFile()}; it is readable only by you again`])
  })

  it("refuses a key the system encrypted, as in the app's data folder copied over", async () => {
    await mkdir(path.dirname(keyFile()), { recursive: true })
    const file = { version: 1, privateKey: 'ZW5jcnlwdGVk', encrypted: true, plainText: false }
    await writeFile(keyFile(), JSON.stringify(file), { mode: 0o600 })
    await expect(loadHostKey(dir, () => {})).rejects.toThrow('encrypted by the system')
  })

  it('reports no file before the first start', async () => {
    expect(await keyIsPrivate(keyFile())).toBeNull()
  })
})

describeUnix('newHostKey', () => {
  it('replaces the key, kept as the first was, for the next start too', async () => {
    const first = await loadHostKey(dir, () => {})
    const renewed = await newHostKey(dir)
    expect(renewed.privateKey).not.toBe(first.privateKey)
    expect(Buffer.from(renewed.privateKey, 'base64')).toHaveLength(32)
    expect(renewed.plainText).toBe(true)
    expect(await mode(keyFile())).toBe(0o600)
    expect((await loadHostKey(dir, () => {})).privateKey).toBe(renewed.privateKey)
  })
})
