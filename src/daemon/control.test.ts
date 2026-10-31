import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connectPort } from '@shared/socket-port'
import {
  callControl,
  ControlError,
  NotRunning,
  serveControl,
  type ControlHandlers,
  type ControlServer,
  type DaemonStatus,
} from './control'

// The control socket is a Unix socket, which the daemon has only on macOS and Linux.
const describeUnix = describe.skipIf(process.platform === 'win32')

let dir = ''
let socket = ''
let server: ControlServer | null = null

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-control-'))
  socket = path.join(dir, 'control.sock')
})

afterEach(async () => {
  await server?.close()
  server = null
  await rm(dir, { recursive: true, force: true })
})

const status = { version: '1.2.3', pid: 1 } as DaemonStatus

function handlers(overrides: Partial<ControlHandlers> = {}): ControlHandlers {
  return {
    status: async () => status,
    'host.socket': async ({ host }) => ({ path: `/sockets/${host}` }),
    'devices.list': async () => [],
    'devices.remove': async ({ id }) => {
      throw new ControlError('not_found', `No device ${id}`)
    },
    ...overrides,
  }
}

describeUnix('the control socket', () => {
  it('answers each method with its result', async () => {
    server = await serveControl(socket, handlers(), () => {})
    expect(await callControl(socket, 'status', undefined)).toEqual(status)
    expect(await callControl(socket, 'host.socket', { host: 'terminal' })).toEqual({
      path: '/sockets/terminal',
    })
    expect(await callControl(socket, 'devices.list', undefined)).toEqual([])
  })

  it("passes on a handler's error with its code", async () => {
    server = await serveControl(socket, handlers(), () => {})
    const error = await callControl(socket, 'devices.remove', { id: 'x' }).catch((e) => e)
    expect(error).toBeInstanceOf(ControlError)
    expect(error).toMatchObject({ code: 'not_found', message: 'No device x' })
  })

  it('hides what an unexpected failure says, and logs it', async () => {
    const warnings: string[] = []
    server = await serveControl(
      socket,
      handlers({
        status: async () => {
          throw new Error('secret detail')
        },
      }),
      (message) => warnings.push(message),
    )
    await expect(callControl(socket, 'status', undefined)).rejects.toMatchObject({
      code: 'internal',
      message: 'The daemon could not answer',
    })
    expect(warnings.join('\n')).toContain('secret detail')
  })

  it('refuses unknown methods and invalid params', async () => {
    server = await serveControl(socket, handlers(), () => {})
    const port = await connectPort(socket)
    const replies: unknown[] = []
    port.onMessage((data) => replies.push(data))
    port.send({ type: 'request', id: 1, method: 'host.restart', params: null })
    port.send({ type: 'request', id: 2, method: 'host.socket', params: { host: 'remote' } })
    port.send({ type: 'request', id: 3, method: 'devices.remove', params: { id: '' } })
    port.send({ type: 'request', id: 4, method: 'status', params: { all: true } })
    port.send({ type: 'request', id: 5, method: 'toString', params: null })
    while (replies.length < 5) await new Promise((resolve) => setTimeout(resolve, 10))
    port.close()
    expect(replies).toEqual([
      { type: 'error', id: 1, error: { code: 'unknown_method', message: expect.any(String) } },
      { type: 'error', id: 2, error: { code: 'invalid_params', message: expect.any(String) } },
      { type: 'error', id: 3, error: { code: 'invalid_params', message: expect.any(String) } },
      { type: 'error', id: 4, error: { code: 'invalid_params', message: expect.any(String) } },
      { type: 'error', id: 5, error: { code: 'unknown_method', message: expect.any(String) } },
    ])
  })

  it('throws NotRunning when nothing listens', async () => {
    await expect(callControl(socket, 'status', undefined)).rejects.toBeInstanceOf(NotRunning)
  })

  it('closes with a client that stays connected', async () => {
    server = await serveControl(socket, handlers(), () => {})
    const port = await connectPort(socket)
    let closed = false
    port.onClose(() => (closed = true))
    await server.close()
    server = null
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(closed).toBe(true)
    await expect(callControl(socket, 'status', undefined)).rejects.toBeInstanceOf(NotRunning)
  })
})
