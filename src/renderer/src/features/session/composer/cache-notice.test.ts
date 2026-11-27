import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import enCommon from '@shared/locales/en/common.json'
import enComposer from '@shared/locales/en/composer.json'
import zhCommon from '@shared/locales/zh-CN/common.json'
import zhComposer from '@shared/locales/zh-CN/composer.json'
import { shouldShowCacheDropNotice, type PromptCacheDrop } from '@shared/prompt-cache'

let currentLang: 'en' | 'zh-CN' = 'en'

function lookup(catalog: Record<string, unknown>, key: string): string {
  const value = key.split('.').reduce<unknown>((cur, part) => {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
      return (cur as Record<string, unknown>)[part]
    }
    return undefined
  }, catalog)
  return typeof value === 'string' ? value : key
}

function translate(key: string, values?: Record<string, unknown>): string {
  const [ns, path] = key.includes(':') ? key.split(':', 2) : ['composer', key]
  const catalog =
    ns === 'common'
      ? currentLang === 'zh-CN'
        ? zhCommon
        : enCommon
      : currentLang === 'zh-CN'
        ? zhComposer
        : enComposer
  let text = lookup(catalog as Record<string, unknown>, path!)
  if (values) {
    for (const [name, val] of Object.entries(values)) {
      text = text.replaceAll(`{{${name}}}`, String(val))
    }
  }
  return text
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate }),
}))

vi.mock('@renderer/lib/i18n', () => ({
  currentLocale: () => currentLang,
  i18n: { t: translate },
}))

import { CacheDropNotice } from './cache-notice'

const DROP: PromptCacheDrop = {
  at: 1_700_000_000_000,
  baselineShare: 0.92,
  currentShare: 0.12,
  baselineCacheRead: 46_000,
  currentCacheRead: 6_000,
  currentTotalInput: 50_000,
  missedTokens: 44_000,
  reason: null,
  extraCostUsd: null,
}

describe('shouldShowCacheDropNotice', () => {
  const base = {
    enabled: true,
    drop: DROP,
    cacheNoticeShown: false,
    activeRunning: false,
    starting: false,
    pendingSwitch: false,
    mustSwitch: false,
    dismissedKey: null,
    noticeKey: `s1:${DROP.at}`,
  }

  it('stays hidden when the setting is off (default) and shows once turned on', () => {
    expect(shouldShowCacheDropNotice({ ...base, enabled: false })).toBe(false)
    expect(shouldShowCacheDropNotice(base)).toBe(true)
  })

  it('suppresses the post-turn drop notice while the pre-send expiry notice is shown', () => {
    expect(shouldShowCacheDropNotice({ ...base, cacheNoticeShown: true })).toBe(false)
  })

  it('stays hidden when dismissed for the same turn, running, starting, or switching agents', () => {
    expect(shouldShowCacheDropNotice({ ...base, dismissedKey: `s1:${DROP.at}` })).toBe(false)
    expect(shouldShowCacheDropNotice({ ...base, dismissedKey: `s1:${DROP.at - 1000}` })).toBe(true)
    expect(shouldShowCacheDropNotice({ ...base, activeRunning: true })).toBe(false)
    expect(shouldShowCacheDropNotice({ ...base, starting: true })).toBe(false)
    expect(shouldShowCacheDropNotice({ ...base, pendingSwitch: true })).toBe(false)
    expect(shouldShowCacheDropNotice({ ...base, mustSwitch: true })).toBe(false)
    expect(shouldShowCacheDropNotice({ ...base, drop: null, noticeKey: null })).toBe(false)
  })
})

describe('CacheDropNotice', () => {
  it('renders only measured figures when reason and extra cost are unavailable', () => {
    currentLang = 'en'
    const html = renderToStaticMarkup(
      createElement(CacheDropNotice, { drop: DROP, onDismiss: () => {} }),
    )
    expect(html).toContain('kettu-cache-notice')
    expect(html).toContain('Prompt cache hit dropped')
    expect(html).toContain('92% → 12%')
    expect(html).toContain('6K')
    expect(html).toContain('50K')
    expect(html).not.toContain('Model changed')
    expect(html).not.toContain('Context compacted')
    expect(html).not.toContain('Cache expired')
    expect(html).not.toContain('extra at API prices')
  })

  it('renders verifiable reason and extra cost when present in English and Chinese', () => {
    currentLang = 'en'
    const enHtml = renderToStaticMarkup(
      createElement(CacheDropNotice, {
        drop: { ...DROP, reason: 'model_changed', extraCostUsd: 0.16 },
        onDismiss: () => {},
      }),
    )
    expect(enHtml).toContain('Model changed')
    expect(enHtml).toContain('~$0.16 extra at API prices')

    currentLang = 'zh-CN'
    const zhHtml = renderToStaticMarkup(
      createElement(CacheDropNotice, {
        drop: { ...DROP, reason: 'compacted', extraCostUsd: 0.16 },
        onDismiss: () => {},
      }),
    )
    expect(zhHtml).toContain('提示词缓存命中下降')
    expect(zhHtml).toContain('92% → 12%')
    expect(zhHtml).toContain('已压缩上下文')
    expect(zhHtml).toContain('按 API 价约多花')
  })
})
