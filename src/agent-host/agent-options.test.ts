import { describe, expect, it, vi } from 'vitest'
import type { AgentOptions } from '@shared/agent-host'
import type { ConfigOption } from '@shared/thread'
import {
  AgentOptionsStore,
  isValueOf,
  parseAgentOptionsFile,
  startOrder,
  type AgentOptionsFile,
} from './agent-options'
import type { JsonFile } from './storage'

const model = (value: string): ConfigOption => ({
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  value,
  choices: [
    { value: 'small', name: 'Small' },
    { value: 'large', name: 'Large' },
  ],
})

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
  value: 'ask',
  choices: [
    { value: 'ask', name: 'Ask' },
    { value: 'auto', name: 'Auto' },
  ],
}

function store(saved: AgentOptionsFile = { version: 1, agents: {} }) {
  const file = {
    load: vi.fn(async () => saved),
    save: vi.fn(),
    flush: vi.fn(async () => {}),
  }
  const changed = vi.fn<(options: AgentOptions) => void>()
  const options = new AgentOptionsStore({
    file: file as unknown as JsonFile<AgentOptionsFile>,
    changed,
    now: () => 1000,
  })
  return { options, file, changed }
}

describe('AgentOptionsStore', () => {
  it("keeps a new session's options as the agent's defaults, with its model's levels", () => {
    const { options, changed, file } = store()
    const config = [mode, model('small'), level('medium', ['low', 'medium'])]
    options.started('codex', config)
    expect(options.get('codex')).toEqual({
      agentId: 'codex',
      config,
      levels: { small: config[2] },
      remembered: {},
      observedAt: 1000,
    })
    expect(changed).toHaveBeenCalledTimes(1)
    expect(file.save).toHaveBeenCalledTimes(1)
  })

  it('remembers the model and level the user chose, never the mode', () => {
    const { options } = store()
    options.started('codex', [mode, model('small'), level('medium', ['low', 'medium'])])
    const after = [mode, model('large'), level('high', ['medium', 'high', 'max'])]
    options.chose('codex', model('small'), 'large', after)
    options.chose('codex', after[2]!, 'high', after)
    options.chose('codex', mode, 'auto', after)
    const entry = options.get('codex')!
    expect(entry.remembered).toEqual({ model: 'large', effort: 'high' })
    expect(Object.keys(entry.levels)).toEqual(['small', 'large'])
    expect(entry.levels.large?.choices?.map((c) => c.value)).toEqual(['medium', 'high', 'max'])
  })

  it('writes and announces only a change, not a new reading of the same options', () => {
    const { options, changed, file } = store()
    const config = [model('small')]
    options.started('codex', config)
    options.started('codex', config)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(file.save).toHaveBeenCalledTimes(1)
  })

  it("takes an opened session's options only while none are known, and its model's levels", () => {
    const { options } = store()
    const opened = [mode, model('large'), level('high', ['medium', 'high'])]
    options.opened('codex', opened)
    expect(options.get('codex')?.config).toEqual(opened)

    const started = [mode, model('small'), level('medium', ['low', 'medium'])]
    options.started('codex', started)
    options.opened('codex', [mode, model('large'), level('max', ['high', 'max'])])
    const entry = options.get('codex')!
    expect(entry.config).toEqual(started)
    expect(entry.levels.large?.choices?.map((c) => c.value)).toEqual(['high', 'max'])
  })

  it('ignores a choice for an agent that has not started a session', () => {
    const { options, changed } = store()
    options.chose('codex', model('small'), 'large', [model('large')])
    expect(options.get('codex')).toBeNull()
    expect(changed).not.toHaveBeenCalled()
  })

  it('loads what an earlier run kept', async () => {
    const entry: AgentOptions = {
      agentId: 'claude-code',
      config: [model('small')],
      levels: {},
      remembered: { model: 'large' },
      observedAt: 5,
    }
    const { options } = store({ version: 1, agents: { 'claude-code': entry } })
    await options.load()
    expect(options.list()).toEqual([entry])
  })
})

describe('startOrder', () => {
  it('sets the model first, then its options and level, then the mode', () => {
    const config = [mode, level('low', ['low']), model('small')]
    expect(startOrder(config, ['mode', 'effort', 'model', 'unknown'])).toEqual([
      'model',
      'effort',
      'mode',
      'unknown',
    ])
  })
})

describe('isValueOf', () => {
  it('takes only a listed choice, or a boolean for a switch', () => {
    expect(isValueOf(model('small'), 'large')).toBe(true)
    expect(isValueOf(model('small'), 'retired')).toBe(false)
    expect(
      isValueOf(
        { id: 'fast', name: 'Fast', category: 'other', type: 'boolean', value: false },
        true,
      ),
    ).toBe(true)
  })
})

describe('parseAgentOptionsFile', () => {
  it('drops what does not parse and keeps the rest', () => {
    const parsed = parseAgentOptionsFile({
      agents: {
        codex: {
          config: [model('small'), { id: 'broken' }],
          levels: { small: level('low', ['low']), large: 'nonsense' },
          remembered: { model: 'large', effort: 3 },
          observedAt: 7,
        },
        opencode: { config: [] },
        unknown: { config: [model('small')] },
      },
    })
    expect(parsed).toEqual({
      version: 1,
      agents: {
        codex: {
          agentId: 'codex',
          config: [model('small')],
          levels: { small: level('low', ['low']) },
          remembered: { model: 'large' },
          observedAt: 7,
        },
      },
    })
  })

  it('rejects a file without agents', () => {
    expect(parseAgentOptionsFile({})).toBe('agents is not an object')
  })
})
