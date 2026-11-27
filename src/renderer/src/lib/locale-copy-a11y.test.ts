import { createElement } from 'react'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { TFunction } from 'i18next'

vi.mock('@renderer/lib/platform', () => ({
  isRelayPage: false,
  isWeb: false,
}))
vi.mock('@renderer/lib/i18n', () => ({
  currentLocale: () => 'en',
}))
vi.mock('@renderer/stores/settings', () => ({
  useSettingsStore: { getState: () => ({ settings: { cloud: { enabled: true } } }) },
}))

import enCommon from '@shared/locales/en/common.json'
import zhCommon from '@shared/locales/zh-CN/common.json'
import enComposer from '@shared/locales/en/composer.json'
import zhComposer from '@shared/locales/zh-CN/composer.json'
import enSettings from '@shared/locales/en/settings.json'
import zhSettings from '@shared/locales/zh-CN/settings.json'
import enSidebar from '@shared/locales/en/sidebar.json'
import zhSidebar from '@shared/locales/zh-CN/sidebar.json'
import { AppShell } from '@renderer/components/affect/app-shell'
import { ChatComposer } from '@renderer/components/affect/chat-composer'
import { TextField } from '@renderer/components/affect/text-field'
import { platformName } from '@renderer/features/settings/host-text'
import { kindLabel } from '@renderer/features/settings/remote-text'

const LOCALES_DIR = fileURLToPath(new URL('../../../shared/locales', import.meta.url))
const RENDERER_SRC = fileURLToPath(new URL('..', import.meta.url))

function flattenBaseKeys(obj: Record<string, unknown>, prefix = ''): Set<string> {
  const keys = new Set<string>()
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const nested of flattenBaseKeys(value as Record<string, unknown>, full)) {
        keys.add(nested)
      }
    } else {
      keys.add(full.replace(/_(zero|one|two|few|many|other)$/, ''))
    }
  }
  return keys
}

function readRendererFile(relativePath: string): string {
  return readFileSync(`${RENDERER_SRC}/${relativePath}`, 'utf8')
}

function lookupPath(catalog: Record<string, unknown>, key: string): string {
  const value = key.split('.').reduce<unknown>((current, part) => {
    if (current && typeof current === 'object' && part in (current as Record<string, unknown>)) {
      return (current as Record<string, unknown>)[part]
    }
    return undefined
  }, catalog)
  return typeof value === 'string' ? value : key
}

describe('locale catalogs parity and remote access Android copy (#2887)', () => {
  it('keeps the same namespace file list between en and zh-CN', () => {
    const enFiles = readdirSync(`${LOCALES_DIR}/en`).sort()
    const zhFiles = readdirSync(`${LOCALES_DIR}/zh-CN`).sort()
    expect(zhFiles).toEqual(enFiles)
  })

  it('keeps en and zh-CN base keys synchronized for updated namespaces', () => {
    const pairs: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ['settings', enSettings, zhSettings],
      ['sidebar', enSidebar, zhSidebar],
      ['composer', enComposer, zhComposer],
      ['common', enCommon, zhCommon],
    ]
    for (const [name, en, zh] of pairs) {
      expect([...flattenBaseKeys(zh)].sort(), `${name} base keys`).toEqual(
        [...flattenBaseKeys(en)].sort(),
      )
    }
  })

  it('includes Android phones across remote access descriptions, QR pairing hints, keywords, kinds, and pinned relay notes', () => {
    expect(enSettings.pages.remote).toContain('Android phone')
    expect(enSettings.pages.remote_web).toContain('Android phone')
    expect(enSettings.remote.keywords).toContain('android')
    expect(enSettings.remote.devices.emptyHint).toContain('Android phone')
    expect(enSettings.remote.pair.scan).toContain('Android phone')
    expect(enSettings.remote.kinds.android).toBe('Android app')
    expect(enSettings.remote.relay.note.pinned).toContain('Android phones')

    expect(zhSettings.pages.remote).toContain('Android 手机')
    expect(zhSettings.pages.remote_web).toContain('Android 手机')
    expect(zhSettings.remote.keywords).toContain('android')
    expect(zhSettings.remote.keywords).toContain('安卓')
    expect(zhSettings.remote.devices.emptyHint).toContain('Android 手机')
    expect(zhSettings.remote.pair.scan).toContain('Android 手机')
    expect(zhSettings.remote.kinds.android).toBe('Android 应用')
    expect(zhSettings.remote.relay.note.pinned).toContain('Android 手机')
  })

  it('keeps push notification notes scoped to iPhone where cloud push is iOS-only', () => {
    expect(enSettings.general.cloud.note).toContain('iPhone notifications')
    expect(enSettings.general.cloud.note).not.toContain('Android')
    expect(enSettings.remote.relay.note.own).toContain('iPhone')
    expect(enSettings.remote.relay.note.own).not.toContain('Android')
    expect(enSettings.remote.relay.note.own_web).toContain('iPhone')
    expect(enSettings.remote.relay.note.own_web).not.toContain('Android')

    expect(zhSettings.general.cloud.note).toContain('iPhone 通知')
    expect(zhSettings.general.cloud.note).not.toContain('Android')
    expect(zhSettings.remote.relay.note.own).toContain('iPhone')
    expect(zhSettings.remote.relay.note.own).not.toContain('Android')
    expect(zhSettings.remote.relay.note.own_web).toContain('iPhone')
    expect(zhSettings.remote.relay.note.own_web).not.toContain('Android')
  })

  it('formats Android device kind and platform labels in both locales', () => {
    const tEn = ((key: string) => lookupPath(enSettings, key)) as unknown as TFunction<'settings'>
    const tZh = ((key: string) => lookupPath(zhSettings, key)) as unknown as TFunction<'settings'>

    expect(kindLabel(tEn, 'android')).toBe('Android app')
    expect(kindLabel(tZh, 'android')).toBe('Android 应用')
    expect(platformName('android')).toBe('Android')
    expect(platformName('android 15')).toBe('Android 15')
  })
})

