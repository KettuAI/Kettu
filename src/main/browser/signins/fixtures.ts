// Test fixtures only: cookie databases laid out and encrypted as Chromium and Firefox write them,
// under a folder standing in for the home folder.

import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const DAY_MS = 24 * 60 * 60 * 1000
const WINDOWS_EPOCH_US = 11_644_473_600_000_000n

export interface FixtureCookie {
  host: string
  name: string
  value: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  /** Days from now; null for a session cookie. */
  expiresInDays?: number | null
  /** Days since it was last used. */
  usedDaysAgo?: number
  /** Chromium's numbers: -1 unspecified, 0 none, 1 lax, 2 strict; Firefox's 0, 1, 2. */
  sameSite?: number
  partitioned?: boolean
  /** Firefox only: a container's or partition's attributes. */
  originAttributes?: string
}

/** Encrypts a value as Chromium on macOS does, with the host's digest from version 24. */
export function encryptChromium(
  value: string,
  host: string,
  password: string,
  version = 24,
): Buffer {
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  const prefix = version >= 24 ? createHash('sha256').update(host).digest() : Buffer.alloc(0)
  const body = Buffer.concat([
    cipher.update(Buffer.concat([prefix, Buffer.from(value)])),
    cipher.final(),
  ])
  return Buffer.concat([Buffer.from('v10'), body])
}

function chromiumTime(ms: number): bigint {
  return BigInt(Math.round(ms)) * 1000n + WINDOWS_EPOCH_US
}

/** A Chromium `Cookies` database at `path`, its values encrypted with `password`. */
export function writeChromiumDb(
  path: string,
  cookies: FixtureCookie[],
  password: string,
  now: number,
  version = 24,
): void {
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
    CREATE TABLE cookies(creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL,
      top_frame_site_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL,
      encrypted_value BLOB NOT NULL, path TEXT NOT NULL, expires_utc INTEGER NOT NULL,
      is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL, last_access_utc INTEGER NOT NULL,
      has_expires INTEGER NOT NULL, is_persistent INTEGER NOT NULL, priority INTEGER NOT NULL,
      samesite INTEGER NOT NULL, source_scheme INTEGER NOT NULL, source_port INTEGER NOT NULL,
      last_update_utc INTEGER NOT NULL, source_type INTEGER NOT NULL,
      has_cross_site_ancestor INTEGER NOT NULL)`)
  db.prepare("INSERT INTO meta VALUES ('version', ?)").run(String(version))
  const insert = db.prepare(`INSERT INTO cookies VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, 1,
    ?, 2, 443, ?, 0, 0)`)
  for (const cookie of cookies) {
    const used = now - (cookie.usedDaysAgo ?? 0) * DAY_MS
    const expires = cookie.expiresInDays === undefined ? 30 : cookie.expiresInDays
    insert.run(
      chromiumTime(used - DAY_MS),
      cookie.host,
      cookie.partitioned ? 'https://embedder.example' : '',
      cookie.name,
      encryptChromium(cookie.value, cookie.host, password, version),
      cookie.path ?? '/',
      expires === null ? 0n : chromiumTime(now + expires * DAY_MS),
      cookie.secure === false ? 0 : 1,
      cookie.httpOnly === false ? 0 : 1,
      chromiumTime(used),
      expires === null ? 0 : 1,
      expires === null ? 0 : 1,
      cookie.sameSite ?? 1,
      chromiumTime(used),
    )
  }
  db.close()
}

/** A Chromium browser's data folder with `Local State` naming its profiles. */
export function writeChromiumRoot(
  root: string,
  profiles: { id: string; name: string; email?: string; cookies: FixtureCookie[] }[],
  password: string,
  now: number,
): void {
  const cache: Record<string, unknown> = {}
  for (const [i, profile] of profiles.entries()) {
    mkdirSync(join(root, profile.id), { recursive: true })
    writeChromiumDb(join(root, profile.id, 'Cookies'), profile.cookies, password, now)
    cache[profile.id] = {
      name: profile.name,
      user_name: profile.email ?? '',
      active_time: now / 1000 - i,
    }
  }
  writeFileSync(join(root, 'Local State'), JSON.stringify({ profile: { info_cache: cache } }))
}

/** A Firefox `cookies.sqlite` at `path`, with expiry in seconds or, as newer ones keep it, ms. */
export function writeFirefoxDb(
  path: string,
  cookies: FixtureCookie[],
  now: number,
  expiryInMs = false,
): void {
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL
    DEFAULT '', name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, lastAccessed INTEGER,
    creationTime INTEGER, isSecure INTEGER, isHttpOnly INTEGER, inBrowserElement INTEGER DEFAULT 0,
    sameSite INTEGER DEFAULT 0, rawSameSite INTEGER DEFAULT 0, schemeMap INTEGER DEFAULT 0,
    isPartitionedAttributeSet INTEGER DEFAULT 0,
    CONSTRAINT moz_uniqueid UNIQUE (name, host, path, originAttributes))`)
  const insert = db.prepare(`INSERT INTO moz_cookies (originAttributes, name, value, host, path,
    expiry, lastAccessed, creationTime, isSecure, isHttpOnly, sameSite, rawSameSite)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const cookie of cookies) {
    const used = now - (cookie.usedDaysAgo ?? 0) * DAY_MS
    const expiresMs = now + (cookie.expiresInDays ?? 30) * DAY_MS
    insert.run(
      cookie.originAttributes ?? '',
      cookie.name,
      cookie.value,
      cookie.host,
      cookie.path ?? '/',
      expiryInMs ? Math.round(expiresMs) : Math.round(expiresMs / 1000),
      Math.round(used * 1000),
      Math.round((used - DAY_MS) * 1000),
      cookie.secure === false ? 0 : 1,
      cookie.httpOnly === false ? 0 : 1,
      cookie.sameSite ?? 0,
      cookie.sameSite ?? 0,
    )
  }
  db.close()
}
