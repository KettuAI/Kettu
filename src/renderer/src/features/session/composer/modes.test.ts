import { describe, expect, it } from 'vitest'
import { modeLook, nextChoice, nextMode } from './modes'

describe('modeLook', () => {
  it('knows the modes Claude Code and Codex give', () => {
    expect(modeLook('default')).toBe('asks')
    expect(modeLook('acceptEdits')).toBe('edits')
    expect(modeLook('plan')).toBe('plan')
    expect(modeLook('agent')).toBe('auto')
    expect(modeLook('bypassPermissions')).toBe('full')
    expect(modeLook('agent-full-access')).toBe('full')
  })

  it('reads any other mode as one that asks', () => {
    expect(modeLook('yolo')).toBe('asks')
    expect(modeLook('toString')).toBe('asks')
    expect(modeLook(undefined)).toBe('asks')
  })
})

describe('nextChoice', () => {
  const choices = [{ value: 'a' }, { value: 'b' }, { value: 'c' }]

  it('steps to the next choice, round from the last to the first', () => {
    expect(nextChoice(choices, 'a')).toBe('b')
    expect(nextChoice(choices, 'c')).toBe('a')
  })

  it('starts at the first for a value it does not know, and has none for no choices', () => {
    expect(nextChoice(choices, 'z')).toBe('a')
    expect(nextChoice([], 'a')).toBeUndefined()
  })
})

describe('nextMode', () => {
  const claude = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'].map((value) => ({
    value,
  }))

  it('steps past full access, as Claude Code does', () => {
    expect(nextMode(claude, 'plan')).toBe('auto')
    expect(nextMode(claude, 'auto')).toBe('default')
  })

  it('steps on from full access when it is on', () => {
    expect(nextMode(claude, 'bypassPermissions')).toBe('default')
  })
})
