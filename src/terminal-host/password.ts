// Whether a terminal's program waits for a password. Programs that read one (sudo, ssh, git) turn
// the terminal's echo off and keep canonical input on, while full-screen programs and the shell's
// own line editor turn both off; this is how iTerm2 tells a password prompt too. Windows has no
// such modes, so there the prompt's own words are all there is to go by.

import { execFile } from 'node:child_process'
import type { Platform } from '@shared/platform'

export interface TtyModes {
  echo: boolean
  icanon: boolean
}

/** The echo and canonical input flags in `stty -a` output, or null when it names neither. */
export function parseTtyModes(output: string): TtyModes | null {
  const flags = new Set(output.split(/\s+/))
  const flag = (name: string): boolean | null =>
    flags.has(name) ? true : flags.has(`-${name}`) ? false : null
  const echo = flag('echo')
  const icanon = flag('icanon')
  return echo === null || icanon === null ? null : { echo, icanon }
}

export function readsPassword(modes: TtyModes): boolean {
  return !modes.echo && modes.icanon
}

const PROMPT = /(?:\b(?:password|passphrase|pass phrase)\b|密码|口令)[^\n]{0,80}[:：]\s*$/i

/** Whether the line the cursor waits on reads as a password prompt. */
export function looksLikePasswordPrompt(line: string): boolean {
  return PROMPT.test(line)
}

const STTY_TIMEOUT_MS = 1000

/** Reads a pty's modes from its device with `stty`; null when it cannot be read. */
export function readTtyModes(platform: Platform, device: string): Promise<TtyModes | null> {
  if (platform === 'win32' || !device.startsWith('/dev/')) return Promise.resolve(null)
  const deviceFlag = platform === 'darwin' ? '-f' : '-F'
  return new Promise((resolve) => {
    execFile(
      'stty',
      ['-a', deviceFlag, device],
      // A Dock-started app may lack these on its PATH.
      {
        timeout: STTY_TIMEOUT_MS,
        env: { ...process.env, PATH: `${process.env.PATH ?? ''}:/bin:/usr/bin` },
      },
      (error, stdout) => resolve(error ? null : parseTtyModes(String(stdout))),
    )
  })
}
