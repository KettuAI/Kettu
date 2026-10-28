// @ts-check
// Apple's ticket service can drop a connection after notarization has already succeeded.
import { execFile } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** @param {string} appPath */
async function runStapler(appPath) {
  const { stdout, stderr } = await exec('xcrun', ['stapler', 'validate', appPath], {
    timeout: 60_000,
  })
  process.stdout.write(stdout)
  process.stderr.write(stderr)
}

/**
 * @param {string} appPath
 * @param {{ run?: (appPath: string) => Promise<void>, wait?: (ms: number) => Promise<unknown> }} [options]
 */
export async function validateTicket(appPath, { run = runStapler, wait = delay } = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await run(appPath)
      return
    } catch (error) {
      // 68 means the ticket could not be retrieved; malformed apps and other failures stop at once.
      if (!(error instanceof Error) || !('code' in error) || error.code !== 68 || attempt === 3) {
        throw error
      }
      console.warn(`Apple ticket validation failed (68); retrying in ${attempt * 10} seconds.`)
      await wait(attempt * 10_000)
    }
  }
}

if (import.meta.main) {
  const [appPath, ...extra] = process.argv.slice(2)
  try {
    if (!appPath || extra.length > 0) throw new Error('Usage: mac-stapler.mjs <app path>')
    await validateTicket(appPath)
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
