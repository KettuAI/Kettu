import inspector from 'node:inspector'
import { connect } from 'node:net'
import os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { INSPECT_ENV, openInspector, startHostInspector } from './debug-inspector'

/** Whether something accepts a TCP connection at `host`:`port`. */
function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

/** An IPv4 address of this computer's own that is not a loopback one, if it has any. */
function outsideAddress(): string | null {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address
    }
  }
  return null
}

afterEach(() => {
  inspector.close()
  delete process.env[INSPECT_ENV]
  vi.unstubAllGlobals()
})

describe('openInspector', () => {
  it('listens on 127.0.0.1 only', async () => {
    const url = new URL(openInspector())
    expect(url.protocol).toBe('ws:')
    expect(url.hostname).toBe('127.0.0.1')
    const port = Number(url.port)
    expect(await reachable('127.0.0.1', port)).toBe(true)
    const outside = outsideAddress()
    if (outside) expect(await reachable(outside, port)).toBe(false)
  })
})

describe('startHostInspector', () => {
  const parentPort = (): { postMessage: ReturnType<typeof vi.fn> } => {
    const port = { postMessage: vi.fn() }
    Object.defineProperty(process, 'parentPort', { value: port, configurable: true })
    return port
  }

  afterEach(() => {
    Reflect.deleteProperty(process, 'parentPort')
  })

  it('opens nothing unless the parent asked', () => {
    const port = parentPort()
    startHostInspector()
    expect(inspector.url()).toBeUndefined()
    expect(port.postMessage).not.toHaveBeenCalled()
  })

  it('opens on 127.0.0.1 when asked, tells the parent, and keeps the request from its children', () => {
    const port = parentPort()
    process.env[INSPECT_ENV] = '1'
    startHostInspector()
    expect(process.env[INSPECT_ENV]).toBeUndefined()
    const url = inspector.url()
    expect(url && new URL(url).hostname).toBe('127.0.0.1')
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'debug:inspector', url })
  })
})
