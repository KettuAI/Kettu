import { describe, expect, it } from 'vitest'
import type { AgentOptions, AgentStatus } from '@shared/agent-host'
import type { ConfigOption } from '@shared/thread'
import {
  agentNeed,
  canStart,
  itemKey,
  menuGroups,
  parseItemKey,
  startConfig,
  startValues,
  type MenuAgent,
} from './start-options'

const model: ConfigOption = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  value: 'sonnet',
  choices: [
    { value: 'opus', name: 'Opus', description: 'Most capable' },
    { value: 'sonnet', name: 'Sonnet' },
  ],
}

const level = (value: string, choices: string[]): ConfigOption => ({
  id: 'effort',
  name: 'Reasoning',
  category: 'thought_level',
  type: 'select',
  value,
  choices: choices.map((c) => ({ value: c, name: c })),
})

const mode: ConfigOption = {
  id: 'mode',
  name: 'Mode',
  category: 'mode',
  type: 'select',
  value: 'default',
  choices: [
    { value: 'default', name: 'Default' },
    { value: 'bypass', name: 'Bypass' },
  ],
}

const fast: ConfigOption = {
  id: 'fast',
  name: 'Fast mode',
  category: 'model_config',
  type: 'boolean',
  value: false,
}

const entry = (over: Partial<AgentOptions> = {}): AgentOptions => ({
  agentId: 'claude-code',
  config: [mode, model, level('medium', ['low', 'medium', 'high']), fast],
  levels: {},
  remembered: {},
  observedAt: 0,
  ...over,
})

const values = (config: ConfigOption[]) => Object.fromEntries(config.map((o) => [o.id, o.value]))

describe('startConfig', () => {
  it("starts from the agent's own defaults", () => {
    expect(values(startConfig(entry()))).toEqual({
      mode: 'default',
      model: 'sonnet',
      effort: 'medium',
      fast: false,
    })
  })

  it('takes the remembered model and level, but never a remembered mode', () => {
    const config = startConfig(
      entry({ remembered: { model: 'opus', effort: 'high', mode: 'bypass', fast: true } }),
    )
    expect(values(config)).toEqual({ mode: 'default', model: 'opus', effort: 'high', fast: true })
  })

  it('puts what New session set over the remembered values', () => {
    const config = startConfig(entry({ remembered: { model: 'opus' } }), {
      model: 'sonnet',
      mode: 'bypass',
    })
    expect(values(config)).toMatchObject({ model: 'sonnet', mode: 'bypass' })
  })

  it('passes over a value the option no longer takes', () => {
    const config = startConfig(entry({ remembered: { model: 'retired' } }), { effort: 'max' })
    expect(values(config)).toMatchObject({ model: 'sonnet', effort: 'medium' })
  })

  it('offers the levels of the chosen model, as it last offered them', () => {
    const config = startConfig(
      entry({ levels: { opus: level('high', ['low', 'medium', 'high', 'max']) } }),
      { model: 'opus', effort: 'max' },
    )
    const effort = config.find((o) => o.id === 'effort')
    expect(effort?.choices?.map((c) => c.value)).toEqual(['low', 'medium', 'high', 'max'])
    expect(effort?.value).toBe('max')
  })
})

describe('startValues', () => {
  it("sends only what differs from the agent's defaults", () => {
    expect(startValues(entry())).toEqual({})
    expect(
      startValues(entry({ remembered: { model: 'opus' } }), { fast: true, mode: 'default' }),
    ).toEqual({ model: 'opus', fast: true })
  })

  it("sends every value of a provisional entry, which need not be the agent's defaults", () => {
    const opened = { ...entry(), provisional: true }
    expect(startValues(opened)).toEqual(
      Object.fromEntries(opened.config.map((option) => [option.id, option.value])),
    )
  })
})

describe('item keys', () => {
  it('carry the agent and the model, or no model', () => {
    expect(parseItemKey(itemKey('codex', 'gpt-5.5'))).toEqual({
      agentId: 'codex',
      model: 'gpt-5.5',
    })
    expect(parseItemKey(itemKey('opencode', null))).toEqual({ agentId: 'opencode', model: null })
    expect(parseItemKey(itemKey('opencode', 'openai/gpt:5'))).toEqual({
      agentId: 'opencode',
      model: 'openai/gpt:5',
    })
  })
})

