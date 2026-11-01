// `remote/account.json`: the Kettu account a client signed in to and its refresh token, beside the
// host's private key and kept the same way: encrypted by the system where it can, and in a file
// only the user can read either way. The access token is never written down.

import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { IdentityCipher } from '../remote-identity'
import { quarantineFile, readJsonFile, writeFileAtomic } from '../json-file'

const VERSION = 1
const FILE_MODE = 0o600
const MAX_STORED_CHARS = 8192

export interface StoredProfile {
  id: string
  email: string
  name: string | null
  avatarUrl: string | null
}

export interface StoredAccount {
  profile: StoredProfile
  subscription: string
  /** The refresh token as kept: the system's encryption of it in base64, or itself. */
  token: string
  encrypted: boolean
  /** Kept without the system's encryption, as on Linux without a keyring. */
  plainText: boolean
}

export function accountFile(dataPath: string): string {
  return join(dataPath, 'remote', 'account.json')
}

const isText = (value: unknown, max = 1024): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max

const isNullableText = (value: unknown): value is string | null =>
  value === null || isText(value, 2048)

function parse(raw: unknown): StoredAccount | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const { version, profile, subscription, token, encrypted, plainText } = raw as Record<
    string,
    unknown
  >
  if (version !== VERSION || typeof encrypted !== 'boolean' || typeof plainText !== 'boolean') {
    return null
  }
  if (!isText(token, MAX_STORED_CHARS) || !isText(subscription, 64)) return null
  if (typeof profile !== 'object' || profile === null) return null
  const { id, email, name, avatarUrl } = profile as Record<string, unknown>
  if (!isText(id) || !isText(email) || !isNullableText(name) || !isNullableText(avatarUrl)) {
    return null
  }
  return {
    profile: { id, email, name, avatarUrl },
    subscription,
    token,
    encrypted,
    plainText,
  }
}

/** The stored account, or null when none is; a file that is not one is moved aside. */
export async function readAccount(
  path: string,
  warn: (message: string) => void,
): Promise<StoredAccount | null> {
  const read = await readJsonFile(path)
  if (read.kind === 'missing') return null
  if (read.kind === 'ok') {
    const version = (read.value as { version?: unknown } | null)?.version
    if (typeof version === 'number' && version > VERSION) {
      warn(`${path} is from a newer version of Kettu; signed out until signing in again`)
      return null
    }
  }
  const stored = read.kind === 'ok' ? parse(read.value) : null
  if (stored) return stored
  warn(`${path} is invalid${read.kind === 'unreadable' ? `: ${read.reason}` : ''}; signed out`)
  warn(`Moved the invalid file to ${await quarantineFile(path)}`)
  return null
}

/** The refresh token kept as the system can keep it. */
export async function sealToken(
  token: string,
  cipher: IdentityCipher,
): Promise<Pick<StoredAccount, 'token' | 'encrypted' | 'plainText'>> {
  const encrypted = await cipher.available()
  return {
    token: encrypted ? (await cipher.encrypt(token)).toString('base64') : token,
    encrypted,
    plainText: !encrypted || cipher.plainText(),
  }
}

export async function openToken(stored: StoredAccount, cipher: IdentityCipher): Promise<string> {
  if (!stored.encrypted) return stored.token
  const { result } = await cipher.decrypt(Buffer.from(stored.token, 'base64'))
  return result
}

export async function writeAccount(path: string, stored: StoredAccount): Promise<void> {
  const file = { version: VERSION, ...stored }
  await writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`, FILE_MODE)
}

export async function removeAccount(path: string): Promise<void> {
  await rm(path, { force: true })
}
