// Process test: the terminal host under plain Node.js, through node-main.ts. It is forked, takes
// one port over its socket, and runs a shell that prints a line and exits.

import { fork, type ChildProcess } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MainToTerminalHost, TerminalHostToMain } from '@shared/host-control'
import type { PortChannel } from '@shared/port-channel'
import type { FromPort } from '@shared/port-rpc'
import { connectPort, privateSocketPath, type SocketPath } from '@shared/socket-port'
import type {
  TerminalEvent,
  TerminalInfo,
  TerminalMethod,
  TerminalParams,
  TerminalResult,
} from '@shared/terminal-host'

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const isWindows = process.platform === 'win32'

let dir: string | null = null
let bundle = ''
let socket: SocketPath | null = null
let child: ChildProcess | null = null
let client: PortChannel | null = null

beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kettu-node-terminal-')))
  bundle = path.join(dir, 'bundle')
  // node-pty is native, so the bundle loads it from this checkout.
  const nodePty = createRequire(import.meta.url).resolve('node-pty')
  await build({
    configFile: false,
    logLevel: 'silent',
    root,
    resolve: { alias: { '@shared': path.join(root, 'src/shared') } },
    ssr: { noExternal: true },
    plugins: [
      {
        name: 'node-pty-from-checkout',
        enforce: 'pre',
        resolveId: (id) => (id === 'node-pty' ? { id: nodePty, external: 'absolute' } : null),
      },
    ],
    build: {
      ssr: path.join(root, 'src/terminal-host/node-main.ts'),
      outDir: bundle,
      emptyOutDir: true,
      minify: false,
      rolldownOptions: {
        external: [/^node:/],
        output: { format: 'cjs', entryFileNames: 'node-main.cjs', dynamicImportInCjs: false },
      },
    },
  })
}, 120_000)

afterAll(async () => {
  client?.close()
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await socket?.remove()
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

describe('the terminal host under Node.js', () => {
  it('takes a port over its socket and runs a shell in it', async () => {
    socket = await privateSocketPath('terminal-host')
    const sent: TerminalHostToMain[] = []
    let output = ''
    child = fork(path.join(bundle, 'node-main.cjs'), [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    child.stdout!.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.on('message', (message) => sent.push(message as TerminalHostToMain))
    const exited = new Promise<number | null>((resolve) => child!.once('exit', resolve))
    const until = async (check: () => boolean, what: string): Promise<void> => {
      const started = Date.now()
      while (!check()) {
        if (child!.exitCode !== null) throw new Error(`The host exited before ${what}\n${output}`)
        if (Date.now() - started > 15_000) throw new Error(`No ${what}\n${output}`)
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }

    const shell = isWindows ? path.join(process.env.SystemRoot!, 'System32', 'cmd.exe') : '/bin/sh'
    child.send({
      type: 'terminal-host:init',
      platform: process.platform,
      appVersion: '0.0.0-test',
      settings: { shellPath: shell, fontSize: 13, allowDevices: false },
      projects: [dir!],
      authCommands: [],
      socketPath: socket.path,
    } satisfies MainToTerminalHost)
    await until(() => sent.some((message) => message.type === 'terminal-host:ready'), 'ready')

    client = await connectPort(socket.path)
    const events: TerminalEvent[] = []
    const pending = new Map<number, (message: FromPort<TerminalEvent>) => void>()
    let nextId = 1
    client.onMessage((data) => {
      const message = data as FromPort<TerminalEvent>
      if (message.type === 'event') events.push(message.event)
      else pending.get(message.id)?.(message)
    })
    const request = <M extends TerminalMethod>(
      method: M,
      params: TerminalParams<M>,
    ): Promise<TerminalResult<M>> => {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, (message) => {
          if (message.type === 'response') resolve(message.result as TerminalResult<M>)
          else if (message.type === 'error') reject(new Error(message.error.message))
        })
        client!.send({ type: 'request', id, method, params })
      })
    }

    const { id } = await request('terminals.create', { projectPath: dir!, cols: 80, rows: 24 })
    // The typed text and its output differ, so only the shell's own output matches.
    const command = isWindows ? 'echo over^bench & exit 3' : 'echo "over""bench"; exit 3'
    await request('terminals.input', { id, data: `${command}\r` })
    const printed = (): string =>
      events.flatMap((event) => (event.type === 'terminal.data' ? [event.data] : [])).join('')
    await until(() => printed().includes('overbench'), 'output')
    const info = (): TerminalInfo | undefined =>
      events.findLast(
        (event): event is Extract<TerminalEvent, { type: 'terminal.info' }> =>
          event.type === 'terminal.info' && event.info.id === id,
      )?.info
    await until(() => info()?.exitCode !== null && info()?.exitCode !== undefined, 'exit')
    expect(info()).toMatchObject({ id, projectPath: dir, exitCode: 3 })

    child.send({ type: 'terminal-host:shutdown' } satisfies MainToTerminalHost)
    expect(await exited).toBe(0)
    expect(sent.at(-1)).toEqual({ type: 'terminal-host:stopped' })
  }, 30_000)
})