describe('menuGroups', () => {
  const contains = (text: string, query: string) => text.toLowerCase().includes(query.toLowerCase())
  const agents: MenuAgent[] = [
    { agentId: 'claude-code', name: 'Claude Code', model, choosable: true },
    {
      agentId: 'codex',
      name: 'Codex',
      model: { ...model, choices: [{ value: 'gpt', name: 'GPT-5.5', description: 'Capable' }] },
      choosable: true,
    },
    { agentId: 'opencode', name: 'OpenCode', model: null, choosable: true },
    { agentId: 'fake-agent', name: 'Fake agent', model: null, choosable: false },
  ]

  it("lists the shown agent's models without a query", () => {
    expect(menuGroups(agents, 'claude-code', '', contains)).toEqual([
      {
        agentId: 'claude-code',
        items: [itemKey('claude-code', 'opus'), itemKey('claude-code', 'sonnet')],
      },
    ])
    expect(menuGroups(agents, 'opencode', '', contains)).toEqual([
      { agentId: 'opencode', items: [itemKey('opencode', null)] },
    ])
    expect(menuGroups(agents, 'fake-agent', '', contains)).toEqual([
      { agentId: 'fake-agent', items: [] },
    ])
  })

  it('searches every agent by model and description, and keeps all of an agent found by name', () => {
    expect(menuGroups(agents, 'claude-code', 'capable', contains)).toEqual([
      { agentId: 'claude-code', items: [itemKey('claude-code', 'opus')] },
      { agentId: 'codex', items: [itemKey('codex', 'gpt')] },
    ])
    expect(menuGroups(agents, 'claude-code', 'open', contains)).toEqual([
      { agentId: 'opencode', items: [itemKey('opencode', null)] },
    ])
    expect(menuGroups(agents, 'codex', 'claude', contains)).toEqual([
      {
        agentId: 'claude-code',
        items: [itemKey('claude-code', 'opus'), itemKey('claude-code', 'sonnet')],
      },
    ])
    expect(menuGroups(agents, 'codex', 'nothing', contains)).toEqual([])
    // Inside a word, an agent's name does not count: "de" is in Claude, Codex and OpenCode.
    expect(menuGroups(agents, 'codex', 'de', contains)).toEqual([])
    expect(menuGroups(agents, 'codex', 'code', contains).map((g) => g.agentId)).toEqual([
      'claude-code',
      'codex',
    ])
  })
})

const status = (overrides: Partial<AgentStatus>): AgentStatus => ({
  id: 'codex',
  name: 'Codex',
  state: 'available',
  version: null,
  package: null,
  signIn: 'unknown',
  authMethods: [],
  canLogout: false,
  account: null,
  limits: [],
  detail: null,
  installUrl: null,
  progress: [],
  launchCommand: 'codex-acp',
  binaryOverride: null,
  update: null,
  updateCheckedAt: null,
  task: null,
  installMethods: [],
  capabilities: {
    loadSession: false,
    listSessions: false,
    resumeSession: false,
    closeSession: false,
    deleteSession: false,
    forkSession: false,
    steering: false,
    reports: false,
    account: false,
    progressNotes: false,
  },
  ...overrides,
})

const adapter = (installed: boolean) => ({
  name: '@zed-industries/codex-acp',
  version: '2.2.2',
  installed,
})

describe('agentNeed', () => {
  it('needs nothing from an agent that can run now', () => {
    expect(agentNeed(status({ package: adapter(true) }))).toBeNull()
    expect(agentNeed(status({ id: 'opencode', state: 'ready', signIn: 'signed-in' }))).toBeNull()
  })

  it('counts a package agent without its adapter as not installed, yet startable', () => {
    const codex = status({ package: adapter(false) })
    expect(agentNeed(codex)).toBe('adapter')
    expect(canStart(codex)).toBe(true)
  })

  it('cannot start an agent missing from PATH or without Node.js', () => {
    for (const state of ['not-installed', 'node-missing', 'node-outdated'] as const) {
      const missing = status({ state, package: adapter(false) })
      expect(agentNeed(missing)).toBe('install')
      expect(canStart(missing)).toBe(false)
    }
  })

  it('shows an install, a failure and a sign-in before the adapter', () => {
    expect(agentNeed(status({ state: 'installing', package: adapter(false) }))).toBe('installing')
    expect(agentNeed(status({ state: 'failed', package: adapter(false) }))).toBe('failed')
    expect(agentNeed(status({ state: 'ready', signIn: 'required' }))).toBe('sign-in')
  })
})
