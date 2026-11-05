import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type AddedAgent, type SettingsFile } from '@shared/settings'
import {
  mergeSettings,
  parseSettingsFile,
  validateSettingsPatch,
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
