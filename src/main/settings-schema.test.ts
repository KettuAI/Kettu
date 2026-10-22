import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type SettingsFile } from '@shared/settings'
import {
  changedSections,
  hostSettings,
  mergeSettings,
  parseSettingsFile,
  SettingsError,
  terminalSettings,
  validateSettingsPatch,
  withAgentBinary,
  withShellPath,
} from './settings-schema'

function defaults(): SettingsFile {
  return structuredClone(DEFAULT_SETTINGS)
}

describe('validateSettingsPatch', () => {
  it('accepts a partial change in every section', () => {
    const patch = {
      general: { language: 'zh-CN', sendKey: 'mod-enter', defaultAgent: 'codex' },
      appearance: { theme: 'dark', zoom: 1.25 },
      notifications: { sound: true },
      agents: { opencode: { binaryPath: null } },
      proxy: { mode: 'custom', url: 'http://proxy.local:8080', noProxy: 'localhost' },
      terminal: { fontSize: 14, shellPath: null },
      git: { backgroundFetch: true },
      updates: { automatic: 'notify' },
      privacy: { hideAccount: true },
    }
    expect(validateSettingsPatch(patch)).toEqual(patch)
  })

  it('accepts clearing the default agent', () => {
    expect(() => validateSettingsPatch({ general: { defaultAgent: null } })).not.toThrow()
  })

  it.each([
    [null, 'must be an object'],
    [[], 'must be an object'],
    [{ version: 2 }, 'Unknown setting "version"'],
    [{ colors: {} }, 'Unknown setting "colors"'],
    [{ general: { sendKey: 'shift-enter' } }, '"general.sendKey" must be one of'],
    [{ general: { language: 'zh-TW' } }, '"general.language" must be one of'],
    [{ general: { fontFamily: 'x' } }, 'Unknown setting "general.fontFamily"'],
    [{ general: 'enter' }, '"general" must be an object'],
    [{ appearance: { theme: 'sepia' } }, '"appearance.theme" must be one of'],
    [{ appearance: { zoom: 2 } }, '"appearance.zoom" must be one of'],
    [{ appearance: { zoom: '1.1' } }, '"appearance.zoom" must be one of'],
    [{ notifications: { badge: 'yes' } }, '"notifications.badge" must be a boolean'],
    [{ agents: { cursor: { binaryPath: null } } }, 'Unknown agent "agents.cursor"'],
    [{ agents: { codex: { binaryPath: '/bin/sh' } } }, 'can only be cleared with null'],
    [{ agents: { codex: { args: [] } } }, 'accepts only "binaryPath"'],
    [{ terminal: { shellPath: '/bin/zsh' } }, 'can only be cleared with null'],
    [{ terminal: { fontSize: 16 } }, '"terminal.fontSize" must be one of'],
    [{ terminal: { cursor: 'block' } }, 'Unknown setting "terminal.cursor"'],
    [{ proxy: { mode: 'system' } }, '"proxy.mode" must be one of'],
    [{ proxy: { mode: 'custom', url: 'ftp://x', noProxy: '' } }, 'must be a proxy URL'],
    [{ proxy: { mode: 'custom', url: 'not a url', noProxy: '' } }, 'must be a proxy URL'],
    [{ proxy: { mode: 'custom', url: 'http://p:1' } }, '"proxy.noProxy" must be a string'],
    [{ proxy: { mode: 'environment', url: 'http://p:1' } }, 'Unknown setting "proxy.url"'],
    [{ updates: { automatic: 'always' } }, '"updates.automatic" must be one of'],
    [{ privacy: { hideAccount: 'yes' } }, '"privacy.hideAccount" must be a boolean'],
    [{ privacy: { hideEmail: true } }, 'Unknown setting "privacy.hideEmail"'],
  ])('rejects %j', (patch, message) => {
    expect(() => validateSettingsPatch(patch)).toThrow(SettingsError)
    expect(() => validateSettingsPatch(patch)).toThrow(message)
  })

  it('reports every problem in one error', () => {
    expect(() =>
      validateSettingsPatch({ general: { sendKey: 1 }, appearance: { theme: 2 } }),
    ).toThrow(/general\.sendKey.*appearance\.theme/)
  })
})

