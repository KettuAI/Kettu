// Debug mode: one run of Kettu, or of the daemon, with debugging ports open on 127.0.0.1 only.
// The ports have no authentication, so a run never opens one without saying so.

import { MIN_OWN_PORT, parsePort } from './remote/address'

/** The only address a debugging port listens on. */
export const DEBUG_HOST = '127.0.0.1'

/** The file in the log folder that lists a debug run's ports, for scripts and agents. */
export const DEBUG_PORTS_FILE = 'debug-ports.json'

/**
 * A development run's way in. Electron hands `--debug` to Node.js, which refuses it, unless the
 * fuse that installed builds turn off is off.
 */
export const DEBUG_ENV = 'KETTU_DEBUG'

/** The command line's switches that ask for debugging, as Chromium parsed them. */
export interface DebugSwitches {
  /** `--debug`'s value: '' without one, null when the switch is absent. */
  debug: string | null
  remoteDebuggingPort: string | null
  remoteDebuggingPipe: boolean
  /** `KETTU_DEBUG`, which counts in a development run only. */
  env: string | undefined
}

export type DebugRun =
  | { on: false }
  | {
      on: true
      /**
       * The CDP port for Kettu to open, 0 for a free one; null when the command line already
       * opens one, which Chromium does by itself.
       */
      cdp: number | null
      /** What was wrong with the port asked for, which is replaced with a free one. */
      problem?: string
    }

/**
 * Whether this run is a debug run. An installed build takes `--debug[=<port>]`, and treats a
 * `--remote-debugging-port` or `--remote-debugging-pipe` passed in as one, since Chromium opens
 * those whatever Kettu does. A development run keeps its own debugging port as it is.
 */
export function debugRun(switches: DebugSwitches, packaged: boolean): DebugRun {
  const given = switches.remoteDebuggingPort !== null || switches.remoteDebuggingPipe
  const env = switches.env?.trim()
  const asked = packaged ? switches.debug : env ? (env === '1' ? '' : env) : null
  if (asked === null) return packaged && given ? { on: true, cdp: null } : { on: false }
  if (given) return { on: true, cdp: null }
  if (asked === '') return { on: true, cdp: 0 }
  const port = parsePort(asked)
  if (port !== null) return { on: true, cdp: port }
  return {
    on: true,
    cdp: 0,
    problem: `The debugging port must be a number from ${MIN_OWN_PORT} to 65535`,
  }
}

/** A debug run's ports, as Settings › Advanced and the ports file list them. */
export interface DebugStatus {
  on: boolean
  /**
   * The renderer's Chrome DevTools Protocol port: 'pipe' when it is a pipe, 'failed' when Chromium
   * never said it listens, as when the port is taken, and null until known.
   */
  cdp: number | 'pipe' | 'failed' | null
  /** Each process's Node.js inspector, by process name: main, agent-host and so on. */
  inspectors: { name: string; url: string }[]
  /** The ports file, or null outside a debug run. */
  file: string | null
}

export const DEBUG_OFF: DebugStatus = { on: false, cdp: null, inspectors: [], file: null }
