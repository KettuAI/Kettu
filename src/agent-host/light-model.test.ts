import { describe, expect, it } from 'vitest'
import type { ConfigOption } from '@shared/thread'
import { lightTarget } from './light-model'
import { pickModel } from './outline-titles'

const config: ConfigOption[] = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    value: 'gpt-5.5',
    choices: [
      { value: 'gpt-5.5', name: 'GPT-5.5' },
      { value: 'gpt-5.5-mini', name: 'GPT-5.5 mini' },
    ],
  },
]

describe('which model a lightweight task asks', () => {
  it('takes the task agent’s small model, else the session’s', () => {
    const target = lightTarget({ mode: 'small' }, 'codex', 'gpt-5.5')
    expect(target.agentId).toBe('codex')
    expect(pickModel(config, target.model)).toBe('gpt-5.5-mini')
    expect(pickModel([], target.model)).toBe('gpt-5.5')
  })

  it('keeps the session’s agent and model when it follows the session', () => {
    const target = lightTarget({ mode: 'session' }, 'codex', 'gpt-5.5')
    expect(target.agentId).toBe('codex')
    expect(pickModel(config, target.model)).toBe('gpt-5.5')
    // No session: the hidden session keeps the agent's own model.
    expect(pickModel(config, lightTarget({ mode: 'session' }, 'codex', null).model)).toBeNull()
  })

  it('goes to the pinned agent and model whatever the task’s agent', () => {
    const setting = { mode: 'pinned', agentId: 'codex', model: 'gpt-5.5' } as const
    for (const agentId of ['claude-code', null] as const) {
      const target = lightTarget(setting, agentId, 'claude-opus-5-5')
      expect(target?.agentId).toBe('codex')
      expect(pickModel(config, target!.model)).toBe('gpt-5.5')
    }
  })

  it('fails rather than ask another model when the pinned one is gone', () => {
    const setting = { mode: 'pinned', agentId: 'codex', model: 'gpt-4' } as const
    const target = lightTarget(setting, 'codex', null)
    expect(() => pickModel(config, target.model)).toThrow(/no longer offers the model gpt-4/)
    expect(() => pickModel([], target.model)).toThrow()
  })

  it('has nowhere to go without an agent unless one is pinned', () => {
    expect(lightTarget({ mode: 'small' }, null, null)).toBeNull()
    expect(lightTarget({ mode: 'session' }, null, null)).toBeNull()
  })
})
