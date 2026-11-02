import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatus } from '@shared/agent-host'
import { hostSettingsPart, type HostSettingsPart } from '@shared/remote/host-admin'
import { DEFAULT_SETTINGS, type SettingsPatch } from '@shared/settings'

const hostsRequest = vi.fn()
const localUpdate = vi.fn()
vi.stubGlobal('window', {
  kettu: {
    hosts: { request: hostsRequest },
    settings: { update: localUpdate },
  },
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
})

const { hostScope, hostScopeEvent, hostScopeOpened } = await import('./host-scope')
const { useSettingsStore } = await import('./settings')

const devBox = 'a'.repeat(32)

/** The host's part with background fetch as given, as the host would answer. */
function part(fetch: boolean): HostSettingsPart {
  const own = hostSettingsPart(DEFAULT_SETTINGS)
  return { ...own, git: { ...own.git, backgroundFetch: fetch } }
}

const agent = (id: string): AgentStatus => ({ id, name: id, isDefault: true }) as AgentStatus

/** Answers the reads a new scope makes; `settings.get` with `fetch`, the rest empty. */
function answer(fetch: boolean) {
  hostsRequest.mockImplementation((_hostId: string, method: string, params: unknown) => {
    switch (method) {
      case 'settings.get':
        return Promise.resolve(part(fetch))
      case 'settings.update':
        return Promise.resolve(
          part((params as { patch: SettingsPatch }).patch.git?.backgroundFetch ?? fetch),
        )
      case 'host.info':
        return Promise.resolve({ sharing: false })
      case 'agents.list':
        return Promise.resolve([agent('codex')])
      case 'remote.status':
        return Promise.resolve({ state: 'on', devices: [], online: [] })
      default:
        return Promise.resolve(null)
    }
  })
}

describe('host scope', () => {
  beforeEach(() => {
    hostsRequest.mockReset()
    localUpdate.mockReset()
  })

  it("reads another host's part and keeps this window's own keys", async () => {
    answer(true)
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, appearance: { ...DEFAULT_SETTINGS.appearance, zoom: 1.25 } },
    })
    const scope = hostScope(devBox)
    await vi.waitFor(() => expect(scope.useSettingsStore.getState().loaded).toBe(true))
    const { settings } = scope.useSettingsStore.getState()
    expect(settings.git.backgroundFetch).toBe(true)
    expect(settings.appearance.zoom).toBe(1.25)
    expect(hostsRequest).toHaveBeenCalledWith(devBox, 'agents.list', undefined)
    await vi.waitFor(() => expect(scope.useAgentsStore.getState().order).toEqual(['codex']))
    expect(scope.useRemoteStore.getState().status?.state).toBe('on')
  })

  it("writes the host's keys on the host and this window's here", async () => {
    answer(false)
    const scope = hostScope(devBox)
    localUpdate.mockResolvedValue(DEFAULT_SETTINGS)
    await scope.useSettingsStore.getState().update({
      git: { backgroundFetch: false },
      appearance: { zoom: 1.1 },
    })
    expect(hostsRequest).toHaveBeenCalledWith(devBox, 'settings.update', {
      patch: { git: { backgroundFetch: false } },
    })
    expect(localUpdate).toHaveBeenCalledWith({ appearance: { zoom: 1.1 } })
    expect(scope.useSettingsStore.getState().settings.git.backgroundFetch).toBe(false)
  })

  it("follows the host's events and reads it again when its session opens", async () => {
    answer(false)
    const scope = hostScope(devBox)
    hostScopeEvent(devBox, { type: 'settings.changed', settings: part(true) })
    expect(scope.useSettingsStore.getState().settings.git.backgroundFetch).toBe(true)
    hostScopeEvent(devBox, { type: 'agent.status', status: agent('claude-code') })
    expect(scope.useAgentsStore.getState().byId['claude-code']).toBeDefined()
    hostsRequest.mockClear()
    hostScopeOpened(devBox)
    await vi.waitFor(() =>
      expect(hostsRequest).toHaveBeenCalledWith(devBox, 'settings.get', undefined),
    )
  })

  it('leaves a host Settings has not shown alone', () => {
    hostScopeEvent('b'.repeat(32), { type: 'settings.changed', settings: part(true) })
    hostScopeOpened('b'.repeat(32))
    expect(hostsRequest).not.toHaveBeenCalled()
  })
})
