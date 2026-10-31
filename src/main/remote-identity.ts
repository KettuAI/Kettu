// `remote/identity.json`: the X25519 key pair devices know this computer by. Main makes it the
// first time remote access starts, keeps the private key encrypted by the system, and hands it to
// the remote host alone.

import { join } from 'node:path'
import { generateKeyPair } from '@shared/remote/noise'
import { quarantineFile, readJsonFile, writeFileAtomic } from './json-file'
import { createLogger } from './log'

const log = createLogger('remote-identity')

const VERSION = 1
const KEY_BYTES = 32
// Only the user may read the file, which is all that guards the key where the system cannot.
const FILE_MODE = 0o600
const MAX_STORED_CHARS = 4096

/** The asynchronous half of Electron's safeStorage, which only main has. */
export interface IdentityCipher {
  available(): Promise<boolean>
  encrypt(plainText: string): Promise<Buffer>
  decrypt(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
  /** Whether the system's encryption protects nothing, as on Linux without a keyring. */
  plainText(): boolean
}

export interface RemoteIdentity {
  /** The 32 bytes of the private key, in base64. */
  privateKey: string
  /** The key is kept in a file only the user can read, without the system's encryption. */
  plainText: boolean
}

interface IdentityFile {
  version: 1
  /** The system's encryption of the key's base64, in base64; the key's base64 when not `encrypted`. */
  privateKey: string
  encrypted: boolean
  plainText: boolean
}

function isKey(text: unknown): text is string {
  if (typeof text !== 'string') return false
  const bytes = Buffer.from(text, 'base64')
  return bytes.length === KEY_BYTES && bytes.toString('base64') === text
}

function parseFile(raw: unknown): IdentityFile | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const { version, privateKey, encrypted, plainText } = raw as Record<string, unknown>
  if (version !== VERSION || typeof encrypted !== 'boolean' || typeof plainText !== 'boolean') {
    return null
  }
  if (typeof privateKey !== 'string' || privateKey.length > MAX_STORED_CHARS) return null
  if (!encrypted && !isKey(privateKey)) return null
  return { version, privateKey, encrypted, plainText }
}

async function newKey(): Promise<string> {
  const pair = await generateKeyPair(true)
  // PKCS #8 ends with the 32 raw bytes of the key.
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  return Buffer.from(pkcs8.subarray(pkcs8.length - KEY_BYTES)).toString('base64')
}

async function keep(
  path: string,
  privateKey: string,
  cipher: IdentityCipher,
): Promise<RemoteIdentity> {
  const encrypted = await cipher.available()
  const plainText = !encrypted || cipher.plainText()
  const stored = encrypted ? (await cipher.encrypt(privateKey)).toString('base64') : privateKey
  const file: IdentityFile = { version: VERSION, privateKey: stored, encrypted, plainText }
  await writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`, FILE_MODE)
  return { privateKey, plainText }
}

/**
 * The identity, made and kept on first use. A key the system cannot decrypt, as in a data folder
 * copied from another computer, is an error rather than the start of a new identity, which would
 * leave every paired device out.
 */
export async function loadIdentity(
  userDataPath: string,
  cipher: IdentityCipher,
): Promise<RemoteIdentity> {
  const path = join(userDataPath, 'remote', 'identity.json')
  const read = await readJsonFile(path)
  if (read.kind === 'missing') return keep(path, await newKey(), cipher)
  if (read.kind === 'ok') {
    const version = (read.value as { version?: unknown } | null)?.version
    if (typeof version === 'number' && version > VERSION) {
      throw new Error('remote/identity.json is from a newer version of Kettu')
    }
  }
  const file = read.kind === 'ok' ? parseFile(read.value) : null
  if (!file) {
    const reason = read.kind === 'unreadable' ? `: ${read.reason}` : ''
    log.warn(`remote/identity.json is invalid${reason}; devices have to pair again`)
    log.warn(`Moved the invalid file to ${await quarantineFile(path)}`)
    return keep(path, await newKey(), cipher)
  }
  if (!file.encrypted) return { privateKey: file.privateKey, plainText: true }
  const { result, shouldReEncrypt } = await cipher.decrypt(Buffer.from(file.privateKey, 'base64'))
  if (!isKey(result)) throw new Error('remote/identity.json does not decrypt to a key')
  if (shouldReEncrypt) return keep(path, result, cipher)
  return { privateKey: result, plainText: file.plainText }
}

/** Replaces the identity with a new key, as resetting remote access does. */
export async function newIdentity(
  userDataPath: string,
  cipher: IdentityCipher,
): Promise<RemoteIdentity> {
  return keep(join(userDataPath, 'remote', 'identity.json'), await newKey(), cipher)
}
