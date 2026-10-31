// The computer's model as the system reports it, such as "MacBook Pro": what pairing tells a host
// this computer is, and the icon of its row in Settings › Hosts. Read once per run, in a child
// process or a file, never on the main thread.

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Platform } from '@shared/platform'

const TIMEOUT_MS = 5_000
const MAX_MODEL = 64

function output(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: TIMEOUT_MS, windowsHide: true }, (error, stdout) =>
      resolve(error ? '' : String(stdout)),
    )
  })
}

/** The model in what the system printed, cleaned up; empty when it names none. */
export function parseModel(platform: Platform, text: string): string {
  let model: string
  if (platform === 'darwin') {
    try {
      const name = (JSON.parse(text) as { SPHardwareDataType?: { machine_name?: unknown }[] })
        .SPHardwareDataType?.[0]?.machine_name
      model = typeof name === 'string' ? name : ''
    } catch {
      model = ''
    }
  } else if (platform === 'win32') {
    model = /SystemProductName\s+REG_SZ\s+(.+)/.exec(text)?.[1] ?? ''
  } else {
    model = text
  }
  const kept = [...model].filter((char) => char >= ' ' && char !== '\u007f').join('')
  return [...kept.trim()].slice(0, MAX_MODEL).join('').trim()
}

async function readModel(): Promise<string> {
  const platform = process.platform
  if (platform === 'darwin') {
    return parseModel(
      platform,
      await output('/usr/sbin/system_profiler', ['SPHardwareDataType', '-json']),
    )
  }
  if (platform === 'win32') {
    const reg = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe')
    const key = 'HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS'
    return parseModel(platform, await output(reg, ['query', key, '/v', 'SystemProductName']))
  }
  try {
    return parseModel(platform, await readFile('/sys/class/dmi/id/product_name', 'utf8'))
  } catch {
    return ''
  }
}

let forRun: Promise<string> | null = null

export function computerModelForRun(): Promise<string> {
  forRun ??= readModel()
  return forRun
}
