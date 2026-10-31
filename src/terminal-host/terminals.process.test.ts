// Spawns a real shell through node-pty, the way the terminal host does.

import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TerminalInfo } from '@shared/terminal-host'
import { ProjectRegistry } from './projects'
import { type PtySpawn, TerminalManager } from './terminals'

const isWindows = process.platform === 'win32'

async function loadPty(): Promise<PtySpawn> {
  const pty = await import('node-pty')
  return (file, args, options) => pty.spawn(file, args, options)
}

function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error('Timed out'))
      }
    }, 20)
  })
}

describe('TerminalManager with node-pty', () => {
  let dir: string | null = null
  let manager: TerminalManager | null = null

  afterEach(async () => {
    manager?.dispose()
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = null
  })

  it('runs a shell in the project folder, streams its output and reports its exit', async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'kettu-pty-')))
    const projects = new ProjectRegistry(process.platform)
    projects.set([dir])
    let output = ''
    let info: TerminalInfo | null = null
    const terminals = new TerminalManager({
      platform: process.platform,
      appVersion: '0.0.0-test',
      env: process.env,
      projects,
      loadPty,
      sink: {
        data: (_, data) => {
          output += data
        },
        info: (next) => {
          info = next
        },
        replay: () => {},
        removed: () => {},
      },
    })
    manager = terminals
    terminals.setShellPath(
      isWindows ? join(process.env.SystemRoot!, 'System32', 'cmd.exe') : '/bin/sh',
    )
    const { id } = await terminals.create('p1', { projectPath: dir, cols: 80, rows: 24 })

    // The typed text and its output differ, so only the shell's own output matches.
    const command = isWindows ? 'echo over^bench & cd' : 'echo "over""bench"; pwd'
    terminals.input(id, `${command}\r`)
    const cwd = isWindows ? dir.toLowerCase() : dir
    const seen = (): string => (isWindows ? output.toLowerCase() : output)
    await waitFor(() => seen().includes('kettu') && seen().includes(cwd))

    terminals.input(id, 'exit 7\r')
    await waitFor(() => info?.exitCode !== null && info?.exitCode !== undefined)
    expect(info!.exitCode).toBe(7)
  }, 20_000)
})
