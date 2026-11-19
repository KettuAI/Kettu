// Which interface an agent starts on when its harness has one of its own beside its protocol.

import { afterEach, describe, expect, it } from 'vitest'
import { CLINE } from './agents/cline'
import { OPENCODE } from './agents/opencode'
import type { AgentConnection } from './connection'
import { driverOf, preferredProtocol, protocolFor } from './drivers'
import type { HostedDriver } from './driver'
import { startTestHost, type TestHost } from './testing/harness'

describe('the preferred interface', () => {
  it('runs a version it was checked on', () => {
    expect(preferredProtocol(OPENCODE, '2.3.2', null, null)).toBe('opencode-server')
    expect(protocolFor(OPENCODE, {}, 'opencode-server')).toBe('opencode-server')
    expect(driverOf(OPENCODE, {}, 'opencode-server').kind).toBe('hosted')
  })

  it('gives way to the harness’s protocol for a version it was not checked on, or not read', () => {
    expect(preferredProtocol(OPENCODE, '2.0.32', null, null)).toBeNull()
    expect(preferredProtocol(OPENCODE, '2.4.0', null, null)).toBeNull()
    expect(preferredProtocol(OPENCODE, null, null, null)).toBeNull()
    expect(protocolFor(OPENCODE, {}, null)).toBe('acp')
    expect(driverOf(OPENCODE).kind).toBe('process')
  })

  it('gives way for a version the manifest holds back', () => {
    const rule = { kettu: '*', broken: [], sha256: {}, fallback: '>=2.3.2 <2.3.4' }
    expect(preferredProtocol(OPENCODE, '2.3.3', rule, null)).toBeNull()
    expect(preferredProtocol(OPENCODE, '2.3.4', rule, null)).toBe('opencode-server')
  })

  it('gives way for the version it failed to start on, until the program changes', () => {
    expect(preferredProtocol(OPENCODE, '2.3.2', null, '2.3.2')).toBeNull()
    expect(preferredProtocol(OPENCODE, '2.3.3', null, '2.3.2')).toBe('opencode-server')
  })

  it('is nothing for a harness with one interface', () => {
    expect(preferredProtocol({ ...OPENCODE, preferred: undefined }, '2.3.2', null, null)).toBeNull()
  })
})

describe('a start over the preferred interface', () => {
  let host: TestHost | null = null

  afterEach(async () => {
    await host?.stop()
    host = null
  })

  it('goes by the version of Kettu’s own install for a harness it installs from npm', async () => {
    expect(preferredProtocol(CLINE, '3.0.74', null, null)).toBe('cline-sdk')
    expect(preferredProtocol(CLINE, '3.0.73', null, null)).toBeNull()
    expect(preferredProtocol(CLINE, '3.1.0', null, null)).toBeNull()

    let tries = 0
    const failing: HostedDriver = {
      kind: 'hosted',
      connect: () => {
        tries++
        return {
          closed: new Promise<void>(() => {}),
          isClosed: false,
          close: () => {},
          initialize: () => Promise.reject(new Error('its SDK did not load')),
        } as unknown as AgentConnection
      },
    }
    host = await startTestHost({
      fakeAs: ['cline'],
      installedVersions: { cline: '3.0.74' },
      drivers: { 'cline-sdk': failing },
    })
    const window = host.connect()
    const { id } = await window.request('sessions.create', {
      agentId: 'cline',
      projectPath: host.project,
    })
    await window.open(id)
    await window.untilStatus(id, 'ready')
    // The launch named a version the SDK was checked on, so the start tried it first.
    expect(tries).toBe(1)
  })

  it('falls back to the harness’s protocol when it fails, and the session opens all the same', async () => {
    let tries = 0
    const failing: HostedDriver = {
      kind: 'hosted',
      connect: () => {
        tries++
        let closed = false
        return {
          closed: new Promise<void>(() => {}),
          get isClosed() {
            return closed
          },
          close: () => {
            closed = true
          },
          initialize: () => Promise.reject(new Error('its server did not start')),
        } as unknown as AgentConnection
      },
    }
    host = await startTestHost({
      fakeAs: ['opencode'],
      programVersions: { opencode: '2.3.2' },
      drivers: { 'opencode-server': failing },
    })
    const window = host.connect()
    const { id } = await window.request('sessions.create', {
      agentId: 'opencode',
      projectPath: host.project,
    })
    await window.open(id)
    await window.untilStatus(id, 'ready')
    expect(tries).toBe(1)

    // The fake agent answers over ACP, as the harness's own protocol.
    await window.request('sessions.prompt', {
      sessionId: id,
      content: [{ type: 'text', text: 'hello' }],
    })
    await window.until(() => window.entries(id).some((entry) => entry.kind === 'turn_end'))
    expect(window.entries(id).some((entry) => entry.kind === 'agent')).toBe(true)
  })
})
