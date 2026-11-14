// Chromium browsers' cookies on macOS: a copy of the profile's `Cookies` database, whose values
// are AES-128-CBC under a key derived from the browser's Safe Storage password in the keychain.
// Hosts and times are plain, so listing the sites needs no key.

import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { SignInProfile } from '@shared/signins'
import type { BroughtCookie, CookieMeta, CookieSameSite } from './sites'

// Seconds between 1601-01-01, where Chromium's times start, and the Unix epoch.
const WINDOWS_EPOCH_OFFSET = 11_644_473_600
// From version 24 a value starts with the SHA-256 of its cookie's host.
const HOST_DIGEST_VERSION = 24
const HOST_DIGEST_BYTES = 32
const IV = Buffer.alloc(16, 0x20)

/** The AES key Chromium on macOS derives from its Safe Storage password. */
export function chromiumKey(password: string): Buffer {
  return pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
}

/**
 * A cookie's value: the plain one when the database kept it so, else `encrypted` decrypted, with
 * the host's digest taken off for a database of version 24 or later. Null when it is in a form
 * this key cannot open, such as another platform's.
 */
export function decryptChromiumValue(
  encrypted: Uint8Array,
  plain: string,
  host: string,
  key: Buffer,
  version: number,
): string | null {
  if (encrypted.length === 0) return plain
  const bytes = Buffer.from(encrypted)
  if (bytes.subarray(0, 3).toString('latin1') !== 'v10') return null
  let opened: Buffer
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, IV)
    opened = Buffer.concat([decipher.update(bytes.subarray(3)), decipher.final()])
  } catch {
    return null
  }
  if (version >= HOST_DIGEST_VERSION) {
    if (opened.length < HOST_DIGEST_BYTES) return null
    const digest = createHash('sha256').update(host).digest()
    // A digest of another host means the database was edited: the value is not this cookie's.
    if (!opened.subarray(0, HOST_DIGEST_BYTES).equals(digest)) return null
    opened = opened.subarray(HOST_DIGEST_BYTES)
  }
  const value = opened.toString('utf8')
  // Chromium refuses control characters in a value, so one here means the key was wrong.
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value) ? null : value
}

const SAME_SITE: Record<number, CookieSameSite> = {
  [-1]: 'unspecified',
  0: 'no_restriction',
  1: 'lax',
  2: 'strict',
}

interface Row {
  host_key: string
  name: string
  value: string
  path: string
  expires: number
  persistent: number
  is_secure: number
  is_httponly: number
  samesite: number
  used: number
  partitioned: number
}

interface EncryptedRow extends Row {
  encrypted_value: Uint8Array
}

/** The database's version, from its `meta` table. */
export function chromiumVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
    { value: string | number } | undefined
  const version = Number(row?.value)
  return Number.isInteger(version) ? version : 0
}

function columns(db: DatabaseSync): Set<string> {
  const rows = db.prepare('PRAGMA table_info(cookies)').all() as { name: string }[]
  return new Set(rows.map((row) => row.name))
}

/**
 * The select for the cookies, its times as seconds since the epoch: Chromium counts microseconds
 * since 1601, which a JavaScript number cannot hold exactly. Columns an older database lacks read
 * as their default.
 */
function select(db: DatabaseSync, withValues: boolean): string {
  const has = columns(db)
  const persistent = has.has('is_persistent')
    ? 'is_persistent'
    : has.has('has_expires')
      ? 'has_expires'
      : '1'
  const used = has.has('last_access_utc')
    ? 'max(last_access_utc, creation_utc)'
    : has.has('creation_utc')
      ? 'creation_utc'
      : '0'
  // A partitioned cookie belongs to the site it was embedded in, which Kettu cannot set.
  const partitioned = has.has('top_frame_site_key') ? "top_frame_site_key != ''" : '0'
  return `SELECT host_key, name, ${withValues ? 'value, encrypted_value' : "'' AS value"}, path,
    expires_utc / 1000000 - ${WINDOWS_EPOCH_OFFSET} AS expires, ${persistent} AS persistent,
    is_secure, is_httponly, ${has.has('samesite') ? 'samesite' : '-1'} AS samesite,
    ${used} / 1000 - ${WINDOWS_EPOCH_OFFSET * 1000} AS used, ${partitioned} AS partitioned
    FROM cookies`
}

