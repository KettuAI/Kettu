import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({ fork: (): unknown => null }))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => ({ id: 7 }) },
  MessageChannelMain: class {
    port1 = { side: 'host' }
    port2 = { side: 'page' }
  },
  utilityProcess: { fork: () => electron.fork() },
}))

const { UtilityHost } = await import('./utility-host')

class FakeChild extends EventEmitter {
  pid = 42
  stdout = null
  stderr = null
  posted: { type: string }[] = []
  postMessage(message: { type: string }): void {
    this.posted.push(message)
    if (message.type === 'shutdown') setImmediate(() => this.emit('exit', 0))
  }
  kill(): boolean {
    this.emit('exit', 0)
    return true
  }
}

class FakeContents extends EventEmitter {
  sent: [string, unknown][] = []
  ports: string[] = []
  constructor(readonly id: number) {
    super()
  }
  isDestroyed(): boolean {
    return false
  }
  send(channel: string, payload: unknown): void {
    this.sent.push([channel, payload])
  }
  postMessage(channel: string): void {
    this.ports.push(channel)
  }
}

let children: FakeChild[] = []
electron.fork = () => {
  const child = new FakeChild()
  children.push(child)
  return child
}

const hosts: InstanceType<typeof UtilityHost>[] = []

function makeHost(): InstanceType<typeof UtilityHost> {
  const host = new UtilityHost<{ type: string }, { type: string }>({
    label: 'test-host',
    channel: 'agent-host',
    modulePath: '/host.js',
    serviceName: 'Test Host',
    initMessage: () => ({ type: 'init' }),
    connectMessage: () => ({ type: 'connect' }),
    shutdownMessage: { type: 'shutdown' },
    readyType: 'ready',
    stoppedType: 'stopped',
    onMessage: () => {},
  })
  hosts.push(host)
  return host
}

const page = (id: number): FakeContents => new FakeContents(id)
const asContents = (contents: FakeContents): WebContents => contents as unknown as WebContents

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()))
  children = []
})

describe('UtilityHost.revoke', () => {
  it("sends a failed reset to the page's port", () => {
    const host = makeHost()
    const contents = page(1)
    host.connect(asContents(contents))
    children[0]?.emit('message', { type: 'ready' })
    expect(contents.ports).toEqual(['agent-host:port'])

    host.revoke(asContents(contents))
    expect(contents.sent).toEqual([['agent-host:reset', { failed: true }]])
  })

  it('drops a connect that still waits for the process', () => {
    const host = makeHost()
    const revoked = page(1)
    const kept = page(2)
    host.connect(asContents(revoked))
    host.connect(asContents(kept))
    host.revoke(asContents(revoked))
    children[0]?.emit('message', { type: 'ready' })

    expect(revoked.ports).toEqual([])
    expect(revoked.sent).toEqual([['agent-host:reset', { failed: true }]])
    expect(kept.ports).toEqual(['agent-host:port'])
    expect(children[0]?.posted.filter((message) => message.type === 'connect')).toHaveLength(1)
  })

  it('hands a new port to the page when it connects again', () => {
    const host = makeHost()
    const contents = page(1)
    host.connect(asContents(contents))
    children[0]?.emit('message', { type: 'ready' })
    host.revoke(asContents(contents))
    host.connect(asContents(contents))
    expect(contents.ports).toEqual(['agent-host:port', 'agent-host:port'])
  })
})
