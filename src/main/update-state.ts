// Pure parts of the updater: which mode a build uses, whether it can update, and how events
// from electron-updater move the state every surface reads.

import type { Platform } from '@shared/platform'
import type { UpdateState, UpdateStatus } from '@shared/updates'

export type UpdateMode = 'install' | 'link'

/**
 * Install replaces the app; Link only opens the release page. The release workflow sets
 * MAIN_VITE_UPDATE_MODE; without it, macOS builds link because unsigned builds cannot install.
 */
export function updateMode(platform: Platform, configured: string | undefined): UpdateMode {
  if (configured === 'install' || configured === 'link') return configured
  return platform === 'darwin' ? 'link' : 'install'
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
  | { type: 'download-started'; version: string }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string; manual: boolean }
  | { type: 'load-failed'; message: string; manual: boolean }

export interface TransitionContext {
  mode: UpdateMode
  autoDownload: boolean // electron-updater starts the download itself after a check
  lastCheckedAt: number | null
  /** The version found last, to fall back to after a failed automatic download. */
  lastAvailable: string | null
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
        return { kind: 'downloading', version: event.version, percent: 0 }
      }
      return { kind: 'available', version: event.version, mode: context.mode }
    case 'not-available':
      return { kind: 'idle', checkedAt: event.at }
    case 'download-started':
      return { kind: 'downloading', version: event.version, percent: 0 }
    case 'progress':
      if (state.kind !== 'downloading' || !Number.isFinite(event.percent)) return state
      return { ...state, percent: Math.max(0, Math.min(100, Math.floor(event.percent))) }
    case 'downloaded':
      return { kind: 'ready', version: event.version }
    case 'error':
      if (event.manual) return { kind: 'error', message: event.message, manual: true }
      // Automatic failures are only logged and retried at the next check, so the state falls
      // back to what was known before.
      if (state.kind === 'downloading') {
        return { kind: 'available', version: state.version, mode: context.mode }
      }
      if (state.kind !== 'checking') return state
      return context.lastAvailable
        ? { kind: 'available', version: context.lastAvailable, mode: context.mode }
        : { kind: 'idle', checkedAt: context.lastCheckedAt }
    case 'load-failed':
      // Without electron-updater no check can run, so even an automatic one shows it.
      return { kind: 'error', message: event.message, manual: event.manual }
  }
}

/** First line of an updater error, short enough for Settings › About. */
export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const line = text.split('\n')[0].trim() || 'Unknown error'
  return line.length > 300 ? `${line.slice(0, 299)}…` : line
}
