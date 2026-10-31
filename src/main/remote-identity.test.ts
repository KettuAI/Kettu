import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { importKeyPair } from '@shared/remote/noise'
import { loadIdentity, type IdentityCipher } from './remote-identity'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function dataFolder(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-identity-'))
  dirs.push(dir)
  return dir
}

/** A stand-in for safeStorage: reversible, and never the text it was given. */
function fakeCipher(options: { available?: boolean; plainText?: boolean } = {}) {
  const calls = { encrypt: 0, decrypt: 0 }
  let reEncrypt = false
  const cipher: IdentityCipher & { calls: typeof calls; reEncryptNext(): void } = {
    calls,
    reEncryptNext: () => (reEncrypt = true),
    available: async () => options.available ?? true,
    encrypt: async (text) => {
      calls.encrypt++
      return Buffer.from(`sealed:${[...text].reverse().join('')}`)
    },
    decrypt: async (encrypted) => {
      calls.decrypt++
      const text = encrypted.toString()
      if (!text.startsWith('sealed:')) throw new Error("Not this system's encryption")
      const shouldReEncrypt = reEncrypt
      reEncrypt = false
      return { result: [...text.slice('sealed:'.length)].reverse().join(''), shouldReEncrypt }
    },
    plainText: () => options.plainText ?? false,
  }
  return cipher
}

const identityFile = (dir: string): string => path.join(dir, 'remote', 'identity.json')

describe('loadIdentity', () => {
  it('makes a key on first use and keeps it, encrypted, across restarts', async () => {
    const dir = await dataFolder()
    const cipher = fakeCipher()
    const first = await loadIdentity(dir, cipher)
    expect(first.plainText).toBe(false)
    expect(Buffer.from(first.privateKey, 'base64')).toHaveLength(32)
    // A valid X25519 key.
    expect((await importKeyPair(Buffer.from(first.privateKey, 'base64'))).publicKey).toHaveLength(
      32,
    )
    const text = await readFile(identityFile(dir), 'utf8')
    expect(text).not.toContain(first.privateKey)
    expect(JSON.parse(text)).toMatchObject({ version: 1, encrypted: true, plainText: false })

    const again = await loadIdentity(dir, cipher)
    expect(again).toEqual(first)
    expect(cipher.calls).toEqual({ encrypt: 1, decrypt: 1 })
  })

  it.skipIf(process.platform === 'win32')('keeps the file readable by the user alone', async () => {
    const dir = await dataFolder()
    await loadIdentity(dir, fakeCipher())
    expect((await stat(identityFile(dir))).mode & 0o777).toBe(0o600)
  })

  it('says so where the system encrypts with a key anyone can read', async () => {
    const dir = await dataFolder()
    const identity = await loadIdentity(dir, fakeCipher({ plainText: true }))
    expect(identity.plainText).toBe(true)
    expect(await loadIdentity(dir, fakeCipher({ plainText: true }))).toEqual(identity)
  })

  it('keeps the key as it is where the system cannot encrypt, and says so', async () => {
    const dir = await dataFolder()
    const cipher = fakeCipher({ available: false })
    const identity = await loadIdentity(dir, cipher)
    expect(identity.plainText).toBe(true)
    expect(JSON.parse(await readFile(identityFile(dir), 'utf8'))).toMatchObject({
      privateKey: identity.privateKey,
      encrypted: false,
      plainText: true,
    })
    expect(await loadIdentity(dir, cipher)).toEqual(identity)
    expect(cipher.calls).toEqual({ encrypt: 0, decrypt: 0 })
  })

  it('encrypts the key again when the system asks', async () => {
    const dir = await dataFolder()
    const cipher = fakeCipher()
    const identity = await loadIdentity(dir, cipher)
    cipher.reEncryptNext()
    expect(await loadIdentity(dir, cipher)).toEqual(identity)
    expect(cipher.calls.encrypt).toBe(2)
  })

  it('fails without a new identity when the key does not decrypt', async () => {
    const dir = await dataFolder()
    await loadIdentity(dir, fakeCipher())
    const before = await readFile(identityFile(dir), 'utf8')
    const stored = JSON.parse(before)
    await writeFile(
      identityFile(dir),
      JSON.stringify({ ...stored, privateKey: Buffer.from('other').toString('base64') }),
    )
    await expect(loadIdentity(dir, fakeCipher())).rejects.toThrow("Not this system's encryption")
    expect(JSON.parse(await readFile(identityFile(dir), 'utf8')).privateKey).toBe(
      Buffer.from('other').toString('base64'),
    )
  })

  it('leaves a file from a newer version alone', async () => {
    const dir = await dataFolder()
    await loadIdentity(dir, fakeCipher())
    await writeFile(identityFile(dir), JSON.stringify({ version: 2 }))
    await expect(loadIdentity(dir, fakeCipher())).rejects.toThrow('newer version')
    expect(await readFile(identityFile(dir), 'utf8')).toBe(JSON.stringify({ version: 2 }))
  })

  it('moves a broken file aside and makes a new identity', async () => {
    const dir = await dataFolder()
    const first = await loadIdentity(dir, fakeCipher())
    await writeFile(identityFile(dir), '{ not json')
    const second = await loadIdentity(dir, fakeCipher())
    expect(second.privateKey).not.toBe(first.privateKey)
    const files = await readdir(path.join(dir, 'remote'))
    expect(files.some((file) => file.startsWith('identity.corrupt-'))).toBe(true)
  })
})
