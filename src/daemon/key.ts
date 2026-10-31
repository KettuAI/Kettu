// The data folder and the host's private key. A service that starts with the computer cannot count
// on an unlocked keychain, and servers often have none, so the key is a file only the user can
// read: 0600 in a 0700 folder.

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { keyPath } from './paths'

const KEY_BYTES = 32
const PRIVATE_FOLDER = 0o700
const PRIVATE_FILE = 0o600

/** Creates the data folder, or narrows an existing one, so only the user can open it. */
export async function prepareDataFolder(data: string): Promise<void> {
  await mkdir(data, { recursive: true, mode: PRIVATE_FOLDER })
  const { mode } = await stat(data)
  if ((mode & 0o777) !== PRIVATE_FOLDER) await chmod(data, PRIVATE_FOLDER)
}

export interface HostKey {
  /** The 32 raw bytes of the host's X25519 private key. */
  privateKey: Uint8Array
  path: string
}

/** The host's private key, made on first start and kept in the data folder from then on. */
export async function loadHostKey(data: string, warn: (message: string) => void): Promise<HostKey> {
  const file = keyPath(data)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const privateKey = randomBytes(KEY_BYTES)
    await writePrivate(file, `${privateKey.toString('base64')}\n`)
    return { privateKey: new Uint8Array(privateKey), path: file }
  }
  const privateKey = Buffer.from(text.trim(), 'base64')
  if (privateKey.length !== KEY_BYTES || privateKey.toString('base64') !== text.trim()) {
    throw new Error(`The host's private key in ${file} is damaged`)
  }
  const { mode } = await stat(file)
  if ((mode & 0o077) !== 0) {
    await chmod(file, PRIVATE_FILE)
    warn(`Others could read ${file}; it is readable only by you again`)
  }
  return { privateKey: new Uint8Array(privateKey), path: file }
}

/** Whether only the user can read the key file, for `kettu status`; null when it is missing. */
export async function keyIsPrivate(file: string): Promise<boolean | null> {
  try {
    return ((await stat(file)).mode & 0o077) === 0
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

// Written beside the key and renamed over it, so a crash never leaves half a key behind.
async function writePrivate(file: string, text: string): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`
  const handle = await open(temp, 'wx', PRIVATE_FILE)
  try {
    await handle.writeFile(text)
    await handle.sync()
  } catch (error) {
    await handle.close()
    await rm(temp, { force: true })
    throw error
  }
  await handle.close()
  await rename(temp, file)
}
