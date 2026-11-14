// What the sign-ins worker does: finds the browsers and profiles on this computer, lists a
// profile's sites, and reads the cookies of the chosen sites. Every database is copied first, so
// the browser's own files are never opened or changed.

import { access, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  SignInBrowserId,
  SignInChoice,
  SignInProfile,
  SignInRequest,
  SignInSite,
  SignInUnavailable,
} from '@shared/signins'
import {
  chromiumCookieMeta,
  chromiumCookies,
  chromiumHasCookies,
  chromiumKey,
  chromiumProfiles,
  isProfileFolder,
} from './chromium'
import { firefoxCookieMeta, firefoxCookies, firefoxProfiles } from './firefox'
import type { KeySource } from './keychain'
import { bringable, inSites, signInSites, type BroughtCookie } from './sites'

/** Where the browsers keep their data, as main passes it in. */
export interface ReaderEnv {
  platform: NodeJS.Platform
  home: string
  localAppData: string | null
  appData: string | null
  configHome: string | null
  programFiles: string[]
  tmp: string
}

interface BrowserDef {
  browser: SignInBrowserId
  name: string
  kind: 'chromium' | 'firefox' | 'safari'
  /** Where its data may be, the first that exists used. */
  roots: string[]
  /** Where the app may be, for its icon. */
  apps: string[]
  keychain: string | null
  unavailable: SignInUnavailable | null
}

/** A source as the worker finds it; main adds the icon from `app`. */
export interface SourceListing {
  browser: SignInBrowserId
  name: string
  app: string | null
  profiles: SignInProfile[]
  unavailable: SignInUnavailable | null
  keychain: boolean
}

/** The sites of a profile one of the user's browsers has sign-ins for, for offering them. */
export interface IndexEntry {
  site: string
  browser: SignInBrowserId
  browserName: string
  profile: string
  profileName: string
  lastUsed: number
  keychain: boolean
}

export type ReadResult =
  { ok: true; cookies: BroughtCookie[] } | { ok: false; reason: 'denied' | 'unreadable' }

