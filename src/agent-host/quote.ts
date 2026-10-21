// Shell quoting for commands shown to the user or typed into a terminal.

import type { Platform } from '@shared/platform'

// A leading `=` expands in zsh and `^` is a zsh glob operator, so neither is left bare.
const POSIX_SAFE = /^[A-Za-z0-9_\-+.,/:@%][A-Za-z0-9_\-+=.,/:@%]*$/
// cmd.exe treats these specially outside quotes; whitespace splits arguments.
const CMD_UNSAFE = /[\s&|<>()^"%!,;=]/

/** POSIX shells: single quotes, with embedded single quotes closed, escaped and reopened. */
export function quotePosix(arg: string): string {
  if (arg !== '' && POSIX_SAFE.test(arg)) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/** cmd.exe: double quotes, with embedded double quotes doubled. Windows paths cannot hold `"`. */
export function quoteCmd(arg: string): string {
  if (arg !== '' && !CMD_UNSAFE.test(arg)) return arg
  return `"${arg.replace(/"/g, '""')}"`
}

export interface CommandLine {
  command: string
  args: readonly string[]
  env?: Readonly<Record<string, string>>
}

/** The command as one line for the platform's shell: POSIX on macOS and Linux, cmd.exe on Windows. */
export function formatCommand(line: CommandLine, platform: Platform): string {
  const windows = platform === 'win32'
  const quote = windows ? quoteCmd : quotePosix
  const words = [line.command, ...line.args].map(quote).join(' ')
  const env = Object.entries(line.env ?? {})
  if (env.length === 0) return words
  if (windows) {
    return `${env.map(([name, value]) => `set ${quoteCmd(`${name}=${value}`)}`).join(' && ')} && ${words}`
  }
  return `${env.map(([name, value]) => `${name}=${quotePosix(value)}`).join(' ')} ${words}`
}
