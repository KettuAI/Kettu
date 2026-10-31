import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type AddedAgent, type SettingsFile } from '@shared/settings'
import {
  changedSections,
  reachesHost,
  hostSettings,
  mergeSettings,
  parseSettingsFile,
  SettingsError,
  terminalSettings,
  validateSettingsPatch,
  agentName,
  withAddedAgent,
  withAgentBinary,
  withoutAgent,
  withRenamedAgent,
  withShellPath,
} from './settings-schema'

function defaults(): SettingsFile {
  return structuredClone(DEFAULT_SETTINGS)
}

describe('validateSettingsPatch', () => {
  it('accepts a partial change in every section', () => {
    const patch = {
      general: {
        language: 'zh-CN',
        sendKey: 'mod-enter',
        defaultAgent: 'codex',
        openAtLogin: true,
      },
      appearance: { theme: 'dark', colorTheme: 'rose-pine', zoom: 1.25 },
      notifications: { sound: true },
      agents: { opencode: { binaryPath: null }, codex: { hidden: true } },
      proxy: { mode: 'custom', url: 'http://proxy.local:8080', noProxy: 'localhost' },
      terminal: { fontSize: 14, shellPath: null },
      git: { backgroundFetch: true },
      updates: { automatic: 'notify' },
      privacy: { hideAccount: true },
      remote: { enabled: true },
    }
    expect(validateSettingsPatch(patch)).toEqual(patch)
  })

  it('accepts clearing the default agent', () => {
    expect(() => validateSettingsPatch({ general: { defaultAgent: null } })).not.toThrow()
  })

  it('accepts turning off the confirmation before links open', () => {
    expect(validateSettingsPatch({ thread: { confirmLinks: false } })).toEqual({
      thread: { confirmLinks: false },
    })
  })

  it("accepts today's cost as what the sidebar shows", () => {
    expect(validateSettingsPatch({ usage: { sidebar: 'cost' } })).toEqual({
      usage: { sidebar: 'cost' },
    })
  })

  it('accepts installing updates only on a restart', () => {
    expect(validateSettingsPatch({ updates: { automatic: 'restart' } })).toEqual({
      updates: { automatic: 'restart' },
    })
  })

  it('takes the agents Kettu’s server is off for, each once', () => {
    expect(validateSettingsPatch({ mcp: { kettu: { off: ['codex', 'claude-code'] } } })).toEqual({
      mcp: { kettu: { off: ['codex', 'claude-code'] } },
    })
    expect(validateSettingsPatch({ mcp: { kettu: { off: [] } } })).toEqual({
      mcp: { kettu: { off: [] } },
    })
  })

  it.each([
    [null, 'must be an object'],
    [[], 'must be an object'],
    [{ version: 2 }, 'Unknown setting "version"'],
    [{ colors: {} }, 'Unknown setting "colors"'],
    [{ general: { sendKey: 'shift-enter' } }, '"general.sendKey" must be one of'],
    [{ general: { language: 'zh-TW' } }, '"general.language" must be one of'],
    [{ general: { fontFamily: 'x' } }, 'Unknown setting "general.fontFamily"'],
    [{ general: { openAtLogin: 'yes' } }, '"general.openAtLogin" must be a boolean'],
    [{ general: { background: 'on' } }, '"general.background" must be a boolean'],
    [{ general: 'enter' }, '"general" must be an object'],
    [{ thread: { confirmLinks: 'no' } }, '"thread.confirmLinks" must be a boolean'],
    [{ appearance: { theme: 'sepia' } }, '"appearance.theme" must be one of'],
    [{ appearance: { colorTheme: '../nord' } }, '"appearance.colorTheme" must be a theme id'],
    [{ appearance: { colorTheme: 'Nord' } }, '"appearance.colorTheme" must be a theme id'],
    [{ appearance: { colorTheme: '' } }, '"appearance.colorTheme" must be a theme id'],
    [{ appearance: { colorTheme: null } }, '"appearance.colorTheme" must be a theme id'],
    [{ appearance: { zoom: 2 } }, '"appearance.zoom" must be one of'],
    [{ appearance: { zoom: '1.1' } }, '"appearance.zoom" must be one of'],
    [{ notifications: { badge: 'yes' } }, '"notifications.badge" must be a boolean'],
    [{ agents: { unknown: { binaryPath: null } } }, 'Unknown harness "agents.unknown"'],
    [{ agents: { codex: { binaryPath: '/bin/sh' } } }, 'can only be cleared with null'],
    [{ agents: { codex: { args: [] } } }, 'accepts only "binaryPath", "configDir" and "hidden"'],
    [
      { agents: { codex: { cli: 'bundled' } } },
      'accepts only "binaryPath", "configDir" and "hidden"',
    ],
    [{ agents: { codex: { configDir: '/srv/codex' } } }, 'can only be cleared with null'],
    [{ agents: { codex: { hidden: 'yes' } } }, '"agents.codex.hidden" must be a boolean'],
    [{ agents: { 'codex~work': { hidden: true } } }, 'Unknown harness "agents.codex~work"'],
    [{ addedAgents: [] }, 'Unknown setting "addedAgents"'],
    [{ general: { defaultAgent: 'codex~' } }, '"general.defaultAgent" must be an agent id'],
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
    [{ remote: { enabled: 'on' } }, '"remote.enabled" must be a boolean'],
    [{ privacy: { hideEmail: true } }, 'Unknown setting "privacy.hideEmail"'],
    [{ mcp: { kettu: { off: ['unknown-agent'] } } }, '"mcp.kettu.off" names an unknown agent'],
    [{ mcp: { kettu: { off: ['codex', 'codex'] } } }, '"mcp.kettu.off" names an agent twice'],
    [{ mcp: { kettu: { off: 'codex' } } }, '"mcp.kettu.off" must be an array'],
    [{ mcp: { kettu: { on: [] } } }, 'Unknown setting "mcp.kettu.on"'],
    [{ mcp: { off: [] } }, 'Unknown setting "mcp.off"'],
    [{ mcp: [] }, '"mcp" must be an object'],
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

  it('hides a default agent and shows it again, beside its binary', () => {
    const hidden = mergeSettings(withAgentBinary(defaults(), 'codex', '/opt/codex'), {
      agents: { codex: { hidden: true } },
    })
    expect(hidden.agents.codex).toEqual({ binaryPath: '/opt/codex', hidden: true })
    expect(mergeSettings(hidden, { agents: { codex: { hidden: false } } }).agents).toEqual({
      codex: { binaryPath: '/opt/codex' },
    })
    const cleared = mergeSettings(hidden, { agents: { codex: { binaryPath: null } } })
    expect(cleared.agents).toEqual({ codex: { hidden: true } })
  })

  it('clears a folder chosen before agents could be added, and only with null', () => {
    const { settings } = parseSettingsFile({
      version: 1,
      agents: { 'claude-code': { configDir: '/srv/claude', hidden: true } },
    })
    const patch = validateSettingsPatch({ agents: { 'claude-code': { configDir: null } } })
    expect(mergeSettings(settings, patch).agents).toEqual({ 'claude-code': { hidden: true } })
  })

  it('keeps the shell path when only the font size changes', () => {
    const next = mergeSettings(withShellPath(defaults(), '/bin/fish'), {
      terminal: { fontSize: 12 },
    })
    expect(next.terminal).toEqual({ shellPath: '/bin/fish', fontSize: 12 })
  })

  it('replaces the list of agents the server is off for whole', () => {
    const off = mergeSettings(defaults(), { mcp: { kettu: { off: ['codex', 'pi'] } } })
    expect(off.mcp).toEqual({ kettu: { off: ['codex', 'pi'] } })
    expect(mergeSettings(off, { mcp: { kettu: { off: [] } } }).mcp).toEqual({
      kettu: { off: [] },
    })
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
    expect(loaded.settings.appearance.colorTheme).toBe('kettu')
  })

  it('reads a stored thread setting without the link one as asking', () => {
    const loaded = parseSettingsFile({ version: 1, thread: { outlineSummaries: false } })
    expect(loaded.problems).toEqual([])
    expect(loaded.settings.thread).toEqual({ outlineSummaries: false, confirmLinks: true })
  })

  it('reads the chosen theme, keeping the built-in one for an id that is not one', () => {
    const read = (colorTheme: unknown) =>
      parseSettingsFile({ version: 1, appearance: { colorTheme } })
    expect(read('rose-pine').settings.appearance.colorTheme).toBe('rose-pine')
    expect(read('../x').settings.appearance.colorTheme).toBe('kettu')
    expect(read('../x').problems).toEqual(['"appearance.colorTheme" must be a theme id'])
  })

  it('reads stored executable paths, and passes over the choice of CLI that is gone', () => {
    const loaded = parseSettingsFile({
      version: 1,
      agents: { opencode: { binaryPath: '/opt/oc' }, codex: { cli: 'bundled', hidden: true } },
      terminal: { shellPath: '/bin/fish', fontSize: 12 },
    })
    expect(loaded.problems).toEqual([])
    expect(loaded.settings.agents).toEqual({
      opencode: { binaryPath: '/opt/oc' },
      codex: { hidden: true },
    })
    expect(loaded.settings.terminal).toEqual({ shellPath: '/bin/fish', fontSize: 12 })
  })

  it('reads a stored configuration folder only for an agent that can have one', () => {
    const loaded = parseSettingsFile({
      version: 1,
      agents: {
        codex: { configDir: '/srv/codex' },
        'claude-code': { configDir: '' },
        opencode: { configDir: '/srv/oc', binaryPath: '/opt/oc' },
      },
    })
    expect(loaded.settings.agents).toEqual({
      codex: { configDir: '/srv/codex' },
      opencode: { binaryPath: '/opt/oc' },
    })
    expect(loaded.problems).toEqual([
      '"agents.claude-code.configDir" must be a non-empty path',
      '"agents.opencode" has no configuration folder of its own',
    ])
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

  it('reads the agents the server is off for, dropping unknown and repeated ids', () => {
    const loaded = parseSettingsFile({
      version: 1,
      mcp: { kettu: { off: ['codex', 'codex', 'unknown-agent', 'pi'] } },
    })
    expect(loaded.settings.mcp).toEqual({ kettu: { off: ['codex', 'pi'] } })
    expect(loaded.problems).toEqual([])
    expect(loaded.settings.general).toEqual(DEFAULT_SETTINGS.general)
  })

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

describe('added agents', () => {
  const work: AddedAgent = {
    id: 'claude-code~work',
    name: 'Work',
    configDir: '/srv/work',
    created: true,
  }

  it('takes a name of 1 to 40 characters, trimmed, with no control characters', () => {
    expect(agentName('  Work  ')).toBe('Work')
    expect(agentName('工作账号')).toBe('工作账号')
    expect(agentName('x'.repeat(40))).toHaveLength(40)
    for (const bad of ['', '   ', 'x'.repeat(41), 'a\nb', 7, null]) {
      expect(() => agentName(bad)).toThrow(SettingsError)
    }
  })

  it('adds an agent to a harness that has them, once', () => {
    const added = withAddedAgent(defaults(), { ...work, name: ' Work ' })
    expect(added.addedAgents).toEqual([work])
    expect(() => withAddedAgent(added, work)).toThrow('exists already')
    expect(() => withAddedAgent(defaults(), { ...work, id: 'claude-code' })).toThrow(
      'not an agent that can be added',
    )
    expect(() => withAddedAgent(defaults(), { ...work, id: 'opencode~work' })).toThrow(
      'not an agent that can be added',
    )
  })

  it('renames an added agent, and no other', () => {
    const added = withAddedAgent(defaults(), work)
    expect(withRenamedAgent(added, 'claude-code~work', ' Client ').addedAgents).toEqual([
      { ...work, name: 'Client' },
    ])
    expect(() => withRenamedAgent(added, 'claude-code', 'X')).toThrow('No added agent')
    expect(() => withRenamedAgent(added, 'claude-code~work', '')).toThrow(SettingsError)
  })

  it('removes an added agent with the settings that name it', () => {
    const added = mergeSettings(withAddedAgent(defaults(), work), {
      general: { defaultAgent: 'claude-code~work' },
      mcp: { kettu: { off: ['claude-code~work', 'codex'] } },
    })
    const removed = withoutAgent(added, 'claude-code~work')
    expect(removed.addedAgents).toEqual([])
    expect(removed.general.defaultAgent).toBeNull()
    expect(removed.mcp.kettu.off).toEqual(['codex'])
    expect(() => withoutAgent(removed, 'claude-code~work')).toThrow('No added agent')
  })

  it('reads stored agents, dropping each that is invalid or repeats an id or a folder', () => {
    const loaded = parseSettingsFile({
      version: 1,
      addedAgents: [
        work,
        { ...work, name: 'Again' },
        { ...work, id: 'claude-code~other' },
        { ...work, id: 'codex', configDir: '/srv/c' },
        { ...work, id: 'codex~a', name: '', configDir: '/srv/a' },
        { ...work, id: 'codex~b', configDir: '', name: 'B' },
        { id: 'codex~c', name: 'C', configDir: '/srv/c' },
        'codex~d',
        { id: 'codex~e', name: 'E', configDir: '/srv/e', created: false },
      ],
    })
    expect(loaded.settings.addedAgents).toEqual([
      work,
      { id: 'codex~e', name: 'E', configDir: '/srv/e', created: false },
    ])
    expect(loaded.problems).toHaveLength(7)
    expect(parseSettingsFile({ version: 1, addedAgents: {} }).problems).toEqual([
      '"addedAgents" must be an array',
    ])
  })

  it('reads an added agent as the default agent and in the server list', () => {
    const loaded = parseSettingsFile({
      version: 1,
      general: { defaultAgent: 'codex~work' },
      mcp: { kettu: { off: ['codex~work', 'codex~', 'codex~work'] } },
    })
    expect(loaded.settings.general.defaultAgent).toBe('codex~work')
    expect(loaded.settings.mcp.kettu.off).toEqual(['codex~work'])
  })
})

describe('derived settings', () => {
  it('splits out what each host receives', () => {
    const settings = withShellPath(withAgentBinary(defaults(), 'opencode', '/opt/oc'), '/bin/fish')
    expect(hostSettings(settings, 'zh-CN')).toEqual({
      locale: 'zh-CN',
      agents: { opencode: { binaryPath: '/opt/oc' } },
      addedAgents: [],
      proxy: { mode: 'environment' },
      git: { backgroundFetch: false },
      mcp: { kettu: { off: [] } },
      usage: { fromComputer: false },
      sessionTitles: true,
    })
    expect(
      hostSettings({ ...settings, general: { ...settings.general, language: 'en' } }, 'zh-CN')
        .locale,
    ).toBe('en')
    expect(terminalSettings(settings)).toEqual({ shellPath: '/bin/fish', fontSize: 13 })
    expect(terminalSettings(defaults()).shellPath).toBeNull()
  })

  it('writes session titles for new sessions unless turned off', () => {
    expect(defaults().general.sessionTitles).toBe(true)
    expect(validateSettingsPatch({ general: { sessionTitles: false } })).toEqual({
      general: { sessionTitles: false },
    })
    expect(() => validateSettingsPatch({ general: { sessionTitles: 'no' } })).toThrow(
      '"general.sessionTitles" must be a boolean',
    )
    expect(hostSettings(defaults(), 'en').sessionTitles).toBe(true)
    const off = mergeSettings(defaults(), { general: { sessionTitles: false } })
    expect(hostSettings(off, 'en').sessionTitles).toBe(false)
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

  it('sends the agent host the sections it reads', () => {
    const before = defaults()
    const changed = (patch: Parameters<typeof mergeSettings>[1]) =>
      reachesHost(changedSections(before, mergeSettings(before, patch)))
    expect(changed({ usage: { fromComputer: true } })).toBe(true)
    expect(changed({ git: { backgroundFetch: true } })).toBe(true)
    expect(changed({ usage: { sidebar: 'off' } })).toBe(true)
    expect(changed({ mcp: { kettu: { off: ['codex'] } } })).toBe(true)
    expect(changed({ appearance: { theme: 'dark' } })).toBe(false)
  })
})
