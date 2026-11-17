// The version of a uvx harness the user updated to, which uv keeps in its own cache: Kettu records
// it once uv has fetched it, and a start runs it while it is newer than the pinned version.

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentId } from '@shared/thread'

/** The record in the harness's folder of `~/.kettu/harnesses`. */
export const UVX_FILE = 'uvx.json'

/** A plain `1.2.3`: it reaches uvx's command line, so nothing else is read or written. */
const PLAIN_VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/

/** The version recorded for the harness; null when none is, or the record is not one. */
export async function readUvxVersion(root: string, agentId: AgentId): Promise<string | null> {
  try {
    const record = JSON.parse(await readFile(path.join(root, agentId, UVX_FILE), 'utf8')) as {
      version?: unknown
    } | null
    const version = record?.version
    return typeof version === 'string' && PLAIN_VERSION.test(version) ? version : null
  } catch {
    return null
  }
}

/** Records the version a start runs from now on, whole or not at all. */
export async function writeUvxVersion(
  root: string,
  agentId: AgentId,
  version: string,
): Promise<void> {
  if (!PLAIN_VERSION.test(version)) throw new Error(`${version} is not a plain version`)
  const dir = path.join(root, agentId)
  await mkdir(dir, { recursive: true })
  const partial = path.join(dir, `.${UVX_FILE}-${randomBytes(6).toString('hex')}`)
  try {
    await writeFile(partial, `${JSON.stringify({ version }, null, 2)}\n`)
    await rename(partial, path.join(dir, UVX_FILE))
  } catch (error) {
    await rm(partial, { force: true })
    throw error
  }
}

/**
 * uvx's arguments that fetch `version` into uv's cache without starting the agent, by running the
 * environment's own Python, so a version uv cannot fetch is never recorded.
 */
export function uvxFetchArgs(packageName: string, version: string): string[] {
  return ['--from', `${packageName}==${version}`, 'python', '--version']
}
