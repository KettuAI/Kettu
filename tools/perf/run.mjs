#!/usr/bin/env node
// Starts the production build in `out/` with the fake agent, a fresh data folder and a scratch
// project, runs measure.mjs against it, and exits with its code. This is how CI measures the
// budgets on runners nobody sits at.
//
//   pnpm build && node tools/perf/run.mjs [--port 9250] [--json]
//
// On Linux CI, run it under `xvfb-run -a`.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, launchApp, makeProject, openProject, stopApp } from '../launch.mjs'

const args = process.argv.slice(2)
const index = args.indexOf('--port')
const port = Number(index === -1 ? 9250 : args[index + 1])

const scratch = mkdtempSync(join(tmpdir(), 'kettu-perf-'))
const project = join(scratch, 'demo-project')
makeProject(project)
const app = launchApp({ port, userData: join(scratch, 'user-data') })

let code = 1
try {
  let cdp = await connect(port)
  cdp = await openProject(port, cdp, project)
  cdp.close()
  const measure = spawn(
    process.execPath,
    [
      join(import.meta.dirname, 'measure.mjs'),
      '--port',
      String(port),
      ...(args.includes('--json') ? ['--json'] : []),
    ],
    { stdio: 'inherit' },
  )
  code = await new Promise((done) => measure.on('exit', (exit) => done(exit ?? 1)))
} catch (error) {
  process.stderr.write(
    `Perf run failed: ${error instanceof Error ? error.message : String(error)}\n`,
  )
} finally {
  await stopApp(app)
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5 })
}
process.exit(code)