describe('shared component accessible button labels in Simplified Chinese (#2898)', () => {
  it('localizes AppShell open-sidebar and account labels while preserving English defaults', () => {
    const defaultHtml = renderToStaticMarkup(
      createElement(AppShell, { user: { name: '' }, children: createElement('div') }),
    )
    expect(defaultHtml).toContain('aria-label="Open sidebar"')

    const zhHtml = renderToStaticMarkup(
      createElement(AppShell, {
        user: { name: '' },
        children: createElement('div'),
        labels: {
          search: zhSidebar.nav.searchField,
          menu: zhSidebar.nav.label,
          resize: zhSidebar.nav.resize,
          account: zhSidebar.account.signedOut,
          openSidebar: zhSidebar.nav.openSidebar,
        },
      }),
    )
    expect(zhHtml).toContain(`aria-label="${zhSidebar.nav.openSidebar}"`)
    expect(zhHtml).not.toContain('aria-label="Open sidebar"')
  })

  it('localizes ChatComposer voice and recording button labels while preserving English defaults', () => {
    const defaultHtml = renderToStaticMarkup(createElement(ChatComposer, { voice: true }))
    expect(defaultHtml).toContain('aria-label="Voice input"')
    expect(defaultHtml).toContain('aria-label="Discard recording"')
    expect(defaultHtml).toContain('aria-label="Use recording"')

    const zhHtml = renderToStaticMarkup(
      createElement(ChatComposer, {
        voice: true,
        labels: {
          composer: zhComposer.prompt.label,
          add: zhComposer.attachments.add,
          addMenu: zhComposer.attachments.add,
          approvalMenu: zhComposer.controls.permissionMode,
          voiceInput: zhComposer.controls.voiceInput,
          discardRecording: zhComposer.controls.discardRecording,
          useRecording: zhComposer.controls.useRecording,
        },
      }),
    )
    expect(zhHtml).toContain(`aria-label="${zhComposer.controls.voiceInput}"`)
    expect(zhHtml).toContain(`aria-label="${zhComposer.controls.discardRecording}"`)
    expect(zhHtml).toContain(`aria-label="${zhComposer.controls.useRecording}"`)
    expect(zhHtml).not.toContain('aria-label="Voice input"')
    expect(zhHtml).not.toContain('aria-label="Discard recording"')
    expect(zhHtml).not.toContain('aria-label="Use recording"')
  })

  it('localizes TextField action button labels while preserving English defaults', () => {
    const defaultHtml = renderToStaticMarkup(
      createElement(TextField, {
        type: 'password',
        value: 'secret',
        clearable: true,
        copyable: true,
        onChange: () => undefined,
      }),
    )
    expect(defaultHtml).toContain('aria-label="Clear"')
    expect(defaultHtml).toContain('aria-label="Show password"')
    expect(defaultHtml).toContain('aria-label="Copy"')

    const zhHtml = renderToStaticMarkup(
      createElement(TextField, {
        type: 'password',
        value: 'secret',
        clearable: true,
        copyable: true,
        onChange: () => undefined,
        labels: {
          clear: zhCommon.actions.clear,
          showPassword: zhCommon.actions.showPassword,
          hidePassword: zhCommon.actions.hidePassword,
          copy: zhCommon.actions.copy,
          copied: zhCommon.actions.copied,
        },
      }),
    )
    expect(zhHtml).toContain(`aria-label="${zhCommon.actions.clear}"`)
    expect(zhHtml).toContain(`aria-label="${zhCommon.actions.showPassword}"`)
    expect(zhHtml).toContain(`aria-label="${zhCommon.actions.copy}"`)
    expect(zhHtml).not.toContain('aria-label="Clear"')
    expect(zhHtml).not.toContain('aria-label="Show password"')
    expect(zhHtml).not.toContain('aria-label="Copy"')
  })

  it('wires localized labels at every AppShell, ChatComposer, and password TextField call site', () => {
    const appSource = readRendererFile('app/app.tsx')
    expect(appSource).toContain("openSidebar: t('nav.openSidebar')")

    for (const file of [
      'features/session/composer/composer.tsx',
      'features/session/new-session.tsx',
      'features/tasks/task-page.tsx',
    ]) {
      const source = readRendererFile(file)
      expect(source, file).toContain('discardRecording:')
      expect(source, file).toContain('useRecording:')
    }

    for (const file of [
      'features/settings/remote-relay-choice.tsx',
      'features/marketplace/install.tsx',
      'features/marketplace/bundle-install.tsx',
      'features/marketplace/dialogs.tsx',
    ]) {
      const source = readRendererFile(file)
      expect(source, file).toContain('useTextFieldLabels()')
    }
  })
})
