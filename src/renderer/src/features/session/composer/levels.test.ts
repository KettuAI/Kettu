import { describe, expect, it } from 'vitest'
import { levelRows, levelsOf, splitName, tierOf, type SelectOption } from './levels'

const effort = (names: string[], value: string, defaultDescription?: string): SelectOption => ({
  id: 'effort',
  name: 'Effort',
  category: 'thought_level',
  type: 'select',
  value,
  choices: names.map((name) => ({
    value: name
      .toLowerCase()
      .replace(/[^a-z]+/g, '-')
      .replace(/-$/, ''),
    name,
    ...(name.startsWith('Default') && defaultDescription
      ? { description: defaultDescription }
      : {}),
  })),
})

describe('tierOf', () => {
  it('marks the top levels by name', () => {
    const option = effort(['Low', 'Medium', 'High', 'Xhigh', 'Max'], 'low')
    expect(tierOf(option, 'high')).toBeNull()
    expect(tierOf(option, 'xhigh')).toBe('high')
    expect(tierOf(option, 'max')).toBe('max')
  })

  it('does not take the last level for the highest', () => {
    const option = effort(['Low', 'High', 'Max', 'Default'], 'default')
    expect(tierOf(option, 'default')).toBeNull()
    expect(tierOf(option, 'max')).toBe('max')
  })

  it('ignores case and dashes', () => {
    const option = effort(['Extra High', 'Ultracode'], 'extra-high')
    expect(tierOf(option, 'extra-high')).toBe('high')
    expect(tierOf(option, 'ultracode')).toBe('max')
  })

  it('has no tier for a value that is not a choice', () => {
    expect(tierOf(effort(['Max'], 'max'), 'unknown')).toBeNull()
    expect(tierOf(effort(['Max'], 'max'), undefined)).toBeNull()
  })
})

describe('levelsOf', () => {
  it('leaves the default out of the levels', () => {
    const { levels, fallback } = levelsOf(effort(['Default', 'Low', 'High'], 'low'), 'low')
    expect(levels.map((l) => l.value)).toEqual(['low', 'high'])
    expect(fallback?.value).toBe('default')
  })

  it('shows a level set by hand as chosen', () => {
    const result = levelsOf(effort(['Default', 'Low', 'High'], 'high'), 'high')
    expect(result.usesDefault).toBe(false)
    expect(result.shown).toBe('high')
  })

  it('shows no level when the default does not say which it stands for', () => {
    const result = levelsOf(effort(['Default', 'Low', 'High'], 'default'), 'default')
    expect(result.usesDefault).toBe(true)
    expect(result.shown).toBeUndefined()
  })

  it('rests on the level the default names', () => {
    const named = effort(['Default (High)', 'Low', 'High'], 'default-high')
    expect(levelsOf(named, 'default-high').shown).toBe('high')
    const described = effort(['Default', 'Low', 'Medium'], 'default', 'Uses medium effort')
    expect(levelsOf(described, 'default').shown).toBe('medium')
  })

  it('prefers the longest level name the default mentions', () => {
    const option = effort(['Default (Extra High)', 'High', 'Extra High'], 'default-extra-high')
    expect(levelsOf(option, 'default-extra-high').shown).toBe('extra-high')
  })

  it('keeps every choice when there is no default', () => {
    const result = levelsOf(effort(['Low', 'Max'], 'max'), 'max')
    expect(result.fallback).toBeUndefined()
    expect(result.levels).toHaveLength(2)
    expect(result.shown).toBe('max')
  })
})

describe('levelRows', () => {
  it('keeps the agent order and every choice', () => {
    const rows = levelRows(effort(['Default', 'Low', 'High'], 'low'))
    expect(rows.map((r) => r.value)).toEqual(['default', 'low', 'high'])
    expect(rows.map((r) => r.label)).toEqual(['Default', 'Low', 'High'])
  })

  it('names the Default row with the level the agent says it stands for', () => {
    const named = effort(['Low', 'Default (High)', 'High'], 'default-high')
    expect(levelRows(named).find((r) => r.value === 'default-high')?.label).toBe('Default (High)')
    const described = effort(['Default', 'Low', 'Medium'], 'default', 'Uses medium effort')
    expect(levelRows(described).find((r) => r.value === 'default')?.label).toBe('Default (Medium)')
  })

  it('keeps a row description for its tooltip', () => {
    const rows = levelRows(effort(['Default', 'Low'], 'low', 'Uses low effort'))
    expect(rows.find((r) => r.value === 'default')?.description).toBe('Uses low effort')
    expect(rows.find((r) => r.value === 'low')?.description).toBeUndefined()
  })

  it('lists every choice when the agent offers no default', () => {
    const rows = levelRows(effort(['Low', 'Max'], 'max'))
    expect(rows.map((r) => r.value)).toEqual(['low', 'max'])
  })
})

describe('splitName', () => {
  it('splits the provider from the model', () => {
    expect(splitName('opencode-go/DeepSeek V4.1 Flash')).toEqual([
      'opencode-go/',
      'DeepSeek V4.1 Flash',
    ])
    expect(splitName('a/b/c')).toEqual(['a/b/', 'c'])
  })

  it('leaves a name without a provider whole', () => {
    expect(splitName('Opus 5.5')).toEqual(['', 'Opus 5.5'])
  })
})
