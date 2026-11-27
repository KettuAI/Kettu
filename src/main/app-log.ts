// Main's side of the log files: opening them, native crash dumps, the renderer's console, gone
// processes and whether the last run ended unexpectedly.

import { app, crashReporter, type WebContents } from 'electron'
import { promises as fs, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  flushLogSync,
  logProcessFailures,
  openProcessLog,
  setLogLevel,
  setVerboseRecords,
  VERBOSE_PREFIX,
  writeLog,
} from '@shared/log/process-log'
import { createLogger } from './log'
import { compareVersions } from './update-state'

const log = createLogger('app')

const MAX_DUMPS = 10
const DUMP_AGE_MS = 14 * 24 * 60 * 60 * 1000
const RUNNING_MARKER = 'running'
const UPDATED_ARG = '--updated'

let verboseRun = false
// A debug run logs at the debug level, without the detailed records.
let debugRun = false
let verboseUntil: number | null = null
let verboseTimer: NodeJS.Timeout | null = null
let lastExit: number | null = null
let noticeClosed = false
// Set once Kettu enters an irreversible clean exit or OS shutdown, so the next run does not
// report an unexpected end even if the OS or an installer terminates the process before exit.
let quitCleanly = false
let runningMarker: string | null = null
let exitListenerAttached = false

/** Encodes the current process id and app version into the running marker file. */
export function formatRunningMarker(pid: number, version: string): string {
  return `${pid}\n${version}`
}

/** Parses the app version recorded in a running marker, or null for legacy PID-only markers. */
export function parseRunningMarkerVersion(content: string): string | null {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return lines.length >= 2 ? lines[1] : null
}

/**
 * Whether a leftover running marker belongs to an older version that the NSIS updater terminated
 * while installing this newer release. Same-version markers and launches without `--updated` are
 * never ignored so real crashes are still reported.
 */
export function isStaleUpdateMarker(
  content: string,
  currentVersion: string,
  argv: readonly string[],
): boolean {
  if (!argv.includes(UPDATED_ARG)) return false
  const previousVersion = parseRunningMarkerVersion(content)
  if (previousVersion === null) return true
  return compareVersions(previousVersion, currentVersion) < 0
}

function removeRunningMarkerSync(): void {
  if (!runningMarker) return
  try {
    rmSync(runningMarker, { force: true })
  } catch {
    // The next run reports an unexpected end, which is better than none.
  }
}

/**
 * Marks this run as exiting cleanly, removes the running marker immediately, and flushes buffered
 * main-process logs. Calling this on `session-end`, `will-quit`, and once `QuitFlow` completes
 * shutdown avoids false unexpected-exit warnings when Windows shutdown or an updater ends the
 * process before Node's `exit` event fires.
 */
export function markCleanExit(): void {
  quitCleanly = true
  removeRunningMarkerSync()
  flushLogSync()
}

/**
 * Opens main's log before anything else runs. A run with a data folder of its own, a development
 * run or one started with `--user-data-dir`, logs beside it: in the installed app's folder it
 * would rotate the installed app's files.
 */
export function openAppLog(ownUserData: string | null, debug: boolean): void {
  if (ownUserData) app.setAppLogsPath(join(ownUserData, 'logs'))
  else app.setAppLogsPath()
  verboseRun = app.commandLine.hasSwitch('verbose')
  debugRun = debug
  openProcessLog({
    dir: app.getPath('logs'),
    name: 'main',
    level: verboseRun || debugRun ? 'debug' : 'info',
    verbose: verboseRun,
    echo: !app.isPackaged,
    prune: true,
  })
  logProcessFailures({ rejections: true })
  // Dumps stay on this computer; Kettu sends nothing anywhere by itself.
  crashReporter.start({ uploadToServer: false, compress: true })
  log.info(`Kettu ${app.getVersion()} on ${process.platform} ${process.arch}`, {
    electron: process.versions.electron,
    packaged: app.isPackaged,
    verbose: verboseRun,
    debug: debugRun,
  })
}

/** Remembers whether the last run ended without quitting, and marks this one as running. */
export async function markRunning(argv: readonly string[] = process.argv): Promise<void> {
  const marker = join(app.getPath('userData'), RUNNING_MARKER)
  runningMarker = marker
  const stat = await fs.stat(marker).catch(() => null)
  if (stat) {
    const content = await fs.readFile(marker, 'utf8').catch(() => '')
    if (isStaleUpdateMarker(content, app.getVersion(), argv)) {
      log.info('Ignoring running marker left by previous version during update', {
        since: new Date(stat.mtimeMs).toISOString(),
      })
    } else {
      lastExit = stat.mtimeMs
      log.warn('The last run ended unexpectedly', { since: new Date(stat.mtimeMs).toISOString() })
    }
  }
  if (quitCleanly) {
    removeRunningMarkerSync()
    return
  }
  await fs.writeFile(marker, formatRunningMarker(process.pid, app.getVersion()))
  if (quitCleanly) {
    removeRunningMarkerSync()
    return
  }
  if (!exitListenerAttached) {
    exitListenerAttached = true
    // Fallback cleanup at process exit in case anything still needs a final synchronous removal.
    process.once('exit', () => {
      if (quitCleanly) removeRunningMarkerSync()
    })
  }
}

