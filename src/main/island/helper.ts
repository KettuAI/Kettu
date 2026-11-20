// Starts the notch island's helper, the native program in the app's helpers, as a child of main
// with pipes for its standard streams. Its environment holds only what a system program needs, so
// none of the user's or the agents' variables reach it.

import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { HelperProcess } from './bridge'

const NAME = 'kettu-island'

/** Where the helper is: the app's helpers once packaged, `out/helpers` in development. */
function helperFile(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'helpers', NAME)
    : join(app.getAppPath(), 'out', 'helpers', NAME)
}

function helperEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
  if (process.env.HOME) env.HOME = process.env.HOME
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  // A development run may have the helper show and log what it receives.
  if (!app.isPackaged && process.env.KETTU_ISLAND_DEBUG) {
    env.KETTU_ISLAND_DEBUG = process.env.KETTU_ISLAND_DEBUG
  }
  return env
}

/** The helper running, or null when this build has none or this is not macOS. */
export async function spawnIslandHelper(): Promise<HelperProcess | null> {
  if (process.platform !== 'darwin') return null
  const file = helperFile()
  try {
    await access(file, constants.X_OK)
  } catch {
    return null
  }
  const child = spawn(file, [], { stdio: ['pipe', 'pipe', 'pipe'], env: helperEnv() })
  const exits: ((code: number | null, signal: string | null) => void)[] = []
  let exited = false
  const exit = (code: number | null, signal: string | null): void => {
    if (exited) return
    exited = true
    for (const listener of exits) listener(code, signal)
  }
  child.on('exit', (code, signal) => exit(code, signal))
  // A program that cannot start fires `error` and no `exit`.
  child.on('error', () => exit(null, 'error'))
  // The helper leaving closes its input; a write after that must not throw in main.
  child.stdin.on('error', () => undefined)
  child.stderr.setEncoding('utf8')
  return {
    write: (line) => {
      if (!child.stdin.destroyed) child.stdin.write(line)
    },
    unread: () => child.stdin.writableLength,
    onStdout: (listener) => child.stdout.on('data', (chunk: Buffer) => listener(chunk)),
    onStderr: (listener) => child.stderr.on('data', (text: string) => listener(text)),
    onExit: (listener) => {
      exits.push(listener)
    },
    kill: () => {
      if (!exited) child.kill('SIGKILL')
    },
  }
}
