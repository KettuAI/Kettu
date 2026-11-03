import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountStatus } from '@shared/account'

vi.stubGlobal('window', {
  kettu: { platform: 'darwin', remote: { activity: () => new Promise(() => {}) } },
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
})

const account = vi.hoisted(() => ({ status: null as AccountStatus | null }))
vi.mock('@renderer/stores/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/stores/account')>()),
  useAccountStore: (select: (state: typeof account) => unknown) => select(account),
}))

const { i18n } = await import('@renderer/lib/i18n')
const { useAccountSection } = await import('./section-defs')
const { SectionBody } = await import('./rows')

function AccountSection() {
  return createElement(SectionBody, { section: useAccountSection() })
}

function signedIn(subscription: string): AccountStatus {
  return {
    state: 'signed-in',
    account: { id: 'alex', name: 'Alex', email: 'alex@example.com', avatar: null },
    subscription,
    manageUrl: 'https://www.kettu.sh/account',
    plainText: false,
  }
}

function text(): string {
  return renderToStaticMarkup(createElement(AccountSection))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

afterEach(async () => {
  account.status = null
  await i18n.changeLanguage('en')
})

describe('account settings', () => {
  it.each([
    ['en', 'Subscription', 'Manage account', 'Sign out'],
    ['zh-CN', '订阅', '管理账号', '退出登录'],
  ])(
    'keeps account controls without an empty subscription row in %s',
    async (language, row, manage, signOut) => {
      await i18n.changeLanguage(language)
      account.status = signedIn('none')
      const shown = text()
      expect(shown).toContain('Alex')
      expect(shown).toContain('alex@example.com')
      expect(shown).toContain(manage)
      expect(shown).toContain(signOut)
      expect(shown).not.toContain(row)
    },
  )

  it.each([
    ['trialing', 'Trial'],
    ['active', 'Subscribed'],
    ['past_due', 'Payment failed'],
    ['paused', 'Paused'],
    ['canceled', 'Ended'],
    ['suspended', 'suspended'],
  ])('keeps the subscription row and its existing label for %s', (status, label) => {
    account.status = signedIn(status)
    const shown = text()
    expect(shown).toContain('Subscription')
    expect(shown).toContain(label)
  })
})
