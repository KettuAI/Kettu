import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@renderer/lib/i18n'
import { ago, when } from './ago'

const now = new Date(2026, 10, 2, 15, 0).getTime()
const minutes = (n: number) => now - n * 60_000

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('ago and when', () => {
  it('say how long ago, inside a line and on a line of its own', () => {
    expect(ago(now - 20_000, now)).toBe('just now')
    expect(when(now - 20_000, now)).toBe('Just now')
    expect(ago(minutes(12), now)).toBe('12 min ago')
    expect(when(minutes(120), now)).toBe('2 h ago')
    expect(ago(minutes(18 * 60), now)).toBe('yesterday')
    expect(when(minutes(18 * 60), now)).toBe('Yesterday')
    expect(ago(minutes(5 * 24 * 60), now)).toBe('on Oct 28')
    expect(when(minutes(5 * 24 * 60), now)).toBe('Oct 28')
  })

  it('follow the interface language', async () => {
    await i18n.changeLanguage('zh-CN')
    expect(ago(minutes(12), now)).toBe('12 分钟前')
    expect(when(minutes(18 * 60), now)).toBe('昨天')
  })
})
