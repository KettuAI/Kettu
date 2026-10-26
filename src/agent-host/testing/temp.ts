import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { onTestFinished } from 'vitest'

/**
 * A new folder in the system temp folder, removed once the test that asked for it and its
 * `afterEach` hooks have finished, so a host those hooks stop is down before its folder goes.
 * Only a running test can ask for one.
 */
export async function tempFolder(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  return dir
}
