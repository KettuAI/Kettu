import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type AddedAgent, type SettingsFile } from '@shared/settings'
import {
  mergeSettings,
  parseSettingsFile,
  validateSettingsPatch,
  withAllowedComputerApp,
  withoutAgent,
} from './settings-schema'

function settingsWith(changes: Partial<SettingsFile>): SettingsFile {
  return { ...structuredClone(DEFAULT_SETTINGS), ...changes }
}

describe('turned-off agents in a patch', () => {
  it('accepts a list of known agents', () => {
    const patch = validateSettingsPatch({ disabledAgents: ['codex', 'claude-code~work'] })
    expect(patch.disabledAgents).toEqual(['codex', 'claude-code~work'])
  })

  it('accepts an empty list, which turns every agent on', () => {
    expect(validateSettingsPatch({ disabledAgents: [] }).disabledAgents).toEqual([])
  })

  it.each([
    ['a value that is no list', 'codex'],
    ['an unknown agent', ['no-such-agent']],
    ['an added agent of a harness that takes none', ['opencode~work']],
    ['an agent named twice', ['codex', 'codex']],
    ['an id that is no string', [42]],
  ])('rejects %s', (_, value) => {
    expect(() => validateSettingsPatch({ disabledAgents: value })).toThrow()
  })

  it('replaces the stored list whole', () => {
    const current = settingsWith({ disabledAgents: ['codex', 'claude-code'] })
    const next = mergeSettings(current, { disabledAgents: ['opencode'] })
    expect(next.disabledAgents).toEqual(['opencode'])
    expect(current.disabledAgents).toEqual(['codex', 'claude-code'])
  })

  it('leaves the list alone when the patch does not name it', () => {
    const current = settingsWith({ disabledAgents: ['codex'] })
    expect(mergeSettings(current, { general: { sendKey: 'mod-enter' } }).disabledAgents).toEqual([
      'codex',
    ])
  })
})

describe('turned-off agents in the settings file', () => {
  it('defaults to none for a file from before the list', () => {
    expect(parseSettingsFile({ version: 1 }).settings.disabledAgents).toEqual([])
  })

  it('keeps the known agents and drops unknown and repeated ones', () => {
    const { settings, problems } = parseSettingsFile({
      version: 1,
      disabledAgents: ['codex', 'gone-agent', 'codex', 7, 'claude-code~work'],
    })
    expect(settings.disabledAgents).toEqual(['codex', 'claude-code~work'])
    expect(problems).toEqual([])
  })

  it('reports a list that is no array and turns every agent on', () => {
    const { settings, problems } = parseSettingsFile({ version: 1, disabledAgents: 'codex' })
    expect(settings.disabledAgents).toEqual([])
    expect(problems).toHaveLength(1)
  })
})

describe('removing a turned-off agent', () => {
  const added: AddedAgent = {
    id: 'claude-code~work',
    name: 'Work',
    configDir: '/tmp/work',
    created: false,
  }

  it('forgets an added agent in the list', () => {
    const current = settingsWith({
      addedAgents: [added],
      disabledAgents: ['codex', 'claude-code~work'],
    })
    expect(withoutAgent(current, 'claude-code~work').disabledAgents).toEqual(['codex'])
  })

  it("forgets a harness's default agent in the list", () => {
    const current = settingsWith({
      agents: { codex: { enabled: true } },
      disabledAgents: ['codex', 'opencode'],
    })
    expect(withoutAgent(current, 'codex').disabledAgents).toEqual(['opencode'])
  })
})

describe('computer use settings', () => {
  const app = { id: 'com.apple.textedit', name: 'TextEdit' }

  it('is off with no apps until the user turns it on', () => {
    expect(parseSettingsFile({ version: 1 }).settings.computerUse).toEqual({
      enabled: false,
      allowedApps: [],
    })
  })

  it('accepts the switch and a list of apps, and replaces the list whole', () => {
    const patch = validateSettingsPatch({ computerUse: { enabled: true, allowedApps: [app] } })
    const current = settingsWith({
      computerUse: { enabled: false, allowedApps: [{ id: 'x', name: 'X' }] },
    })
    expect(mergeSettings(current, patch).computerUse).toEqual({ enabled: true, allowedApps: [app] })
  })

  it.each([
    ['a switch that is no boolean', { enabled: 'yes' }],
    ['an app without an id', { allowedApps: [{ id: '', name: 'X' }] }],
    ['an app with more fields', { allowedApps: [{ ...app, path: '/Applications' }] }],
    ['an app named twice', { allowedApps: [app, app] }],
    ['an unknown field', { unrestricted: true }],
  ])('rejects %s', (_, value) => {
    expect(() => validateSettingsPatch({ computerUse: value })).toThrow()
  })

  it('drops an invalid list from the file and keeps the switch', () => {
    const loaded = parseSettingsFile({
      version: 1,
      computerUse: { enabled: true, allowedApps: 'all' },
    })
    expect(loaded.settings.computerUse).toEqual({ enabled: true, allowedApps: [] })
    expect(loaded.problems).toHaveLength(1)
  })

  it('always allows an app once, from the host', () => {
    const once = withAllowedComputerApp(settingsWith({}), app)
    expect(once.computerUse.allowedApps).toEqual([app])
    expect(withAllowedComputerApp(once, app)).toBe(once)
    expect(() => withAllowedComputerApp(once, { id: 7 })).toThrow()
  })
})