describe('mergeSettings', () => {
  it('merges sections key by key without touching the input', () => {
    const current = defaults()
    const next = mergeSettings(current, { general: { sendKey: 'mod-enter' } })
    expect(next.general).toEqual({ ...DEFAULT_SETTINGS.general, sendKey: 'mod-enter' })
    expect(current.general.sendKey).toBe('enter')
  })

  it('replaces the proxy whole and trims it', () => {
    const custom = mergeSettings(defaults(), {
      proxy: { mode: 'custom', url: ' http://p:1 ', noProxy: ' localhost ' },
    })
    expect(custom.proxy).toEqual({ mode: 'custom', url: 'http://p:1', noProxy: 'localhost' })
    expect(mergeSettings(custom, { proxy: { mode: 'environment' } }).proxy).toEqual({
      mode: 'environment',
    })
  })

  it('clears executable paths with null', () => {
    const withPaths = withShellPath(withAgentBinary(defaults(), 'opencode', '/opt/oc'), '/bin/fish')
    expect(withPaths.agents.opencode).toEqual({ binaryPath: '/opt/oc' })
    expect(withPaths.terminal.shellPath).toBe('/bin/fish')
    const cleared = mergeSettings(withPaths, {
      agents: { opencode: { binaryPath: null } },
      terminal: { shellPath: null },
    })
    expect(cleared.agents).toEqual({})
    expect(cleared.terminal).toEqual({ fontSize: 13 })
  })

  it('keeps the shell path when only the font size changes', () => {
    const next = mergeSettings(withShellPath(defaults(), '/bin/fish'), {
      terminal: { fontSize: 12 },
    })
    expect(next.terminal).toEqual({ shellPath: '/bin/fish', fontSize: 12 })
  })
})

describe('parseSettingsFile', () => {
  it('fills missing keys with defaults', () => {
    const loaded = parseSettingsFile({ version: 1, appearance: { theme: 'light' } })
    expect(loaded.problems).toEqual([])
    expect(loaded.readOnly).toBe(false)
    expect(loaded.settings).toEqual({
      ...DEFAULT_SETTINGS,
      appearance: { ...DEFAULT_SETTINGS.appearance, theme: 'light' },
    })
  })

  it('reads stored executable paths', () => {
    const loaded = parseSettingsFile({
      version: 1,
      agents: { opencode: { binaryPath: '/opt/oc' } },
      terminal: { shellPath: '/bin/fish', fontSize: 12 },
    })
    expect(loaded.problems).toEqual([])
    expect(loaded.settings.agents).toEqual({ opencode: { binaryPath: '/opt/oc' } })
    expect(loaded.settings.terminal).toEqual({ shellPath: '/bin/fish', fontSize: 12 })
  })

  it('keeps valid values and reports invalid ones', () => {
    const loaded = parseSettingsFile({
      version: 1,
      general: { sendKey: 'mod-enter', restoreLastSession: 'yes' },
      proxy: { mode: 'custom', url: '', noProxy: '' },
      terminal: { fontSize: 99 },
    })
    expect(loaded.settings.general.sendKey).toBe('mod-enter')
    expect(loaded.settings.general.restoreLastSession).toBe(true)
    expect(loaded.settings.proxy).toEqual({ mode: 'environment' })
    expect(loaded.settings.terminal.fontSize).toBe(13)
    expect(loaded.problems).toHaveLength(3)
  })

  it.each([[null], ['text'], [[]], [{}], [{ version: '1' }], [{ version: 0 }]])(
    'treats %j as invalid',
    (raw) => {
      const loaded = parseSettingsFile(raw)
      expect(loaded.problems.length).toBeGreaterThan(0)
      expect(loaded.settings).toEqual(DEFAULT_SETTINGS)
    },
  )

  it('reads a newer version but marks it read-only', () => {
    const loaded = parseSettingsFile({ version: 2, appearance: { theme: 'dark' } })
    expect(loaded.readOnly).toBe(true)
    expect(loaded.settings.appearance.theme).toBe('dark')
  })

  it('ignores unknown keys', () => {
    const loaded = parseSettingsFile({ version: 1, future: { x: 1 }, general: { other: true } })
    expect(loaded.problems).toEqual([])
    expect(loaded.settings).toEqual(DEFAULT_SETTINGS)
  })
})

describe('derived settings', () => {
  it('splits out what each host receives', () => {
    const settings = withShellPath(withAgentBinary(defaults(), 'opencode', '/opt/oc'), '/bin/fish')
    expect(hostSettings(settings, 'zh-CN')).toEqual({
      locale: 'zh-CN',
      agents: { opencode: { binaryPath: '/opt/oc' } },
      proxy: { mode: 'environment' },
      git: { backgroundFetch: false },
    })
    expect(
      hostSettings({ ...settings, general: { ...settings.general, language: 'en' } }, 'zh-CN')
        .locale,
    ).toBe('en')
    expect(terminalSettings(settings)).toEqual({ shellPath: '/bin/fish', fontSize: 13 })
    expect(terminalSettings(defaults()).shellPath).toBeNull()
  })

  it('names the sections that changed', () => {
    const before = defaults()
    const after = mergeSettings(before, {
      appearance: { theme: 'dark' },
      proxy: { mode: 'custom', url: 'http://p:1', noProxy: '' },
    })
    expect([...changedSections(before, after)].sort()).toEqual(['appearance', 'proxy'])
    expect(changedSections(before, structuredClone(before)).size).toBe(0)
  })
})
