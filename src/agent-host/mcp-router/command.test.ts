import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Platform } from '@shared/platform'
import { AgentTrees } from '../agent-trees'
import { processControl } from '../process-tree'
import { agentProcessesFile } from '../storage'
import { startCommand } from './command'

const platform = process.platform as Platform

// Answers initialize, starts a long-lived child of its own and writes the child's pid; with
// `stubborn` it ignores EOF and SIGTERM-free shutdown requests, as a hung server would.
const SERVER = `
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const child = spawn('sleep', ['300'], { stdio: 'ignore' })
fs.writeFileSync(process.argv[2], String(child.pid))
const stubborn = process.argv[3] === 'stubborn'
process.stdin.on('data', (chunk) => {
  for (const line of chunk.toString().split('\\n').filter(Boolean)) {
    const message = JSON.parse(line)
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n')
  }
})
process.stdin.on('end', () => { if (!stubborn) process.exit(0) })
`

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function gone(pid: number, ms = 5_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (!alive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !alive(pid)
}

let dir: string
let trees: AgentTrees
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kettu-command-'))
  await writeFile(path.join(dir, 'server.cjs'), SERVER)
  trees = new AgentTrees({
    file: agentProcessesFile(dir, () => {}),
    control: processControl(platform),
    graceMs: 300,
    log: () => {},
  })
})
afterEach(async () => {
  await trees.close()
  await rm(dir, { recursive: true, force: true })
})

describe.skipIf(platform === 'win32')('a command server stopped by the router', () => {
  const timings = { eofMs: 300, termMs: 500 }

  async function started(stubborn: boolean) {
    const pidFile = path.join(dir, 'child.pid')
    // Through a shell, as a wrapper script starts a server: what stops must be the whole tree.
    const script = `exec_node() { "${process.execPath}" "$@"; }; exec_node server.cjs ${pidFile}${stubborn ? ' stubborn' : ''}`
    const transport = await startCommand(
      'wrapped',
      { command: 'sh', args: ['-c', script], env: { PATH: process.env.PATH ?? '' } },
      dir,
      { platform, trees, timings },
      () => {},
    )
    const answered = new Promise((resolve) => (transport.onmessage = resolve))
    await transport.start()
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    await answered
    const child = Number(await readFile(pidFile, 'utf8'))
    expect(alive(child)).toBe(true)
    return { transport, child }
  }

  it('leaves nothing the wrapper started running once a server that exits on EOF stops', async () => {
    const { transport, child } = await started(false)
    await transport.close()
    expect(await gone(child)).toBe(true)
  })

  it('ends the whole tree of a server that does not exit on EOF', async () => {
    const { transport, child } = await started(true)
    await transport.close()
    expect(await gone(child)).toBe(true)
  })
})
