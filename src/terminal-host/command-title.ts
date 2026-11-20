// A terminal's title from the program in its foreground: its command line as a person would have
// typed it, read from the system's process table, since node-pty gives only the program's name.

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import type { Platform } from '@shared/platform'
import { MAX_TERMINAL_NAME } from '@shared/terminal-host'

// Programs that run a script named by their first argument, which then names the command.
const INTERPRETERS = /^(node|nodejs|bun|deno|python[\d.]*|ruby|perl|php|sh|bash|zsh|dash)$/
const SCRIPT_EXTENSIONS = /\.(c|m)?js$|\.ts$|\.py$|\.rb$|\.pl$|\.sh$/

function lastPart(arg: string): string {
  if (!/[\\/]/.test(arg) || arg.endsWith('/')) return arg
  return arg.slice(Math.max(arg.lastIndexOf('/'), arg.lastIndexOf('\\')) + 1)
}

/**
 * A command line as a tab shows it: `node /usr/local/bin/pnpm dev` as `pnpm dev`, paths as their
 * last part, cut at the length of a tab's name. Null for no arguments.
 */
export function commandTitle(argv: readonly string[]): string | null {
  const args = argv.filter((arg) => arg.length > 0)
  if (args.length === 0) return null
  let program = lastPart(args[0]!).replace(/^-/, '')
  let rest = args.slice(1)
  // An interpreter running a script by its path, as a package manager's shim does, is the script.
  if (INTERPRETERS.test(program) && rest[0] && !rest[0].startsWith('-') && /[\\/]/.test(rest[0])) {
    program = lastPart(rest[0]).replace(SCRIPT_EXTENSIONS, '')
    rest = rest.slice(1)
  }
  const title = [program, ...rest.map(lastPart)].join(' ')
  return title.length > MAX_TERMINAL_NAME ? `${title.slice(0, MAX_TERMINAL_NAME - 1)}…` : title
}

/** The first line of a command an agent or a reply ran, as the tab's first title. */
export function typedTitle(command: string): string {
  const line = command.trim().split(/\r?\n/, 1)[0] ?? ''
  return line.length > MAX_TERMINAL_NAME ? `${line.slice(0, MAX_TERMINAL_NAME - 1)}…` : line
}

const PS_TIMEOUT_MS = 1000

function ps(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      args,
      // A Dock-started app may lack these on its PATH.
      { timeout: PS_TIMEOUT_MS, env: { ...process.env, PATH: `${process.env.PATH ?? ''}:/bin` } },
      (error, stdout) => resolve(error ? null : String(stdout).trim()),
    )
  })
}

/**
 * The arguments of the foreground process group's leader on the terminal whose shell is `pid`;
 * null when they cannot be read, as on Windows.
 */
export async function readCommandLine(platform: Platform, pid: number): Promise<string[] | null> {
  if (platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      // The fields after the program's name, which may hold spaces and parentheses itself.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const group = Number(fields[5])
      if (!Number.isInteger(group) || group <= 0) return null
      const cmdline = await readFile(`/proc/${group}/cmdline`, 'utf8')
      return cmdline.split('\0').filter(Boolean)
    } catch {
      return null
    }
  }
  if (platform !== 'darwin') return null
  const group = Number(await ps(['-o', 'tpgid=', '-p', String(pid)]))
  if (!Number.isInteger(group) || group <= 0) return null
  const args = await ps(['-o', 'args=', '-p', String(group)])
  return args ? args.split(/\s+/) : null
}
