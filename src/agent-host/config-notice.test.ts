import { afterEach, describe, expect, it } from 'vitest'
import type { ConfigOption } from '@shared/thread'
import { lostValues, lostValuesNotice, valueName, type LostValue } from './config-notice'
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
      { type: 'select', option: 'Mode', wanted: 'Read-only', actual: 'Auto review' },
      { type: 'select', option: 'Model', wanted: 'Model A', actual: 'Model B' },
      { type: 'boolean', option: 'Fast mode', wanted: true, actual: false },
    ])
  })

  it('has no actual value for an option the session does not have', () => {
    expect(lostValues([level('low'), fast(true)], [model('a')])).toEqual([
      { type: 'boolean', option: 'Fast mode', wanted: true, actual: null },
      { type: 'select', option: 'Reasoning', wanted: 'Low', actual: null },
    ])
  })

  it('treats an option of another type as missing', () => {
    expect(lostValues([fast(true)], [{ ...level('low'), id: 'fast' }])).toEqual([
      { type: 'boolean', option: 'Fast mode', wanted: true, actual: null },
    ])
  })

  it('falls back to the raw value for a choice it does not know', () => {
    expect(valueName(mode('agent'), 'gone')).toBe('gone')
  })
})

describe('lostValuesNotice', () => {
  const lost: LostValue[] = [
    { type: 'select', option: 'Mode', wanted: 'Read-only', actual: 'Auto review' },
    { type: 'select', option: 'Reasoning', wanted: 'Low', actual: null },
  ]
  const switches: LostValue[] = [
    { type: 'boolean', option: 'Fast mode', wanted: true, actual: false },
    { type: 'boolean', option: 'Fast mode', wanted: false, actual: true },
    { type: 'boolean', option: 'Fast mode', wanted: true, actual: null },
  ]
  const lines = (notice: ReturnType<typeof lostValuesNotice>) =>
    notice?.description.split('\n').slice(0, -1)

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

  it('gives a switch a whole sentence of its own, in English', () => {
    expect(lines(lostValuesNotice(switches))).toEqual([
      'Fast mode is off instead of on.',
      'Fast mode is on instead of off.',
      'This fork has no Fast mode option, so it cannot be turned on.',
    ])
  })

  it('gives a switch a whole sentence of its own, in Chinese', () => {
    setLocale('zh-CN')
    expect(lines(lostValuesNotice(switches))).toEqual([
      'Fast mode 已关闭，而不是开启。',
      'Fast mode 已开启，而不是关闭。',
      '这个分叉没有 Fast mode 选项，无法开启。',
    ])
  })

  it('has no line for a missing switch that was off, since nothing is lost', () => {
    const off: LostValue = { type: 'boolean', option: 'Fast mode', wanted: false, actual: null }
    expect(lostValuesNotice([off])).toBeNull()
    expect(lines(lostValuesNotice([off, ...lost]))).toHaveLength(2)
  })
})
