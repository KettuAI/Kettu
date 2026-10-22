import { afterEach, describe, expect, it } from 'vitest'
import { duration, limitLabel, longAgo, shortAgo } from './format'
import { i18n } from './i18n'

const NOW = Date.UTC(2026, 9, 21, 12)
const MINUTE = 60_000

afterEach(() => i18n.changeLanguage('en'))

describe('format in the interface language', () => {
  it('writes relative times and durations in English', () => {
    expect(shortAgo(NOW - 4 * MINUTE, NOW)).toBe('4m')
    expect(longAgo(NOW - MINUTE, NOW)).toBe('1 minute ago')
    expect(longAgo(NOW - 5 * MINUTE, NOW)).toBe('5 minutes ago')
    expect(duration(133_000)).toBe('2 m 13 s')
  })

  it('switches to Chinese with the language', async () => {
    await i18n.changeLanguage('zh-CN')
    expect(shortAgo(NOW - 4 * MINUTE, NOW)).toBe('4 分钟')
    expect(longAgo(NOW - 5 * MINUTE, NOW)).toBe('5 分钟前')
    expect(duration(133_000)).toBe('2 分 13 秒')
  })

  it('names the plan windows it knows, and keeps an agent name it does not', async () => {
    expect(limitLabel({ window: 'five_hour', label: '5-hour' })).toBe('5-hour')
    await i18n.changeLanguage('zh-CN')
    expect(limitLabel({ window: 'five_hour', label: '5-hour' })).toBe('5 小时')
    expect(limitLabel({ window: 'seven_day_fable', label: 'Weekly · Fable' })).toBe('每周 · Fable')
    expect(limitLabel({ window: 'monthly', label: 'Monthly' })).toBe('Monthly')
  })
})
