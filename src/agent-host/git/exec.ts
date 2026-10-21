// Runs git and gh as child processes: never through a shell, always with a timeout.

import { execFile, type ChildProcess, type ExecFileException } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { findWindowsExecutable } from './executable'

export type ExecFailure =
  'not-found' | 'cwd-missing' | 'timeout' | 'max-buffer' | 'killed' | 'spawn'

export interface ExecResult {
  /** The exit code; null when the process did not exit on its own (see `failure`). */
  code: number | null
  stdout: string
  stderr: string
  /** Why there is no exit code, or null when the process ran to its end. */
  failure: ExecFailure | null
  message: string
}

export interface ExecOptions {
  cwd?: string
  timeoutMs: number
  /** Merged over the base environment. */
  env?: NodeJS.ProcessEnv
  maxBuffer?: number
}

/** Never rejects: every outcome is in the result. */
export type Exec = (
  file: string,
  args: readonly string[],
  options: ExecOptions,
) => Promise<ExecResult>

export interface ExecRunner {
  exec: Exec
  /** Terminates every running child and makes later results report `killed`. */
  killAll(): void
}

// No locale: the few human-readable outputs that are matched (shortstat, error
// messages) must not be translated. The rest keeps git and gh from waiting for input.
export const CHILD_ENV: NodeJS.ProcessEnv = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  LC_ALL: 'C',
}

const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024

export interface CreateExecOptions {
  platform?: NodeJS.Platform
  /** Replaces the Windows lookup, for tests. */
  find?: (name: string, env: NodeJS.ProcessEnv) => Promise<string | null>
}

export function createExec(
  getEnv: () => NodeJS.ProcessEnv,
  { platform = process.platform, find = findWindowsExecutable }: CreateExecOptions = {},
): ExecRunner {
  const children = new Set<ChildProcess>()
  const resolved = new Map<string, string>()
  let stopped = false

  // On Windows the command is found here, because CreateProcess looks in the working
  // directory first and the working directory is a repository we do not trust.
  async function commandPath(file: string, env: NodeJS.ProcessEnv): Promise<string | null> {
    if (platform !== 'win32') return file
    const key = `${file}\0${env.PATH ?? env.Path ?? ''}`
    const known = resolved.get(key)
    if (known !== undefined) return known
    const found = await find(file, env)
    // A miss is not cached: the command may be installed a moment later.
    if (found !== null) resolved.set(key, found)
    return found
  }

  const exec: Exec = async (file, args, options) => {
    if (stopped) return failed('killed', 'The git service was disposed')
    const env = { ...getEnv(), ...CHILD_ENV, ...options.env }
    const command = await commandPath(file, env)
    if (command === null) return failed('not-found', `${file} was not found on PATH`)
    if (stopped) return failed('killed', 'The git service was disposed')
    return new Promise<ExecResult>((resolve) => {
      let child: ChildProcess
      try {
        child = execFile(
          command,
          [...args],
          {
            cwd: options.cwd,
            env,
            timeout: options.timeoutMs,
            maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
            windowsHide: true,
            encoding: 'utf8',
          },
          (error, stdout, stderr) => {
            children.delete(child)
            if (!error) {
              resolve({ code: 0, stdout, stderr, failure: null, message: '' })
              return
            }
            const code: unknown = error.code
            if (typeof code === 'number') {
              resolve({ code, stdout, stderr, failure: null, message: error.message })
              return
            }
            void classify(error, options.cwd, stopped).then((failure) => {
              // The cached location may be stale, such as after an uninstall.
              if (failure === 'not-found') resolved.clear()
              resolve({ code: null, stdout, stderr, failure, message: error.message })
            })
          },
        )
      } catch (error) {
        resolve(failed('spawn', error instanceof Error ? error.message : String(error)))
        return
      }
      children.add(child)
      // Nothing here reads input; a closed stdin makes a stray prompt fail instead of hang.
      child.stdin?.on('error', () => {})
      child.stdin?.end()
    })
  }

  return {
    exec,
    killAll() {
      stopped = true
      for (const child of children) child.kill()
      children.clear()
    },
  }
}

function failed(failure: ExecFailure, message: string): ExecResult {
  return { code: null, stdout: '', stderr: '', failure, message }
}

async function classify(
  error: ExecFileException,
  cwd: string | undefined,
  stopped: boolean,
): Promise<ExecFailure> {
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'max-buffer'
  if (error.killed) return stopped ? 'killed' : 'timeout'
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
    // Node reports a missing working directory as ENOENT for the command.
    if (cwd !== undefined && !(await isDirectory(cwd))) return 'cwd-missing'
    return 'not-found'
  }
  return 'spawn'
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** The result as one line for logs and error messages. */
export function describeFailure(result: ExecResult): string {
  const detail = result.stderr.trim() || result.message
  switch (result.failure) {
    case 'timeout':
      return 'timed out'
    case 'not-found':
      return 'command not found'
    case 'cwd-missing':
      return 'working directory does not exist'
    case null:
      return detail || `exited with code ${result.code}`
    default:
      return detail || result.failure
  }
}

export const GIT_TIMEOUT_MS = 10_000
export const FETCH_TIMEOUT_MS = 60_000
export const GH_TIMEOUT_MS = 10_000

/** A command that ran but did not succeed, or did not run at all. */
export class CommandError extends Error {
  constructor(
    readonly label: string,
    readonly result: ExecResult,
  ) {
    super(`${label}: ${describeFailure(result)}`)
    this.name = 'CommandError'
  }
}

/** Returns the result when the command exited with code 0, else throws a CommandError. */
export function expectOk(label: string, result: ExecResult): ExecResult {
  if (result.failure !== null || result.code !== 0) throw new CommandError(label, result)
  return result
}
