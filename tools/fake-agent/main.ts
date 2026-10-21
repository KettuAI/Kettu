// Runs the fake agent over stdio: `node tools/fake-agent/main.ts`, or with Electron's own
// Node.js through ELECTRON_RUN_AS_NODE=1. `--login` performs the terminal sign-in instead.

import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { ndJsonStream } from '@agentclientprotocol/sdk/unstable'
import { createFakeAgent, loginMarkerPath } from './agent.ts'

const env = process.env

function log(line: string): void {
  process.stderr.write(`${line}\n`)
}

if (process.argv.includes('--login')) {
  writeFileSync(loginMarkerPath(env), new Date().toISOString())
  process.stdout.write('Signed in to the fake agent. You can go back to OverBench.\n')
  process.exit(0)
}

if (env.FAKE_AGENT_IGNORE_SIGTERM === '1')
  process.on('SIGTERM', () => log('fake-agent: ignoring SIGTERM'))

if (env.FAKE_AGENT_SPAWN_CHILD === '1') {
  const script =
    env.FAKE_AGENT_IGNORE_SIGTERM === '1'
      ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
      : 'setInterval(() => {}, 1000)'
  const child = spawn(process.execPath, ['-e', script], {
    stdio: 'ignore',
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
  })
  log(`fake-agent: child pid ${child.pid}`)
}

const connection = createFakeAgent({ env, log }).connect(
  ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ),
)
log(`fake-agent: ready, pid ${process.pid}`)

void connection.closed.then(() => {
  if (env.FAKE_AGENT_IGNORE_EOF === '1') {
    log('fake-agent: stdin closed, staying alive')
    setInterval(() => {}, 1000)
    return
  }
  process.exit(0)
})
