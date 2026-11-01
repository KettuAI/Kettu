import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type SettingsFile } from '../settings'
import {
  hostSettingsPart,
  isHostAdminEvent,
  isHostAdminMethod,
  splitSettingsPatch,
  withHostSettings,
} from './host-admin'

function file(change: (settings: SettingsFile) => void): SettingsFile {
  const settings = structuredClone(DEFAULT_SETTINGS)
  change(settings)
  return settings
}

describe("the host's part of the settings", () => {
  it('holds what takes effect on the host and nothing a client keeps', () => {
    const host = file((s) => {
      s.general.sessionTitles = false
      s.general.sendKey = 'mod-enter'
      s.terminal.shellPath = '/bin/zsh'
      s.terminal.fontSize = 14
      s.usage.fromComputer = false
      s.usage.sidebar = 'cost'
      s.git.backgroundFetch = false
    })
    const part = hostSettingsPart(host)
    expect(part.general).toEqual({ sessionTitles: false })
    expect(part.terminal).toEqual({ shellPath: '/bin/zsh' })
    expect(part.usage).toEqual({ fromComputer: false })
    expect(part.git).toEqual({ backgroundFetch: false })
    expect(part).not.toHaveProperty('appearance')
    expect(part).not.toHaveProperty('notifications')
  })

  it("puts the host's part over a client's file, keeping the client's own rows", () => {
    const client = file((s) => {
      s.general.sendKey = 'mod-enter'
      s.terminal.fontSize = 12
      s.terminal.shellPath = '/stale/shell'
      s.usage.sidebar = 'limit'
    })
    const host = file((s) => {
      s.general.sessionTitles = false
      s.usage.fromComputer = true
      s.remote.terminal = true
    })
    const merged = withHostSettings(client, hostSettingsPart(host))
    expect(merged.general.sendKey).toBe('mod-enter')
    expect(merged.general.sessionTitles).toBe(false)
    expect(merged.terminal).toEqual({ fontSize: 12 })
    expect(merged.usage).toEqual({ fromComputer: true, sidebar: 'limit' })
    expect(merged.remote.terminal).toBe(true)
  })

  it('splits a patch into what the host keeps and what the client keeps', () => {
    expect(
      splitSettingsPatch({
        general: { sessionTitles: false, sendKey: 'enter' },
        terminal: { shellPath: null, fontSize: 13 },
        remote: { terminal: true },
        appearance: { theme: 'dark' },
      }),
    ).toEqual({
      host: {
        general: { sessionTitles: false },
        terminal: { shellPath: null },
        remote: { terminal: true },
      },
      client: {
        general: { sendKey: 'enter' },
        terminal: { fontSize: 13 },
        appearance: { theme: 'dark' },
      },
    })
    expect(splitSettingsPatch({ appearance: { textSize: 'large' } })).toEqual({
      host: null,
      client: { appearance: { textSize: 'large' } },
    })
  })

  it('names its methods and events and nothing else', () => {
    expect(isHostAdminMethod('settings.update')).toBe(true)
    expect(isHostAdminMethod('sessions.create')).toBe(false)
    expect(isHostAdminMethod('toString')).toBe(false)
    expect(isHostAdminEvent({ type: 'settings.changed' })).toBe(true)
    expect(isHostAdminEvent({ type: 'session.summary' })).toBe(false)
  })
})
