import { afterEach, describe, expect, it } from 'vitest'
import type { ConfigOption } from '@shared/thread'
import { lostValues, lostValuesNotice, valueName } from './config-notice'
import { setLocale } from './i18n'

afterEach(() => {
  setLocale('en')
})

const mode = (value: string): ConfigOption => ({
  id: 'mode',
  name: 'Mode',
  category: 'mode',
  type: 'select',
  value,
  choices: [
    { value: 'read-only', name: 'Read-only' },
    { value: 'agent', name: 'Auto review' },
  ],
})
const model = (value: string): ConfigOption => ({
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  value,
  choices: [
    { value: 'a', name: 'Model A' },
    { value: 'b', name: 'Model B' },
  ],
})
const fast = (value: boolean): ConfigOption => ({
  id: 'fast',
  name: 'Fast mode',
  category: 'model_config',
  type: 'boolean',
  value,
})
const level = (value: string): ConfigOption => ({
  id: 'level',
  name: 'Reasoning',
  category: 'thought_level',
  type: 'select',
  value,
  choices: [{ value: 'low', name: 'Low' }],
})

describe('lostValues', () => {
  it('is empty when every value is held', () => {
    expect(lostValues([mode('agent'), fast(true)], [fast(true), mode('agent')])).toEqual([])
  })

  it('names the values by what a user reads, with the mode first', () => {
    const lost = lostValues(
      [level('low'), fast(true), model('a'), mode('read-only')],
      [level('low'), fast(false), model('b'), mode('agent')],
    )
    expect(lost).toEqual([
      { option: 'Mode', wanted: 'Read-only', actual: 'Auto review' },
      { option: 'Model', wanted: 'Model A', actual: 'Model B' },
      { option: 'Fast mode', wanted: 'on', actual: 'off' },
    ])
  })

  it('has no actual value for an option the session does not have', () => {
    expect(lostValues([level('low')], [model('a')])).toEqual([
      { option: 'Reasoning', wanted: 'Low', actual: null },
    ])
  })

  it('falls back to the raw value for a choice it does not know', () => {
    expect(valueName(mode('agent'), 'gone')).toBe('gone')
  })
})

describe('lostValuesNotice', () => {
  const lost = [
    { option: 'Mode', wanted: 'Read-only', actual: 'Auto review' },
    { option: 'Reasoning', wanted: 'Low', actual: null },
  ]

  it('says nothing when nothing was lost', () => {
    expect(lostValuesNotice([])).toBeNull()
  })

  it('names each value and where to change it, in English', () => {
    expect(lostValuesNotice(lost)).toEqual({
      severity: 'warning',
      title: 'This fork could not keep all of its settings',
      description: [
        'Mode is Auto review instead of Read-only.',
        'This fork has no Reasoning option, so Low is not available.',
        'You can change them in the composer.',
      ].join('\n'),
    })
  })

  it('reads the same in Chinese', () => {
    setLocale('zh-CN')
    expect(lostValuesNotice(lost)).toEqual({
      severity: 'warning',
      title: '这个分叉没能沿用全部设置',
      description: [
        'Mode 为 Auto review，而不是 Read-only。',
        '这个分叉没有 Reasoning 选项，无法使用 Low。',
        '可以在输入框中修改。',
      ].join('\n'),
    })
  })
})
