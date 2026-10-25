import { afterEach, describe, expect, it } from 'vitest'
import {
  clock,
  countdown,
  duration,
  exactCount,
  fileUrlPath,
  limitLabel,
  longAgo,
  percent,
  resetTime,
  shortAgo,
  tokens,
} from './format'
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

  it('writes a reset as the time today, the weekday this week, and the date beyond', () => {
    // Local times, since the reset shows in the machine's zone. 2026-10-21 is a Wednesday.
    const now = new Date(2026, 9, 21, 9, 0).getTime()
    expect(resetTime(new Date(2026, 9, 21, 14, 30).getTime(), now)).toBe('2:30 PM')
    expect(resetTime(new Date(2026, 9, 27, 9, 0).getTime(), now)).toBe('Tue')
    // A week on is the same weekday as today, and a monthly window resets weeks away.
    expect(resetTime(new Date(2026, 9, 28, 8, 0).getTime(), now)).toBe('Oct 28')
    expect(resetTime(new Date(2026, 10, 18, 22, 14).getTime(), now)).toBe('Nov 18')
  })

  it('names the plan windows it knows, and keeps an agent name it does not', async () => {
    expect(limitLabel({ window: 'five_hour', label: '5-hour' })).toBe('5-hour')
    await i18n.changeLanguage('zh-CN')
    expect(limitLabel({ window: 'five_hour', label: '5-hour' })).toBe('5 小时')
    expect(limitLabel({ window: 'seven_day_fable', label: 'Weekly · Fable' })).toBe('每周 · Fable')
    expect(limitLabel({ window: 'monthly', label: 'Monthly' })).toBe('每月')
    expect(limitLabel({ window: '2_day', label: '2-day' })).toBe('2-day')
  })

  it('gives a length as a clock', () => {
    expect(clock(7.4)).toBe('0:07')
    expect(clock(252)).toBe('4:12')
    expect(clock(3_599.6)).toBe('1:00:00')
    expect(clock(3_723)).toBe('1:02:03')
    expect(clock(-1)).toBe('0:00')
  })

  it('counts down in minutes and seconds, rounding up', () => {
    expect(countdown(252_000)).toBe('4:12')
    expect(countdown(3_599_001)).toBe('60:00')
    expect(countdown(7_200)).toBe('0:08')
    expect(countdown(1)).toBe('0:01')
    expect(countdown(0)).toBe('0:00')
    expect(countdown(-5_000)).toBe('0:00')
  })
})

describe('token counts', () => {
  it('are compact in each language, with exact values and shares beside them', async () => {
    expect([980, 41_000, 1_234_567, 41_700_000_000].map(tokens)).toEqual([
      '980',
      '41K',
      '1.2M',
      '41.7B',
    ])
    expect(exactCount(35_317_988_871)).toBe('35,317,988,871')
    expect(percent(0.9853)).toBe('98.5%')
    await i18n.changeLanguage('zh-CN')
    expect([41_000, 274_500_000].map(tokens)).toEqual(['4.1万', '2.7亿'])
  })
})

describe('fileUrlPath', () => {
  it('reads a file URI as a path in the platform form, without a trailing separator', () => {
    expect(fileUrlPath('file:///Users/a/My%20notes.md', 'darwin')).toBe('/Users/a/My notes.md')
    expect(fileUrlPath('file:///home/a/src/', 'linux')).toBe('/home/a/src')
    expect(fileUrlPath('file:///', 'linux')).toBe('/')
    expect(fileUrlPath('file:///C:/Users/a/src/', 'win32')).toBe('C:\\Users\\a\\src')
    expect(fileUrlPath('file:///C:/', 'win32')).toBe('C:\\')
    expect(fileUrlPath('file://server/share/a.txt', 'win32')).toBe('\\\\server\\share\\a.txt')
    expect(fileUrlPath('https://example.com/a', 'darwin')).toBeNull()
    expect(fileUrlPath('not a uri', 'darwin')).toBeNull()
  })
})