/** When the last run ended unexpectedly, as far as this run knows; null after a clean quit. */
export function lastUnexpectedExit(): number | null {
  return lastExit
}

/** When the last run ended unexpectedly, while the notice of it is not closed yet. */
export function unexpectedExitNotice(): number | null {
  return noticeClosed ? null : lastExit
}

/** The user closed the notice of the unexpected end, which then does not show again. */
export function dismissUnexpectedExit(): void {
  noticeClosed = true
}

export function watchProcesses(): void {
  app.on('will-quit', (event) => {
    if (!event.defaultPrevented) markCleanExit()
  })
  app.on('quit', () => {
    markCleanExit()
  })
  app.on('render-process-gone', (_event, webContents, details) => {
    log.error(
      `The page ${safeUrl(webContents)} lost its process: ${details.reason} (exit code ${details.exitCode})`,
    )
  })
  app.on('child-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return
    log.error(
      `The ${details.name ?? details.type} process ended: ${details.reason} (exit code ${details.exitCode})`,
    )
  })
  void pruneDumps()
}

function safeUrl(webContents: WebContents): string {
  try {
    const url = new URL(webContents.getURL())
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch {
    return 'unknown'
  }
}

/** The app's own pages' warnings and errors, which otherwise only DevTools would show. */
export function watchConsole(webContents: WebContents, name: string): void {
  webContents.on('console-message', (event) => {
    const { level, message, sourceId, lineNumber } = event
    if (level !== 'warning' && level !== 'error') return
    const where = sourceId ? ` (${shortSource(sourceId)}:${lineNumber})` : ''
    writeLog(level === 'error' ? 'error' : 'warn', name, `${message}${where}`)
  })
}

function shortSource(sourceId: string): string {
  try {
    const url = new URL(sourceId)
    return url.pathname.split('/').pop() || url.pathname
  } catch {
    return sourceId
  }
}

async function pruneDumps(): Promise<void> {
  const root = app.getPath('crashDumps')
  const dumps: { file: string; mtime: number }[] = []
  const walk = async (folder: string): Promise<void> => {
    const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const file = join(folder, entry.name)
      if (entry.isDirectory()) await walk(file)
      else if (entry.name.endsWith('.dmp')) {
        const stat = await fs.stat(file).catch(() => null)
        if (stat) dumps.push({ file, mtime: stat.mtimeMs })
      }
    }
  }
  await walk(root)
  dumps.sort((a, b) => b.mtime - a.mtime)
  const now = Date.now()
  for (const [index, dump] of dumps.entries()) {
    if (index >= MAX_DUMPS || now - dump.mtime > DUMP_AGE_MS) {
      await fs.rm(dump.file, { force: true }).catch(() => undefined)
    }
  }
}

/**
 * Applies the detailed records setting: on until `until`, or for the whole run with `--verbose`.
 * `expire` turns the setting off when its time is up. A debug run keeps the debug level either way.
 */
export function applyVerbose(
  until: number | null,
  expire: () => void,
  onChange: (level: 'debug' | 'info', verbose: boolean) => void,
): void {
  if (verboseTimer) clearTimeout(verboseTimer)
  verboseTimer = null
  const now = Date.now()
  const active = until !== null && until > now
  if (until !== null && !active) {
    expire()
    return
  }
  const verbose = verboseRun || active
  const level = verbose || debugRun ? 'debug' : 'info'
  const changed = (verboseUntil !== null && verboseUntil > now) !== active
  verboseUntil = active ? until : null
  setLogLevel(level)
  setVerboseRecords(verbose)
  if (active) {
    // setTimeout holds at most about 24.8 days; the setting allows one.
    verboseTimer = setTimeout(expire, until - now)
    verboseTimer.unref()
  }
  if (changed) log.info(active ? 'Detailed records on' : 'Detailed records off')
  onChange(level, verbose)
}

/** Deletes the detailed records; only while they are off, so no file is open. */
export async function clearVerboseRecords(): Promise<void> {
  const folder = app.getPath('logs')
  const names = await fs.readdir(folder).catch(() => [] as string[])
  await Promise.all(
    names
      .filter((name) => name.startsWith(VERBOSE_PREFIX))
      .map((name) => fs.rm(join(folder, name), { force: true }).catch(() => undefined)),
  )
  log.info('Detailed records deleted')
}

export function logsFolder(): string {
  return app.getPath('logs')
}
