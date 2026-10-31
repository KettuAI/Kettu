import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { keyIsPrivate, loadHostKey, prepareDataFolder } from './key'

// Unix modes mean nothing on Windows, which the daemon does not run on.
const describeUnix = describe.skipIf(process.platform === 'win32')

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-daemon-key-'))
})

afterEach(() => rm(dir, { recursive: true, force: true }))

const mode = async (file: string): Promise<number> => (await stat(file)).mode & 0o777

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
  it('makes a 32-byte key on first start, in a file only the user can read', async () => {
    const key = await loadHostKey(dir, () => {})
    expect(key.path).toBe(path.join(dir, 'host.key'))
    expect(key.privateKey).toHaveLength(32)
    expect(await mode(key.path)).toBe(0o600)
    expect(await keyIsPrivate(key.path)).toBe(true)
    expect(Buffer.from((await readFile(key.path, 'utf8')).trim(), 'base64')).toEqual(
      Buffer.from(key.privateKey),
    )
  })

  it('keeps the key from then on', async () => {
    const first = await loadHostKey(dir, () => {})
    const second = await loadHostKey(dir, () => {})
    expect(second.privateKey).toEqual(first.privateKey)
  })

  it('makes the file private again when others could read it, and says so', async () => {
    const { path: file } = await loadHostKey(dir, () => {})
    await chmod(file, 0o644)
    expect(await keyIsPrivate(file)).toBe(false)
    const warnings: string[] = []
    await loadHostKey(dir, (message) => warnings.push(message))
    expect(await mode(file)).toBe(0o600)
    expect(warnings).toEqual([`Others could read ${file}; it is readable only by you again`])
  })

  it('refuses a damaged key rather than making a new identity', async () => {
    await writeFile(path.join(dir, 'host.key'), 'not a key\n', { mode: 0o600 })
    await expect(loadHostKey(dir, () => {})).rejects.toThrow('is damaged')
  })

  it('reports no file before the first start', async () => {
    expect(await keyIsPrivate(path.join(dir, 'host.key'))).toBeNull()
  })
})
