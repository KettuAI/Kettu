import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connectPort } from '@shared/socket-port'
import {
  callControl,
  connectControl,
  ControlError,
  NotRunning,
  serveControl,
  type ControlConnection,
  type ControlEvent,
  type ControlHandlers,
  type ControlServer,
  type DaemonStatus,
  type DirectReport,
  type SshSetup,
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
const report: DirectReport = { port: 51234, own: [], status: null }
const SSH_SETUP: SshSetup = {
  publicKey: Buffer.alloc(32, 1).toString('base64'),
  name: 'devbox',
  platform: 'linux',
  version: '1.2.3',
  port: 52001,
}

function handlers(overrides: Partial<ControlHandlers> = {}): ControlHandlers {
  return {
    status: async () => status,
    'host.socket': async ({ host }) => ({ path: `/sockets/${host}` }),
    'devices.list': async () => [],
    'devices.remove': async ({ id }) => {
      throw new ControlError('not_found', `No device ${id}`)
    },
    'pair.open': async () => ({ codeId: 1 }),
    'pair.answer': async () => null,
    'direct.get': async () => report,
    'direct.port': async () => report,
    'direct.add': async () => report,
    'direct.remove': async () => report,
    'terminal.get': async () => ({ allowed: false }),
    'terminal.set': async ({ allowed }) => ({ allowed }),
    'ssh.setup': async () => SSH_SETUP,
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
    const id = 'ab'.repeat(16)
    const error = await callControl(socket, 'devices.remove', { id }).catch((e) => e)
    expect(error).toBeInstanceOf(ControlError)
    expect(error).toMatchObject({ code: 'not_found', message: `No device ${id}` })
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
    port.send({ type: 'request', id: 3, method: 'devices.remove', params: { id: 'ABC' } })
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

  it('sends a connection its events, answers it again and tells the handler once it goes', async () => {
    let closed = false
    const expired: ControlEvent = {
      type: 'pairing',
      codeId: 7,
      pairing: { state: 'void', reason: 'expired' },
    }
    server = await serveControl(
      socket,
      handlers({
        'pair.open': async (_, connection) => {
          connection.onClose(() => (closed = true))
          connection.notify(expired)
          return { codeId: 7 }
        },
      }),
      () => {},
    )
    const client = await connectControl(socket)
    const events: ControlEvent[] = []
    client.onEvent((event) => events.push(event))
    expect(await client.call('pair.open', undefined)).toEqual({ codeId: 7 })
    expect(events).toEqual([expired])
    expect(await client.call('status', undefined)).toEqual(status)
    expect(closed).toBe(false)
    client.close()
    while (!closed) await new Promise((resolve) => setTimeout(resolve, 10))
  })

  it("takes a pairing answer with the name kept as a device's, from the connection asked", async () => {
    const answers: unknown[] = []
    const connections = new Set<ControlConnection>()
    server = await serveControl(
      socket,
      handlers({
        'pair.answer': async (params, connection) => {
          answers.push(params)
          connections.add(connection)
          return null
        },
      }),
      () => {},
    )
    const client = await connectControl(socket)
    await client.call('pair.answer', { codeId: 1, add: true, name: ' My\u0007 iPad ' })
    await client.call('pair.answer', { codeId: 1, add: false, name: 'ignored' })
    await expect(
      client.call('pair.answer', { codeId: 1, add: true, name: ' \u0007 ' }),
    ).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(
      client.call('pair.answer', { codeId: 1.5, add: true, name: 'iPad' }),
    ).rejects.toMatchObject({ code: 'invalid_params' })
    client.close()
    expect(answers).toEqual([
      { codeId: 1, add: true, name: 'My iPad' },
      { codeId: 1, add: false, name: '' },
    ])
    expect(connections.size).toBe(1)
  })

  it('takes a port the owner may pick and an address as the app keeps it', async () => {
    const calls: unknown[] = []
    server = await serveControl(
      socket,
      handlers({
        'direct.port': async (params) => {
          calls.push(params)
          return report
        },
        'direct.add': async (params) => {
          calls.push(params)
          return report
        },
        'direct.remove': async (params) => {
          calls.push(params)
          return report
        },
      }),
      () => {},
    )
    const client = await connectControl(socket)
    expect(await client.call('direct.port', { port: 4567 })).toEqual(report)
    await client.call('direct.add', { host: 'fd00::1', port: 4567, extra: true } as never)
    await client.call('direct.remove', { host: 'frp.example.com', port: 60021 })
    for (const port of [1023, 65536, 4567.5, '4567']) {
      await expect(client.call('direct.port', { port } as never)).rejects.toMatchObject({
        code: 'invalid_params',
        message: 'Use a port from 1024 to 65535',
      })
    }
    for (const address of [
      { host: 'https://frp.example.com', port: 443 },
      { host: 'frp.example.com', port: 0 },
      { host: '[fd00::1]', port: 4567 },
      null,
    ]) {
      await expect(client.call('direct.add', address as never)).rejects.toMatchObject({
        code: 'invalid_params',
      })
    }
    await expect(
      client.call('direct.remove', { host: 'frp example.com', port: 1 }),
    ).rejects.toMatchObject({
      code: 'invalid_params',
      message: expect.stringMatching(/^Not an address: enter only a host name or IP address/),
    })
    client.close()
    expect(calls).toEqual([
      { port: 4567 },
      { host: 'fd00::1', port: 4567 },
      { host: 'frp.example.com', port: 60021 },
    ])
  })

  it('takes a device from SSH as pairing would add it, or none', async () => {
    const calls: unknown[] = []
    server = await serveControl(
      socket,
      handlers({
        'ssh.setup': async (params) => {
          calls.push(params)
          return SSH_SETUP
        },
      }),
      () => {},
    )
    const client = await connectControl(socket)
    const device = {
      publicKey: Buffer.alloc(32, 9).toString('base64'),
      name: ' Lin\u0007 MacBook ',
      kind: 'desktop',
      platform: 'macOS 26.1',
      model: 'Mac16,1',
    }
    expect(await client.call('ssh.setup', { device })).toEqual(SSH_SETUP)
    await client.call('ssh.setup', {} as never)
    for (const bad of [
      { ...device, publicKey: 'short' },
      { ...device, name: ' ' },
      { ...device, model: 'a\nb' },
      'device',
    ]) {
      await expect(client.call('ssh.setup', { device: bad } as never)).rejects.toMatchObject({
        code: 'invalid_params',
      })
    }
    client.close()
    expect(calls).toEqual([{ device: { ...device, name: 'Lin MacBook' } }, { device: null }])
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
