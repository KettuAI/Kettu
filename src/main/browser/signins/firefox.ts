// Firefox's cookies, on every platform: profiles from `profiles.ini`, and a copy of a profile's
// `cookies.sqlite`, whose values are plain.

import { isAbsolute, join, normalize, relative } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { BroughtCookie, CookieMeta, CookieSameSite } from './sites'

/** A profile `profiles.ini` lists: its folder as the file names it, and where that is. */
export interface FirefoxProfile {
  id: string
  name: string
  dir: string
  default: boolean
}

/**
 * The profiles in `profiles.ini` under `root`, the install's default first. A relative path that
 * would leave `root` is dropped.
 */
export function firefoxProfiles(ini: string, root: string): FirefoxProfile[] {
  const sections = parseIni(ini)
  const installDefaults = new Set<string>()
  for (const [name, values] of sections) {
    if (name.startsWith('Install') && values.Default) installDefaults.add(values.Default)
  }
  const profiles: FirefoxProfile[] = []
  for (const [section, values] of sections) {
    if (!/^Profile\d+$/.test(section) || !values.Path) continue
    const id = values.Path
    const isRelative = values.IsRelative !== '0'
    let dir: string
    if (isRelative) {
      dir = join(root, id)
      const inside = relative(root, dir)
      if (!inside || inside.startsWith('..') || isAbsolute(inside)) continue
    } else {
      if (!isAbsolute(id)) continue
      dir = normalize(id)
    }
    profiles.push({
      id,
      name: values.Name || id,
      dir,
      default: installDefaults.has(id) || values.Default === '1',
    })
  }
  return profiles.sort((a, b) => Number(b.default) - Number(a.default))
}

function parseIni(text: string): Map<string, Record<string, string>> {
  const sections = new Map<string, Record<string, string>>()
  let current: Record<string, string> | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    const header = /^\[(.+)\]$/.exec(line)
    if (header) {
      current = {}
      sections.set(header[1]!, current)
      continue
    }
    const eq = line.indexOf('=')
    if (current && eq > 0) current[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return sections
}

interface Row {
  host: string
  name: string
  value: string
  path: string
  expiry: number
  isSecure: number
  isHttpOnly: number
  sameSite: number
  lastAccessed: number
}

// Firefox 0 means None or no attribute at all; Chromium's unspecified, treated as Lax, is the safe
// reading of both.
const SAME_SITE: Record<number, CookieSameSite> = { 1: 'lax', 2: 'strict' }

// Expiry is seconds in older profiles and milliseconds in newer ones; seconds stay under this
// until the year 5138.
const SECONDS_LIMIT = 100_000_000_000

function meta(row: Row): CookieMeta {
  const expiry = row.expiry > SECONDS_LIMIT ? Math.floor(row.expiry / 1000) : row.expiry
  return {
    host: row.host,
    name: row.name,
    path: row.path || '/',
    secure: row.isSecure === 1,
    httpOnly: row.isHttpOnly === 1,
    // Firefox keeps no session cookies in this file.
    expires: expiry,
    sameSite: SAME_SITE[row.sameSite] ?? 'unspecified',
    lastUsed: Math.floor(row.lastAccessed / 1000),
  }
}

// Cookies of a container or a partition belong to that context alone, which Kettu has none of.
const SELECT = `SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite, lastAccessed
  FROM moz_cookies WHERE originAttributes = ''`

export function firefoxCookieMeta(db: DatabaseSync): CookieMeta[] {
  return (db.prepare(SELECT).all() as unknown as Row[]).map(meta)
}

/** The cookies `wanted` keeps, with their values. */
export function firefoxCookies(
  db: DatabaseSync,
  wanted: (host: string) => boolean,
): BroughtCookie[] {
  return (db.prepare(SELECT).all() as unknown as Row[])
    .filter((row) => wanted(row.host))
    .map((row) => ({ ...meta(row), value: row.value }))
}
