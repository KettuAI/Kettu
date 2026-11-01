// Process test: the daemon built as it ships loads the Claude Agent SDK, an ES module that Kettu
// installs into its data folder at first use, through the agent host's own loader.

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))

// What loadClaudeSdk checks the module for.
const SDK_EXPORTS = [
  'query',
  'listSessions',
  'getSessionInfo',
  'getSessionMessages',
  'getSubagentMessages',
  'deleteSession',
  'forkSession',
  'resolveSettings',
  'filterEscalatingDefaultMode',
]

// Built into the bundle beside the hosts, so it goes through the daemon's build options.
const PROBE = `
import { loadClaudeSdk } from ${JSON.stringify(path.join(root, 'src/agent-host/claude/sdk.ts'))}

loadClaudeSdk(process.argv[2]).then(
  (sdk) => console.log(sdk.query()),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  },
)
`

let dir = ''
let bundle = ''

// The daemon runs on macOS and Linux only.
const describeUnix = describe.skipIf(process.platform === 'win32')

beforeAll(async () => {
  if (process.platform === 'win32') return
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kettu-daemon-bundle-')))
  bundle = path.join(dir, 'bundle')
  const probe = path.join(dir, 'probe.ts')
  await writeFile(probe, PROBE)
  await build({
    configFile: path.join(root, 'vite.daemon.config.mts'),
    logLevel: 'silent',
    build: { outDir: bundle, rolldownOptions: { input: { probe } } },
  })
}, 120_000)

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

describeUnix('the daemon bundle', () => {
  it('loads the Claude Agent SDK from the folder it was installed in', async () => {
    const sdk = path.join(dir, 'data', 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
    await mkdir(sdk, { recursive: true })
    const entry = path.join(sdk, 'sdk.mjs')
    const exports = SDK_EXPORTS.map(
      (name) => `export function ${name}() { return 'the SDK ${name}' }`,
    )
    await writeFile(entry, `${exports.join('\n')}\n`)
    const run = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, [path.join(bundle, 'probe.cjs'), entry], (error, stdout, stderr) =>
        resolve({ code: error ? Number(error.code) : 0, stdout, stderr }),
      )
    })
    expect(run).toEqual({ code: 0, stdout: 'the SDK query\n', stderr: '' })
  })
})