function meta(row: Row): CookieMeta {
  return {
    host: row.host_key,
    name: row.name,
    path: row.path || '/',
    secure: row.is_secure === 1,
    httpOnly: row.is_httponly === 1,
    expires: row.persistent === 1 ? row.expires : null,
    sameSite: SAME_SITE[row.samesite] ?? 'unspecified',
    lastUsed: Math.max(0, row.used),
  }
}

/** Every cookie's host, flags and times, without a value. */
export function chromiumCookieMeta(db: DatabaseSync): CookieMeta[] {
  const rows = db.prepare(select(db, false)).all() as unknown as Row[]
  return rows.filter((row) => row.partitioned !== 1).map(meta)
}

/**
 * The cookies `wanted` keeps, with their values decrypted. Those the key cannot open are left
 * out and counted.
 */
export function chromiumCookies(
  db: DatabaseSync,
  key: Buffer,
  wanted: (host: string) => boolean,
): { cookies: BroughtCookie[]; unreadable: number } {
  const version = chromiumVersion(db)
  const rows = db.prepare(select(db, true)).all() as unknown as EncryptedRow[]
  const cookies: BroughtCookie[] = []
  let unreadable = 0
  for (const row of rows) {
    if (row.partitioned === 1 || !wanted(row.host_key)) continue
    const value = decryptChromiumValue(row.encrypted_value, row.value, row.host_key, key, version)
    if (value === null) unreadable++
    else cookies.push({ ...meta(row), value })
  }
  return { cookies, unreadable }
}

/** Whether `wanted` keeps any cookie, so the key is asked for only when something is to read. */
export function chromiumHasCookies(db: DatabaseSync, wanted: (host: string) => boolean): boolean {
  const rows = db.prepare('SELECT DISTINCT host_key FROM cookies').all() as { host_key: string }[]
  return rows.some((row) => wanted(row.host_key))
}

/**
 * The profiles `Local State` lists: each one's folder, name and account, most recently used
 * first. Sites are counted later.
 */
export function chromiumProfiles(localState: unknown): Omit<SignInProfile, 'sites'>[] {
  const profile = record(record(localState)?.profile)
  const cache = record(profile?.info_cache)
  if (!cache) return []
  const order = Array.isArray(profile?.last_active_profiles)
    ? (profile.last_active_profiles as unknown[]).filter((id) => typeof id === 'string')
    : []
  const profiles: (Omit<SignInProfile, 'sites'> & { active: number })[] = []
  for (const [id, raw] of Object.entries(cache)) {
    const info = record(raw)
    if (!info || !isProfileFolder(id)) continue
    const name = typeof info.name === 'string' && info.name ? info.name : id
    const email = typeof info.user_name === 'string' && info.user_name ? info.user_name : null
    const active = typeof info.active_time === 'number' ? info.active_time : 0
    profiles.push({ id, name, email, active })
  }
  return profiles
    .sort((a, b) => {
      const ai = order.indexOf(a.id)
      const bi = order.indexOf(b.id)
      if (ai !== bi) return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi)
      return b.active - a.active || a.id.localeCompare(b.id)
    })
    .map(({ id, name, email }) => ({ id, name, email }))
}

/** A profile's folder name, never a path: what `Local State` and the window may name. */
export function isProfileFolder(id: string): boolean {
  return id.length > 0 && id.length <= 200 && id !== '.' && id !== '..' && !/[/\\\0]/.test(id)
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
