import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next, { type TFunction } from 'i18next'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import enSettings from '@shared/locales/en/settings.json'
import zhSettings from '@shared/locales/zh-CN/settings.json'
import { CATALOG } from '@shared/settings-catalog'

const i18nState = vi.hoisted(
  (): { instance: ReturnType<typeof i18next.createInstance> | null } => ({
    instance: null,
  }),
)

vi.mock('@renderer/lib/platform', () => ({
  platform: 'win32',
  isMac: false,
  isWindows: true,
  isWeb: false,
  isHosted: false,
  isRelayPage: false,
  formatShortcut: (shortcut: string) => shortcut.replace('Mod', 'Ctrl'),
  shortcutKeys: (shortcut: string) => shortcut.split(/\+(?=.)/),
}))

vi.mock('@renderer/lib/i18n', () => ({
  get i18n() {
    return i18nState.instance
  },
}))

import { shortcutList } from '@renderer/features/shell/shortcuts'
import { matches, type RowDef } from './model'
import { Row } from './rows'
import { sendKeyDescription, type SendKeySetting } from './send-key-text'

const testI18n = i18next.createInstance()
i18nState.instance = testI18n

beforeAll(async () => {
  await testI18n.init({
    lng: 'en',
    fallbackLng: 'en',
    defaultNS: 'settings',
    ns: ['settings'],
    resources: { en: { settings: enSettings }, 'zh-CN': { settings: zhSettings } },
    interpolation: { escapeValue: false },
  })
})

function fixedSettingsT(lng: 'en' | 'zh-CN'): TFunction<'settings'> {
  return testI18n.getFixedT(lng, 'settings') as unknown as TFunction<'settings'>
}

function sendKeyRow(lng: 'en' | 'zh-CN', sendKey: SendKeySetting): RowDef {
  return {
    id: 'send-key',
    setting: 'general.send-key',
    description: sendKeyDescription(fixedSettingsT(lng), sendKey),
    render: () => null,
  }
}

describe('Settings > General > Send key newline description (#3031)', () => {
  it('describes Shift+Enter for enter and Enter for mod-enter in both en and zh-CN', async () => {
    const cases: Array<['en' | 'zh-CN', SendKeySetting, string]> = [
      ['en', 'enter', 'Press Shift+Enter for a new line.'],
      ['en', 'mod-enter', 'Press Enter for a new line.'],
      ['zh-CN', 'enter', '按 Shift+Enter 换行。'],
      ['zh-CN', 'mod-enter', '按 Enter 换行。'],
    ]

    for (const [lng, sendKey, expected] of cases) {
      await testI18n.changeLanguage(lng)
      const row = sendKeyRow(lng, sendKey)
      const html = renderToStaticMarkup(createElement(Row, { row }))
      expect(html).toContain(`<small>${expected}</small>`)
      expect(html).not.toContain('The other key')
      expect(html).not.toContain('另一个按键')
    }
  })

  it('keeps static catalog description accurate and searchable in en and zh-CN', async () => {
    expect(CATALOG['general.send-key'].description).toBe('general.sendKey.description')

    expect(enSettings.general.sendKey.description).toContain('Shift+Enter')
    expect(enSettings.general.sendKey.description).toContain('Enter')
    expect(enSettings.general.sendKey.description).not.toContain('The other key')

    expect(zhSettings.general.sendKey.description).toContain('Shift+Enter')
    expect(zhSettings.general.sendKey.description).toContain('Enter')
    expect(zhSettings.general.sendKey.description).not.toContain('另一个按键')

    await testI18n.changeLanguage('en')
    expect(matches(sendKeyRow('en', 'enter'), 'shift')).toBe(true)
    expect(matches(sendKeyRow('en', 'mod-enter'), 'shift')).toBe(true)

    await testI18n.changeLanguage('zh-CN')
    expect(matches(sendKeyRow('zh-CN', 'enter'), '换行')).toBe(true)
    expect(matches(sendKeyRow('zh-CN', 'mod-enter'), 'shift')).toBe(true)
  })

  it('wires the general send-key row to sendKeyDescription and matches composer newline shortcuts', () => {
    const sectionDefs = readFileSync(
      fileURLToPath(new URL('./section-defs.tsx', import.meta.url)),
      'utf8',
    )
    expect(sectionDefs).toContain("setting: 'general.send-key'")
    expect(sectionDefs).toContain('description: sendKeyDescription(t, sendKey)')

    const enterNewLine = shortcutList('enter').find((item) => item.action === 'newLine')
    const modEnterNewLine = shortcutList('mod-enter').find((item) => item.action === 'newLine')
    expect(enterNewLine?.keys).toBe('Shift+Enter')
    expect(modEnterNewLine?.keys).toBe('Enter')
  })
})
