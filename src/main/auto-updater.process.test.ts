// Process test: loads electron-updater as the packaged app does, in Electron's main process with
// Node's own module loader. Under Vitest's loader a CommonJS package's exports always look named.

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'

const electron: string = createRequire(import.meta.url)('electron')

let dir: string | null = null

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5 })
  dir = null
})

function harness(moduleUrl: string, resultFile: string): string {
  return `const { app } = require('electron')
const { writeFileSync } = require('node:fs')
function report(result) {
  writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(result))
  app.exit(0)
}
app
  .whenReady()
  .then(() => import(${JSON.stringify(moduleUrl)}))
  .then(({ loadAutoUpdater }) => loadAutoUpdater())
  .then(({ autoUpdater, CancellationToken }) => {
    // The first thing Updater.load() does with it.
    autoUpdater.logger = null
    const token = new CancellationToken()
    token.cancel()
    report({
      checkForUpdates: typeof autoUpdater.checkForUpdates,
      on: typeof autoUpdater.on,
      cancelled: token.cancelled,
    })
  })
  .catch((error) => report({ error: String((error && error.stack) || error) }))
`
}

function run(args: string[]): Promise<{ code: number | null; stderr: string }> {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return new Promise((resolve, reject) => {
    const child = spawn(electron, args, { env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.once('error', reject)
    child.once('exit', (code) => resolve({ code, stderr }))
  })
}

it('gets usable electron-updater exports in the packaged app', { timeout: 60_000 }, async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'overbench-updater-'))
  const result = path.join(dir, 'result.json')
  const main = path.join(dir, 'main.cjs')
  await writeFile(main, harness(new URL('./auto-updater.ts', import.meta.url).href, result))
  const { code, stderr } = await run([
    main,
    `--user-data-dir=${path.join(dir, 'data')}`,
    // CI's Ubuntu has no display and restricts the user namespaces Chromium's sandbox needs.
    ...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []),
  ])
  const text = await readFile(result, 'utf8').catch((): never => {
    throw new Error(`Electron exited with ${code} and no result:\n${stderr}`)
  })
  expect(JSON.parse(text)).toEqual({ checkForUpdates: 'function', on: 'function', cancelled: true })
})
