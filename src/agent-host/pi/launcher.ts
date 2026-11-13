// Kettu's extension for Pi, and the launcher pi-acp runs in place of `pi` so Pi loads it: pi-acp
// starts its program with fixed arguments and Pi reads extensions only from `-e` or from the
// user's own folders, which Kettu leaves alone. Both are written into Kettu's harnesses folder.

import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Platform } from '@shared/platform'
import { MEMORY_TOOL_NAMES } from '../memory/tools'
import { SERVICE_NAME } from '../service-name'

/** The user's own `pi`, which the launcher runs. */
export const PI_COMMAND_VARIABLE = 'KETTU_PI_COMMAND'
/** The extension the launcher has Pi load. */
export const PI_EXTENSION_VARIABLE = 'KETTU_PI_EXTENSION'
/** A session's Kettu MCP service, as the session router gives its process; the extension's only. */
export const SERVICE_URL_VARIABLE = 'KETTU_MCP_URL'
export const SERVICE_TOKEN_VARIABLE = 'KETTU_MCP_TOKEN'

/**
 * The extension: registers Kettu's MCP service with Pi's own MCP support, only the memory tools
 * reachable, and drops the variables so the commands Pi runs never inherit the token. Kept on
 * `globalThis` for a `/reload`, which loads the extension again in the same process. Without
 * `registerMcpServer` (pi before 1.0.0) it does nothing.
 */
export const PI_EXTENSION_SOURCE = `// Written by Kettu: gives Pi's Kettu sessions Kettu's memory tools.
const TOOLS = ${JSON.stringify(MEMORY_TOOL_NAMES)}
const HELD = Symbol.for('kettu.mcp')

export default function kettu(pi) {
  const env = process.env
  const held = globalThis[HELD] ?? {
    url: env.${SERVICE_URL_VARIABLE},
    token: env.${SERVICE_TOKEN_VARIABLE},
  }
  globalThis[HELD] = held
  delete env.${SERVICE_URL_VARIABLE}
  delete env.${SERVICE_TOKEN_VARIABLE}
  if (!held.url || !held.token || typeof pi.registerMcpServer !== 'function') return
  try {
    pi.registerMcpServer(${JSON.stringify(SERVICE_NAME)}, {
      url: held.url,
      headers: { Authorization: 'Bearer ' + held.token },
      exposure: 'hidden',
      toolExposure: Object.fromEntries(TOOLS.map((name) => [name, 'direct'])),
    })
  } catch (error) {
    // Pi does not start with an extension that throws; the session goes on without the tools.
    console.error('Kettu could not add its memory tools: ' + error)
  }
}
`

const SH_LAUNCHER = `#!/bin/sh
# Written by Kettu: runs the user's pi with Kettu's extension.
exec "$${PI_COMMAND_VARIABLE}" -e "$${PI_EXTENSION_VARIABLE}" "$@"
`

// pi-acp runs a .cmd through cmd.exe, which passes the arguments on in %*.
const CMD_LAUNCHER = `@echo off\r
rem Written by Kettu: runs the user's pi with Kettu's extension.\r
"%${PI_COMMAND_VARIABLE}%" -e "%${PI_EXTENSION_VARIABLE}%" %*\r
`

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

/**
 * Writes `contents` to `file` unless it holds them already. Named by their digest, so instances of
 * different versions never replace a file another may be starting Pi with.
 */
async function ensureFile(file: string, contents: string, mode: number): Promise<void> {
  const current = await readFile(file, 'utf8').catch(() => null)
  if (current === contents) return
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(tmp, contents, { mode })
    await chmod(tmp, mode)
    await rename(tmp, file)
  } finally {
    await rm(tmp, { force: true })
  }
}

/** The launcher and the extension, written into `dir` when missing. */
export async function piLauncher(
  dir: string,
  platform: Platform,
): Promise<{ command: string; extension: string }> {
  const extension = path.join(dir, `kettu-${digest(PI_EXTENSION_SOURCE)}.mjs`)
  const windows = platform === 'win32'
  const launcher = windows ? CMD_LAUNCHER : SH_LAUNCHER
  const command = path.join(dir, `kettu-pi-${digest(launcher)}${windows ? '.cmd' : ''}`)
  await ensureFile(extension, PI_EXTENSION_SOURCE, 0o644)
  await ensureFile(command, launcher, 0o755)
  return { command, extension }
}
