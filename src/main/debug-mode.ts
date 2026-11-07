// Debug mode in the app: decided once at startup from the command line, for this run only. A
// debug run opens the renderer's CDP port and main's and each host's Node.js inspector, all on
// 127.0.0.1, and lists them in the log folder and Settings › Advanced.

import { app, type RelaunchOptions } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEBUG_ENV,
  DEBUG_OFF,
  DEBUG_PORTS_FILE,
  debugRun,
  type DebugRun,
  type DebugStatus,
} from '@shared/debug'
import {
  DebugPortsFile,
  INSPECT_ENV,
  openInspector,
  removePortsFile,
} from '@shared/log/debug-inspector'
import { broadcast } from './events'
import { createLogger } from './log'

const log = createLogger('debug')

const switchValue = (name: string): string | null =>
  app.commandLine.hasSwitch(name) ? app.commandLine.getSwitchValue(name) : null

let decided: DebugRun | null = null

/** This run's debug mode, read from the command line the first time it is asked for. */
function run(): DebugRun {
  if (!decided) {
    decided = debugRun(
      {
        debug: switchValue('debug'),
        remoteDebuggingPort: switchValue('remote-debugging-port'),
        remoteDebuggingPipe: app.commandLine.hasSwitch('remote-debugging-pipe'),
        env: process.env[DEBUG_ENV],
      },
      app.isPackaged,
    )
    // Agents and shells get this process's environment; this is not theirs.
    delete process.env[DEBUG_ENV]
  }
  return decided
}

const CDP_FILE = 'DevToolsActivePort'
const CDP_TRIES = 20
const CDP_RETRY_MS = 250

let ports: DebugPortsFile | null = null

export function isDebugRun(): boolean {
  return run().on
}

/** What a second instance tells the running one, through the single-instance lock. */
export function lockData(): { debug: boolean } {
  return { debug: run().on }
}

/** Whether a second instance was started to debug. */
export function asksForDebug(data: unknown): boolean {
  return typeof data === 'object' && data !== null && (data as { debug?: unknown }).debug === true
}

/**
 * Opens what a debug run has, once this process holds the single-instance lock and before the
 * app is ready, when Chromium still reads its switches; in a normal run, removes a stale list.
 */
export function startDebugMode(logsFolder: string): void {
  const file = join(logsFolder, DEBUG_PORTS_FILE)
  const debug = run()
  if (!debug.on) {
    void removePortsFile(file)
    return
  }
  if (debug.problem) log.warn(`${debug.problem}; using a free port`)
  if (debug.cdp !== null) app.commandLine.appendSwitch('remote-debugging-port', String(debug.cdp))
  ports = new DebugPortsFile(file, {
    cdp: true,
    changed: (status) => broadcast('debug:changed', status),
  })
  log.warn('Debug mode: debugging ports without authentication are open on 127.0.0.1')
  try {
    ports.setInspector('main', openInspector())
  } catch (error) {
    log.error('Could not open the inspector', error)
  }
  void app.whenReady().then(readCdpPort)
}

export function debugStatus(): DebugStatus {
  return ports?.status() ?? DEBUG_OFF
}

/** The environment that makes a forked host open its inspector in a debug run. */
export function hostInspectEnv(): Record<string, string> {
  return run().on ? { [INSPECT_ENV]: '1' } : {}
}

/** A host's inspector, or null once the host is gone. */
export function hostInspector(name: string, url: string | null): void {
  ports?.setInspector(name, url)
}

/**
 * The arguments to start the next run with: this run's, with debugging in or out. A development
 * run has no `--debug`, so it passes the request in the environment, which `app.relaunch` keeps.
 */
export function prepareRelaunch(debug: boolean): RelaunchOptions {
  // A development run keeps its own debugging port.
  const switches = app.isPackaged
    ? /^--(debug|remote-debugging-port|remote-debugging-pipe)(=|$)/
    : /^--debug(=|$)/
  const args = process.argv.slice(1).filter((arg) => !switches.test(arg))
  if (app.isPackaged) {
    if (debug) args.push('--debug')
  } else if (debug) {
    process.env[DEBUG_ENV] = '1'
  } else {
    delete process.env[DEBUG_ENV]
  }
  return { args }
}

/** Chromium writes the port it picked into the data folder once its DevTools server listens. */
async function readCdpPort(): Promise<void> {
  if (!app.commandLine.hasSwitch('remote-debugging-port')) {
    ports?.setCdp('pipe')
    return
  }
  const file = join(app.getPath('userData'), CDP_FILE)
  // A file older than this run is a past run's.
  const started = Date.now() - process.uptime() * 1000 - 1000
  for (let attempt = 0; attempt < CDP_TRIES; attempt++) {
    const info = await stat(file).catch(() => null)
    if (info && info.mtimeMs >= started) {
      const port = Number((await readFile(file, 'utf8').catch(() => '')).split('\n')[0])
      if (Number.isInteger(port) && port > 0) {
        ports?.setCdp(port)
        log.info(`DevTools listening on 127.0.0.1:${port}`)
        return
      }
    }
    await new Promise((resolve) => setTimeout(resolve, CDP_RETRY_MS))
  }
  ports?.setCdp('failed')
  log.warn('Chromium did not say which port DevTools listens on; the port may be taken')
}
