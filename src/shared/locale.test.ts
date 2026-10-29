import { describe, expect, it } from 'vitest'
import { matchLocale, resolveLocale } from './locale'

describe('matchLocale', () => {
  it('takes the first preferred language Kettu speaks', () => {
    expect(matchLocale(['zh-Hans-CN', 'en-US'])).toBe('zh-CN')
    expect(matchLocale(['en-GB', 'zh-CN'])).toBe('en')
    expect(matchLocale(['fr-FR', 'zh-CN'])).toBe('zh-CN')
  })

  it('matches Simplified Chinese written any common way', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-SG', 'zh-Hans', 'zh-Hans-HK']) {
      expect(matchLocale([tag])).toBe('zh-CN')
    }
  })

  it('does not give Traditional Chinese the Simplified catalog', () => {
    expect(matchLocale(['zh-TW', 'en-US'])).toBe('en')
    expect(matchLocale(['zh-Hant-HK'])).toBe('en')
    expect(matchLocale(['zh-HK', 'zh-Hans'])).toBe('zh-CN')
  })

  it('falls back to English for nothing usable', () => {
    expect(matchLocale([])).toBe('en')
    expect(matchLocale(['ja-JP', 'not a tag'])).toBe('en')
  })
})

describe('resolveLocale', () => {
  it('follows the system only when the setting says so', () => {
    expect(resolveLocale('system', 'zh-CN')).toBe('zh-CN')
    expect(resolveLocale('en', 'zh-CN')).toBe('en')
    expect(resolveLocale('zh-CN', 'en')).toBe('zh-CN')
  })
})
