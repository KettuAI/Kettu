// Pure parts of the updater: which mode a build uses, whether it can update, when a download
// installs on quit, and how events from electron-updater move the state every surface reads.

import type { Locale } from '@shared/locale'
import type { Platform } from '@shared/platform'
import type { SettingsFile } from '@shared/settings'
import { RELEASES_URL, type UpdateState, type UpdateStatus } from '@shared/updates'

export type UpdateMode = 'install' | 'link'

/** Who started a download: the updater, as the choice says, or the user with Update. */
export type StartedBy = 'auto' | 'user'

/** Whether a downloaded update installs when the app quits without a restart for it. */
export function installOnQuit({
  choice,
  startedBy,
}: {
  choice: SettingsFile['updates']['automatic']
  startedBy: StartedBy
}): boolean {
  return !(choice === 'restart' && startedBy === 'auto')
}

/**
 * Link mode's download: the release's .dmg for this Mac, picked by the architecture in its name,
 * or null when the update lists none.
 */
export function dmgDownloadUrl(
  version: string,
  files: readonly { url: string }[],
  arch: string,
): string | null {
  if (arch !== 'arm64' && arch !== 'x64') return null
  const name = files
    .map((file) => file.url.slice(file.url.lastIndexOf('/') + 1))
    .find((file) => file.endsWith(`-${arch}.dmg`))
  return name ? `${RELEASES_URL}/download/v${version}/${encodeURIComponent(name)}` : null
}

/**
 * Install replaces the app; Link only opens the release page. The release workflow sets
 * MAIN_VITE_UPDATE_MODE; without it, macOS builds link because unsigned builds cannot install.
 */
export function updateMode(platform: Platform, configured: string | undefined): UpdateMode {
  if (configured === 'install' || configured === 'link') return configured
  return platform === 'darwin' ? 'link' : 'install'
}

/**
 * Whether the app is not writable because its volume is mounted read-only, as the mounted disk
 * image and a copy Gatekeeper translocated are; Squirrel.Mac installs nothing there.
 */
export function readOnlyVolume(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EROFS'
}

/** Electron 44 throws this when the user cancels the password prompt of a move to /Applications. */
export function moveCancelled(error: unknown): boolean {
  return error instanceof Error && error.message === 'User rejected the authorization request'
}

/** Why this build cannot update itself, or null when it can. */
export function offReason(
  isPackaged: boolean,
  platform: Platform,
  env: Record<string, string | undefined>,
): Extract<UpdateState, { kind: 'off' }> | null {
  if (!isPackaged) return { kind: 'off', reason: 'development' }
  // Outside an AppImage the package manager owns the installation.
  if (platform === 'linux' && !env.APPIMAGE) return { kind: 'off', reason: 'unsupported' }
  return null
}

function parseVersion(version: string): { core: number[]; pre: string[] } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version)
  if (!match) return null
  return { core: match.slice(1, 4).map(Number), pre: match[4] ? match[4].split('.') : [] }
}

/** Semver precedence: negative when `a` is older than `b`; NaN when either is not a version. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return Number.NaN
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] - right.core[i]
  }
  if (left.pre.length === 0 || right.pre.length === 0) return right.pre.length - left.pre.length
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i]
    const y = right.pre[i]
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y)
    if (numeric && Number(x) !== Number(y)) return Number(x) - Number(y)
    if (!numeric && x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** The version this launch updated from, when the last run was an older version. */
export function updatedFrom(lastRunVersion: string | null, current: string): string | null {
  if (!lastRunVersion) return null
  return compareVersions(lastRunVersion, current) < 0 ? lastRunVersion : null
}

/** The version a dismissal hides: the notice on screen, or the "Updated to" one. */
export function dismissTarget(status: UpdateStatus): string | null {
  const { state } = status
  if (state.kind === 'ready' || state.kind === 'available') return state.version
  return status.updatedFrom ? status.current : null
}

export type UpdaterEvent =
  | { type: 'checking'; manual: boolean }
  | { type: 'available'; version: string }
  | { type: 'not-available'; at: number }
  | { type: 'download-started'; version: string; manual: boolean }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string; notes?: Partial<Record<Locale, string[]>> }
  | { type: 'download-cancelled' }
  | { type: 'moving'; version: string }
  | { type: 'move-cancelled' }
  | { type: 'move-failed'; message: string }
  | { type: 'error'; message: string; manual: boolean }
  | { type: 'load-failed'; message: string; manual: boolean }

export interface TransitionContext {
  mode: UpdateMode
  autoDownload: boolean // electron-updater starts the download itself after a check
  lastCheckedAt: number | null
  /** The version found last, to fall back to after a failed automatic download. */
  lastAvailable: string | null
  /** In Link mode, the .dmg to open for `lastAvailable`. */
  downloadUrl: string | null
}

function available(version: string, context: TransitionContext): UpdateState {
  const downloadUrl = context.mode === 'link' ? context.downloadUrl : null
  return { kind: 'available', version, mode: context.mode, downloadUrl }
}

