// Runs a project's setup command in a new worktree, through the user's shell, and stops its
// whole process tree when it runs out of time or is cancelled.

import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Platform } from '@shared/platform'
import { LOG_LIMIT } from '../git/operations'
import { stopTrees, type ProcessControl } from '../process-tree'
import { defaultShell } from '../shell-env'
import type { SetupOptions, SetupRun } from './api'

/** How long a stopped command gets after `SIGTERM` before `SIGKILL`. */
export const SETUP_STOP_GRACE_MS = 3_000
/** How long output may still arrive after the command exits, from what it left running. */
const DRAIN_MS = 1_000

export interface ShellCommand {
  file: string
  args: string[]
  /** cmd.exe parses its own command line, so the quotes are written as it expects. */
  verbatim: boolean
}

export function shellCommand(
  command: string,
  platform: Platform,
  env: NodeJS.ProcessEnv,
): ShellCommand {
  if (platform === 'win32') {
    const file = env.ComSpec ?? env.COMSPEC ?? 'cmd.exe'
    return { file, args: ['/d', '/s', '/c', `"${command}"`], verbatim: true }
  }
  const file = defaultShell(platform, env)
  const name = path.posix.basename(file)
  // csh and tcsh accept `-l` only as their sole flag.
  const args = name === 'tcsh' || name === 'csh' ? ['-c', command] : ['-l', '-c', command]
  return { file, args, verbatim: false }
}

export interface SetupDeps {
  platform: Platform
  control: ProcessControl
  now: () => number
}

/** Never rejects: a command that fails, cannot start or is stopped is in the result. */
export function runSetup(
  command: string,
  options: SetupOptions,
  deps: SetupDeps,
): Promise<SetupRun> {
  if (options.signal?.aborted) return Promise.resolve({ exitCode: null, timedOut: false, tail: '' })
  const env: NodeJS.ProcessEnv = {
    ...options.env,
    KETTU_PROJECT_PATH: options.projectPath,
    KETTU_WORKTREE_PATH: options.cwd,
  }
  const shell = shellCommand(command, deps.platform, env)

  return new Promise<SetupRun>((resolve) => {
    let tail = ''
    let timedOut = false
    let stopped = false
    let exitCode: number | null = null
    let settled = false
    let drain: ReturnType<typeof setTimeout> | undefined

    const append = (chunk: string): void => {
      if (chunk === '') return
      tail += chunk
      if (tail.length > LOG_LIMIT) tail = tail.slice(tail.length - LOG_LIMIT)
      options.onOutput?.(chunk)
    }

    let child: ChildProcess
    try {
      child = spawn(shell.file, shell.args, {
        cwd: options.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: shell.verbatim,
        // Its own process group, which the stop follows to what the command started.
        detached: deps.platform !== 'win32',
      })
    } catch (error) {
      resolve({ exitCode: null, timedOut: false, tail: (error as Error).message })
      return
    }
    const startedAt = deps.now()

    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(drain)
      options.signal?.removeEventListener('abort', onAbort)
      child.stdout?.destroy()
      child.stderr?.destroy()
      for (const decoder of decoders) append(decoder.end())
      resolve({ exitCode: stopped ? null : exitCode, timedOut, tail })
    }

    const stop = (): void => {
      if (stopped || settled) return
      stopped = true
      const pid = child.pid
      if (pid === undefined) return
      void stopTrees(deps.control, [{ pid, startedAt }], SETUP_STOP_GRACE_MS).catch(() => {
        // Listing failed: the root alone is still stopped.
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
      })
    }
    const onAbort = (): void => stop()

    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')]
    child.stdout?.on('data', (data: Buffer) => append(decoders[0]!.write(data)))
    child.stderr?.on('data', (data: Buffer) => append(decoders[1]!.write(data)))
    child.on('error', (error) => {
      append(`${error.message}\n`)
      finish()
    })
    child.on('exit', (code) => {
      exitCode = code
      // A background process the command left may hold the pipes open.
      drain = setTimeout(finish, DRAIN_MS)
    })
    child.on('close', finish)

    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, options.timeoutMs)
    options.signal?.addEventListener('abort', onAbort, { once: true })
  })
}
