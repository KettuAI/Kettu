// Kettu's own repository through the user's gh: whether they starred it, and starring it on their
// click. The repository is fixed, so no caller can star another one or run another gh command.

import { GH_TIMEOUT_MS, type Exec } from './exec'

export const KETTU_REPOSITORY = 'KettuAI/Kettu'

export const STAR_CHECK_ARGS: readonly string[] = ['api', `user/starred/${KETTU_REPOSITORY}`]
export const STAR_ARGS: readonly string[] = [
  'api',
  '--method',
  'PUT',
  `user/starred/${KETTU_REPOSITORY}`,
]

/** `unavailable`: gh is missing, signed out or failed, so a star goes through the browser. */
export type StarCheck = 'starred' | 'not-starred' | 'unavailable'

/** GitHub answers 204 when the user starred the repository and 404 when they did not. */
export async function checkStarred(exec: Exec, cwd: string): Promise<StarCheck> {
  const result = await exec('gh', STAR_CHECK_ARGS, { cwd, timeoutMs: GH_TIMEOUT_MS })
  if (result.failure !== null) return 'unavailable'
  if (result.code === 0) return 'starred'
  return result.code === 1 && /\(HTTP 404\)/.test(result.stderr) ? 'not-starred' : 'unavailable'
}

/** Stars the repository; false when gh could not. */
export async function starRepository(exec: Exec, cwd: string): Promise<boolean> {
  const result = await exec('gh', STAR_ARGS, { cwd, timeoutMs: GH_TIMEOUT_MS })
  return result.failure === null && result.code === 0
}