export function nextState(
  state: UpdateState,
  event: UpdaterEvent,
  context: TransitionContext,
): UpdateState {
  if (state.kind === 'off') return state
  switch (event.type) {
    case 'checking':
      // Keep an available update visible while a background check runs.
      if (!event.manual && state.kind === 'available') return state
      return { kind: 'checking', manual: event.manual }
    case 'available':
      if (context.mode === 'install' && context.autoDownload) {
        return { kind: 'downloading', version: event.version, percent: 0, manual: false }
      }
      return available(event.version, context)
    case 'not-available':
      return { kind: 'idle', checkedAt: event.at }
    case 'download-started':
      return { kind: 'downloading', version: event.version, percent: 0, manual: event.manual }
    case 'progress':
      if (state.kind !== 'downloading' || !Number.isFinite(event.percent)) return state
      return { ...state, percent: Math.max(0, Math.min(100, Math.floor(event.percent))) }
    case 'downloaded':
      return event.notes && Object.keys(event.notes).length > 0
        ? { kind: 'ready', version: event.version, notes: event.notes }
        : { kind: 'ready', version: event.version }
    case 'download-cancelled':
      return state.kind === 'downloading' ? available(state.version, context) : state
    case 'moving':
      return { kind: 'moving', version: event.version }
    case 'move-cancelled':
      return state.kind === 'moving' ? available(state.version, context) : state
    case 'move-failed':
      // Only Update moves the app, so its failure is always the user's to see.
      return { kind: 'error', message: event.message, manual: true, move: true }
    case 'error':
      if (event.manual) return { kind: 'error', message: event.message, manual: true }
      // A failure after the download was ready, as Squirrel.Mac's check of it, leaves nothing to
      // install, so Restart goes; the next check tries again.
      if (state.kind === 'ready') return { kind: 'error', message: event.message, manual: false }
      // Automatic failures are only logged and retried at the next check, so the state falls
      // back to what was known before.
      if (state.kind === 'downloading') return available(state.version, context)
      if (state.kind !== 'checking') return state
      return context.lastAvailable
        ? available(context.lastAvailable, context)
        : { kind: 'idle', checkedAt: context.lastCheckedAt }
    case 'load-failed':
      // Without electron-updater no check can run, so even an automatic one shows it.
      return { kind: 'error', message: event.message, manual: event.manual }
  }
}

/** The most highlights the update dialog lists, and the longest one before it is cut. */
const MAX_HIGHLIGHTS = 5
const MAX_HIGHLIGHT = 120

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity: string, name: string) => {
      if (!name.startsWith('#')) return ENTITIES[name.toLowerCase()] ?? entity
      const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : Number(name.slice(1))
      return code <= 0x10ffff ? String.fromCodePoint(code) : entity
    })
}

/** A bullet as the dialog shows it: plain text, its first sentence, without issue links. */
function highlight(item: string, chinese: boolean): string {
  const text = plainText(item)
    .replace(/`/g, '')
    .replace(/\s*\((?:#\d+(?:,\s*)?)+\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const end = chinese ? text.indexOf('。') + 1 : text.search(/[.!?](?:\s|$)/) + 1
  // A highlight is a list item, so it drops its full stop.
  const sentence = (end > 0 ? text.slice(0, end) : text).replace(/[.。]$/, '')
  return sentence.length > MAX_HIGHLIGHT ? `${sentence.slice(0, MAX_HIGHLIGHT - 1)}…` : sentence
}

/**
 * The release's highlights in each language, from the notes electron-updater read for it: the
 * bullets under "What changed" in English, and under "中文" in Chinese. The notes come as the
 * release page's HTML, or as Markdown; anything else gives none.
 */
export function releaseHighlights(notes: unknown): Partial<Record<Locale, string[]>> {
  const text =
    typeof notes === 'string'
      ? notes
      : Array.isArray(notes)
        ? notes.map((n) => (typeof n?.note === 'string' ? n.note : '')).join('\n')
        : ''
  const out: Partial<Record<Locale, string[]>> = {}
  let section: Locale | null = null
  const token =
    /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>|<li[^>]*>([\s\S]*?)<\/li>|^#{1,6}\s+(.+)$|^\s*[-*]\s+(.+)$/gim
  for (const match of text.matchAll(token)) {
    const heading = match[1] ?? match[3]
    if (heading !== undefined) {
      const title = plainText(heading).trim()
      section = /^what changed$/i.test(title) ? 'en' : title === '中文' ? 'zh-CN' : null
      continue
    }
    const item = match[2] ?? match[4]
    if (!section || item === undefined) continue
    const list = (out[section] ??= [])
    if (list.length < MAX_HIGHLIGHTS) {
      const line = highlight(item, section === 'zh-CN')
      if (line) list.push(line)
    }
  }
  return out
}

/** First line of an updater error, short enough for Settings › About. */
export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const line = text.split('\n')[0].trim() || 'Unknown error'
  return line.length > 300 ? `${line.slice(0, 299)}…` : line
}