export function browserDefs(env: ReaderEnv): BrowserDef[] {
  const { home, platform } = env
  if (platform === 'darwin') {
    const support = join(home, 'Library', 'Application Support')
    const apps = (name: string) => [join('/Applications', name), join(home, 'Applications', name)]
    const chromium = (
      browser: SignInBrowserId,
      name: string,
      root: string[],
      app: string,
      keychain: string,
    ): BrowserDef => ({
      browser,
      name,
      kind: 'chromium',
      roots: [join(support, ...root)],
      apps: apps(app),
      keychain: `${keychain} Safe Storage`,
      unavailable: null,
    })
    const defs: BrowserDef[] = [
      chromium('chrome', 'Google Chrome', ['Google', 'Chrome'], 'Google Chrome.app', 'Chrome'),
      chromium('arc', 'Arc', ['Arc', 'User Data'], 'Arc.app', 'Arc'),
      chromium(
        'edge',
        'Microsoft Edge',
        ['Microsoft Edge'],
        'Microsoft Edge.app',
        'Microsoft Edge',
      ),
      chromium('brave', 'Brave', ['BraveSoftware', 'Brave-Browser'], 'Brave Browser.app', 'Brave'),
      {
        browser: 'firefox',
        name: 'Firefox',
        kind: 'firefox',
        roots: [join(support, 'Firefox')],
        apps: apps('Firefox.app'),
        keychain: null,
        unavailable: null,
      },
      {
        browser: 'safari',
        name: 'Safari',
        kind: 'safari',
        roots: [],
        apps: ['/Applications/Safari.app'],
        keychain: null,
        unavailable: 'safari',
      },
    ]
    return defs
  }
  if (platform === 'win32') {
    const local = env.localAppData ?? join(home, 'AppData', 'Local')
    const roaming = env.appData ?? join(home, 'AppData', 'Roaming')
    const programs = (...path: string[]) => [
      ...env.programFiles.map((dir) => join(dir, ...path)),
      join(local, ...path),
    ]
    return [
      {
        browser: 'chrome',
        name: 'Google Chrome',
        kind: 'chromium',
        roots: [join(local, 'Google', 'Chrome', 'User Data')],
        apps: programs('Google', 'Chrome', 'Application', 'chrome.exe'),
        keychain: null,
        unavailable: 'windows-locked',
      },
      {
        browser: 'edge',
        name: 'Microsoft Edge',
        kind: 'chromium',
        roots: [join(local, 'Microsoft', 'Edge', 'User Data')],
        apps: programs('Microsoft', 'Edge', 'Application', 'msedge.exe'),
        keychain: null,
        unavailable: 'windows-locked',
      },
      {
        browser: 'firefox',
        name: 'Firefox',
        kind: 'firefox',
        roots: [join(roaming, 'Mozilla', 'Firefox')],
        apps: programs('Mozilla Firefox', 'firefox.exe'),
        keychain: null,
        unavailable: null,
      },
    ]
  }
  const config = env.configHome ?? join(home, '.config')
  return [
    {
      browser: 'chrome',
      name: 'Google Chrome',
      kind: 'chromium',
      roots: [join(config, 'google-chrome')],
      apps: [],
      keychain: null,
      unavailable: 'linux-keyring',
    },
    {
      browser: 'edge',
      name: 'Microsoft Edge',
      kind: 'chromium',
      roots: [join(config, 'microsoft-edge')],
      apps: [],
      keychain: null,
      unavailable: 'linux-keyring',
    },
    {
      browser: 'firefox',
      name: 'Firefox',
      kind: 'firefox',
      roots: [
        join(home, '.mozilla', 'firefox'),
        join(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox'),
        join(home, '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox'),
        join(config, 'mozilla', 'firefox'),
      ],
      apps: [],
      keychain: null,
      unavailable: null,
    },
  ]
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function firstExisting(paths: readonly string[]): Promise<string | null> {
  for (const path of paths) if (await exists(path)) return path
  return null
}

/** A profile's folder and its cookie database. */
interface ProfilePlace {
  id: string
  name: string
  email: string | null
  db: string
}

async function chromiumPlaces(root: string): Promise<ProfilePlace[]> {
  let localState: unknown
  try {
    localState = JSON.parse(await readFile(join(root, 'Local State'), 'utf8'))
  } catch {
    return []
  }
  const places: ProfilePlace[] = []
  for (const profile of chromiumProfiles(localState)) {
    // Newer builds keep it under Network on some platforms.
    const db = await firstExisting([
      join(root, profile.id, 'Network', 'Cookies'),
      join(root, profile.id, 'Cookies'),
    ])
    if (db) places.push({ ...profile, db })
  }
  return places
}

async function firefoxPlaces(root: string): Promise<ProfilePlace[]> {
  let ini: string
  try {
    ini = await readFile(join(root, 'profiles.ini'), 'utf8')
  } catch {
    return []
  }
  const places: ProfilePlace[] = []
  for (const profile of firefoxProfiles(ini, root)) {
    const db = join(profile.dir, 'cookies.sqlite')
    if (await exists(db)) places.push({ id: profile.id, name: profile.name, email: null, db })
  }
  return places
}

/** The root of a browser's data that exists here, if any. */
async function rootOf(def: BrowserDef): Promise<string | null> {
  const marker = def.kind === 'firefox' ? 'profiles.ini' : 'Local State'
  for (const root of def.roots) {
    if (await exists(def.unavailable ? root : join(root, marker))) return root
  }
  return null
}

async function places(def: BrowserDef, root: string): Promise<ProfilePlace[]> {
  return def.kind === 'firefox' ? firefoxPlaces(root) : chromiumPlaces(root)
}

/**
 * Opens a copy of a database, with its journal, in a folder of its own that only this user can
 * read and that is removed afterwards.
 */
export async function withCopy<T>(
  db: string,
  tmp: string,
  use: (copy: DatabaseSync) => T | Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmp, 'kettu-signins-'))
  try {
    const copy = join(dir, 'cookies.db')
    await copyFile(db, copy)
    for (const suffix of ['-wal', '-journal']) {
      await copyFile(db + suffix, copy + suffix).catch(() => {})
    }
    const opened = new DatabaseSync(copy)
    try {
      return await use(opened)
    } finally {
      opened.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function metaOf(def: BrowserDef, db: DatabaseSync) {
  return def.kind === 'firefox' ? firefoxCookieMeta(db) : chromiumCookieMeta(db)
}

/** Every browser found here, with its profiles and their sites counted. */
export async function listSources(env: ReaderEnv, now: number): Promise<SourceListing[]> {
  const sources: SourceListing[] = []
  for (const def of browserDefs(env)) {
    const app = await firstExisting(def.apps)
    if (def.kind === 'safari') {
      if (app) sources.push(listing(def, app, []))
      continue
    }
    const root = await rootOf(def)
    if (!root) continue
    if (def.unavailable) {
      sources.push(listing(def, app, []))
      continue
    }
    const profiles: SignInProfile[] = []
    for (const place of await places(def, root)) {
      const sites = await withCopy(place.db, env.tmp, (db) =>
        signInSites(metaOf(def, db), now),
      ).catch(() => null)
      if (sites) {
        profiles.push({ id: place.id, name: place.name, email: place.email, sites: sites.length })
      }
    }
    if (profiles.length > 0) sources.push(listing(def, app, profiles))
  }
  return sources
}

function listing(def: BrowserDef, app: string | null, profiles: SignInProfile[]): SourceListing {
  return {
    browser: def.browser,
    name: def.name,
    app,
    profiles,
    unavailable: def.unavailable,
    keychain: def.keychain !== null,
  }
}

/** A browser and one of its profiles, only as this computer has them. */
async function find(
  env: ReaderEnv,
  choice: SignInChoice,
): Promise<{ def: BrowserDef; place: ProfilePlace } | null> {
  const def = browserDefs(env).find((d) => d.browser === choice.browser)
  if (!def || def.unavailable || def.kind === 'safari') return null
  if (def.kind === 'chromium' && !isProfileFolder(choice.profile)) return null
  const root = await rootOf(def)
  if (!root) return null
  const place = (await places(def, root)).find((p) => p.id === choice.profile)
  return place ? { def, place } : null
}

/** A profile's sites with sign-ins; null when the profile is not one this computer has. */
export async function listSites(
  env: ReaderEnv,
  choice: SignInChoice,
  now: number,
): Promise<SignInSite[] | null> {
  const found = await find(env, choice)
  if (!found) return null
  return withCopy(found.place.db, env.tmp, (db) => signInSites(metaOf(found.def, db), now))
}

/** Every site with a sign-in in the browsers that can bring them, for offering one at a time. */
export async function siteIndex(env: ReaderEnv, now: number): Promise<IndexEntry[]> {
  const entries: IndexEntry[] = []
  for (const def of browserDefs(env)) {
    if (def.unavailable || def.kind === 'safari') continue
    const root = await rootOf(def)
    if (!root) continue
    for (const place of await places(def, root)) {
      const sites = await withCopy(place.db, env.tmp, (db) =>
        signInSites(metaOf(def, db), now),
      ).catch(() => [])
      for (const site of sites) {
        if (site.group === 'google') continue
        entries.push({
          site: site.site,
          browser: def.browser,
          browserName: def.name,
          profile: place.id,
          profileName: place.name,
          lastUsed: site.lastUsed,
          keychain: def.keychain !== null,
        })
      }
    }
  }
  return entries
}

/**
 * The cookies of the chosen sites, never Google's. A Chromium profile's key is asked for only once
 * one of them has a cookie; `denied` when macOS did not hand it out.
 */
export async function readCookies(
  env: ReaderEnv,
  request: SignInRequest,
  keys: KeySource,
  signal: AbortSignal,
): Promise<ReadResult> {
  const found = await find(env, request)
  if (!found) return { ok: false, reason: 'unreadable' }
  const chosen = bringable(request.sites)
  const wanted = (host: string) => inSites(host, chosen)
  const { def, place } = found
  if (def.kind === 'firefox') {
    const cookies = await withCopy(place.db, env.tmp, (db) => firefoxCookies(db, wanted))
    return { ok: true, cookies }
  }
  const keychain = def.keychain
  if (!keychain) return { ok: false, reason: 'unreadable' }
  return withCopy(place.db, env.tmp, async (db): Promise<ReadResult> => {
    if (!chromiumHasCookies(db, wanted)) return { ok: true, cookies: [] }
    const answer = await keys(keychain, signal)
    if (!answer.ok) {
      return { ok: false, reason: answer.reason === 'denied' ? 'denied' : 'unreadable' }
    }
    const read = chromiumCookies(db, chromiumKey(answer.password), wanted)
    // Not one value opened: the key is not the one the browser used.
    if (read.cookies.length === 0 && read.unreadable > 0) return { ok: false, reason: 'unreadable' }
    return { ok: true, cookies: read.cookies }
  })
}
