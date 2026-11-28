import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaintBoardIcon } from '@hugeicons/core-free-icons'
import enSession from '@shared/locales/en/session.json'
import enSettings from '@shared/locales/en/settings.json'
import zhSession from '@shared/locales/zh-CN/session.json'
import zhSettings from '@shared/locales/zh-CN/settings.json'
import {
  DEFAULT_SETTINGS,
  type ConversationWidth,
  type SettingsFile,
  type SettingsPatch,
} from '@shared/settings'
import type { SectionDef } from '@renderer/features/settings/model'
import { WebSettings } from '@renderer/web/settings'

function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial))
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
  }
}

function fakeRoot() {
  const properties = new Map<string, string>()
  const attributes = new Map<string, string>()
  const dataset: Record<string, string | undefined> = {}
  const root = {
    lang: '',
    dataset,
    style: {
      setProperty: (name: string, value: string) => properties.set(name, value),
      removeProperty: (name: string) => properties.delete(name),
    },
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
  } as unknown as HTMLElement
  return { root, properties, attributes, dataset }
}

const originalDocument = globalThis.document
const originalLocalStorage = globalThis.localStorage
const originalWindow = globalThis.window
const originalRaf = globalThis.requestAnimationFrame

function restoreGlobals() {
  Object.defineProperty(globalThis, 'document', {
    value: originalDocument,
    configurable: true,
    writable: true,
  })
  Object.defineProperty(globalThis, 'localStorage', {
    value: originalLocalStorage,
    configurable: true,
    writable: true,
  })
  Object.defineProperty(globalThis, 'window', {
    value: originalWindow,
    configurable: true,
    writable: true,
  })
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    value: originalRaf,
    configurable: true,
    writable: true,
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.resetModules()
  restoreGlobals()
})

describe('conversation width preset calculations and CSS rules', () => {
  it('preserves exact legacy standard widths and provides a noticeably wider wide preset', async () => {
    const { MIN_WIDTH, presetThreadWidth } = await import('./thread-width')

    expect(presetThreadWidth('standard', 'small')).toBe(680)
    expect(presetThreadWidth('standard', 'default')).toBe(728)
    expect(presetThreadWidth('standard', 'large')).toBe(776)

    expect(presetThreadWidth('wide', 'small')).toBe(1016)
    expect(presetThreadWidth('wide', 'default')).toBe(1088)
    expect(presetThreadWidth('wide', 'large')).toBe(1160)

    expect(presetThreadWidth('wide', 'default')).toBeGreaterThan(
      presetThreadWidth('standard', 'default'),
    )
    expect(presetThreadWidth('standard', 'small')).toBeGreaterThan(MIN_WIDTH)
  })

  it('clamps dragged and effective widths cleanly on narrow viewports while allowing wide drags', async () => {
    const {
      clampThreadWidth,
      dragThreadWidth,
      effectiveThreadWidth,
      presetThreadWidth,
      stepThreadWidth,
    } = await import('./thread-width')

    // Narrow viewport below MIN_WIDTH shrinks cleanly to available space.
    expect(clampThreadWidth(728, 360)).toBe(360)
    expect(clampThreadWidth(400, 360)).toBe(360)
    expect(effectiveThreadWidth('standard', null, 360)).toBe(360)
    expect(effectiveThreadWidth('wide', null, 360)).toBe(360)
    expect(effectiveThreadWidth('wide', 1400, 360)).toBe(360)

    // Medium viewport (e.g. split pane or laptop with side panel) shrinks wide preset cleanly.
    expect(effectiveThreadWidth('wide', null, 820)).toBe(820)
    expect(effectiveThreadWidth('standard', null, 820)).toBe(728)

    // Wide display (2K / 4K) allows dragging to wide preset and well beyond it.
    expect(clampThreadWidth(1440, 1800)).toBe(1440)
    expect(clampThreadWidth(2200, 1800)).toBe(1800)
    expect(clampThreadWidth(300, 1800)).toBe(480)
    expect(dragThreadWidth(1088, 1800, 'right', 150)).toBe(1388)
    expect(dragThreadWidth(1088, 1800, 'left', -150)).toBe(1388)
    expect(dragThreadWidth(1088, 1800, 'right', 600)).toBe(1800)
    expect(effectiveThreadWidth('wide', 1440, 1800)).toBe(1440)
    expect(effectiveThreadWidth('wide', null, 1800)).toBe(presetThreadWidth('wide'))
    expect(effectiveThreadWidth('standard', null, 1800)).toBe(presetThreadWidth('standard'))

    // Keyboard stepping adjusts symmetrically and Home requests a reset to the active preset.
    expect(stepThreadWidth(1088, 1800, 'right', 'ArrowRight', false)).toBe(1136)
    expect(stepThreadWidth(1088, 1800, 'right', 'ArrowRight', true)).toBe(1280)
    expect(stepThreadWidth(1088, 1800, 'left', 'ArrowLeft', false)).toBe(1136)
    expect(stepThreadWidth(1088, 1800, 'left', 'ArrowRight', false)).toBe(1040)
    expect(stepThreadWidth(1088, 1800, 'right', 'Home', false)).toBeNull()
    expect(stepThreadWidth(1088, 1800, 'right', 'Enter', false)).toBeUndefined()

    // Zero or non-finite rooms never produce negative or NaN widths.
    expect(clampThreadWidth(728, 0)).toBe(0)
    expect(effectiveThreadWidth('wide', null, 0)).toBe(0)
    expect(effectiveThreadWidth('wide', null, Number.NaN)).toBe(0)
  })

  it('defines standard and wide preset rules in session.css using --thread-column-preset', () => {
    const cssPath = fileURLToPath(new URL('../styles/session.css', import.meta.url))
    const css = readFileSync(cssPath, 'utf8')

    expect(css).toContain('--thread-column-preset: calc(48 * var(--prose-size) + 8px);')
    expect(css).toContain('--thread-column: var(--thread-column-set, var(--thread-column-preset));')
    expect(css).toMatch(
      /:root\[data-conversation-width='wide'\]\s+\.ks-session\s*\{[^}]*--thread-column-preset:\s*calc\(72 \* var\(--prose-size\) \+ 8px\);/,
    )
  })
})

describe('thread-width store persistence and settings preset interaction', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('sanitizes stored drag overrides and clears storage immediately on reset', async () => {
    vi.useFakeTimers()
    const storage = memoryStorage({ 'thread-width': '912.4' })
    const { root, properties } = fakeRoot()
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
    Object.defineProperty(globalThis, 'document', {
      value: { documentElement: root },
      configurable: true,
    })

    const mod = await import('./thread-width')
    expect(mod.useThreadWidth.getState().width).toBe(912)
    expect(properties.get('--thread-column-set')).toBe('912px')

    // Dragging persists after debounce; resetting clears immediately even before timer fires.
    mod.setThreadWidth(1240)
    expect(properties.get('--thread-column-set')).toBe('1240px')
    mod.resetThreadWidth()
    expect(mod.useThreadWidth.getState().width).toBeNull()
    expect(properties.has('--thread-column-set')).toBe(false)
    expect(storage.store.has('thread-width')).toBe(false)

    vi.advanceTimersByTime(500)
    expect(storage.store.has('thread-width')).toBe(false)

    // Invalid stored values fall back to null.
    for (const raw of ['200', '"wide"', 'null', 'NaN', '{bad']) {
      storage.store.set('thread-width', raw)
      expect(mod.readStoredThreadWidth()).toBeNull()
    }
  })

  it('keeps an existing drag override on launch, clears it when switching presets, and resets to the active preset', async () => {
    vi.useFakeTimers()
    const storage = memoryStorage({ 'thread-width': '900' })
    const { root, properties, dataset } = fakeRoot()
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
    Object.defineProperty(globalThis, 'document', {
      value: { documentElement: root },
      configurable: true,
    })
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      value: (cb: FrameRequestCallback) => {
        cb(0)
        return 1
      },
      configurable: true,
    })

    let currentSettings: SettingsFile = {
      ...structuredClone(DEFAULT_SETTINGS),
      appearance: { ...DEFAULT_SETTINGS.appearance, conversationWidth: 'wide' },
    }
    const listeners = new Set<(next: SettingsFile) => void>()

    Object.defineProperty(globalThis, 'window', {
      value: {
        kettu: {
          systemLocale: 'en',
          settings: {
            get: async () => currentSettings,
            update: async (patch: SettingsPatch) => {
              currentSettings = {
                ...currentSettings,
                appearance: { ...currentSettings.appearance, ...patch.appearance },
              }
              for (const listener of listeners) listener(currentSettings)
              return currentSettings
            },
            onChanged: (listener: (next: SettingsFile) => void) => {
              listeners.add(listener)
              return () => listeners.delete(listener)
            },
          },
        },
      },
      configurable: true,
    })

    const { initSettings, useSettingsStore } = await import('./settings')
    const {
      resetThreadWidth,
      setThreadWidth,
      useThreadWidth,
      effectiveThreadWidth,
      presetThreadWidth,
    } = await import('./thread-width')

    // Launch loads persisted "wide" preset while preserving the saved 900px drag width.
    await initSettings()
    expect(dataset.conversationWidth).toBe('wide')
    expect(useThreadWidth.getState().width).toBe(900)
    expect(properties.get('--thread-column-set')).toBe('900px')

    // Explicitly switching from wide -> standard in Settings clears the drag override at once.
    await useSettingsStore.getState().update({ appearance: { conversationWidth: 'standard' } })
    expect(dataset.conversationWidth).toBe('standard')
    expect(useThreadWidth.getState().width).toBeNull()
    expect(properties.has('--thread-column-set')).toBe(false)
    expect(storage.store.has('thread-width')).toBe(false)
    expect(
      effectiveThreadWidth(
        useSettingsStore.getState().settings.appearance.conversationWidth,
        useThreadWidth.getState().width,
        1800,
      ),
    ).toBe(presetThreadWidth('standard'))

    // Drag to a custom width under standard, then reset: returns to standard preset.
    setThreadWidth(1100)
    vi.advanceTimersByTime(350)
    expect(storage.store.get('thread-width')).toBe('1100')
    expect(properties.get('--thread-column-set')).toBe('1100px')
    resetThreadWidth()
    expect(dataset.conversationWidth).toBe('standard')
    expect(properties.has('--thread-column-set')).toBe(false)
    expect(
      effectiveThreadWidth(
        useSettingsStore.getState().settings.appearance.conversationWidth,
        useThreadWidth.getState().width,
        1800,
      ),
    ).toBe(presetThreadWidth('standard'))

    // Drag again, then switch preset to wide: clears drag override and applies wide immediately.
    setThreadWidth(820)
    expect(useThreadWidth.getState().width).toBe(820)
    await useSettingsStore.getState().update({ appearance: { conversationWidth: 'wide' } })
    expect(dataset.conversationWidth).toBe('wide')
    expect(useThreadWidth.getState().width).toBeNull()
    expect(properties.has('--thread-column-set')).toBe(false)
    expect(
      effectiveThreadWidth(
        useSettingsStore.getState().settings.appearance.conversationWidth,
        useThreadWidth.getState().width,
        1800,
      ),
    ).toBe(presetThreadWidth('wide'))

    // Drag to a custom width under wide, then reset via handle: returns to wide preset.
    setThreadWidth(1420)
    expect(useThreadWidth.getState().width).toBe(1420)
    resetThreadWidth()
    expect(dataset.conversationWidth).toBe('wide')
    expect(useThreadWidth.getState().width).toBeNull()
    expect(
      effectiveThreadWidth(
        useSettingsStore.getState().settings.appearance.conversationWidth,
        useThreadWidth.getState().width,
        1800,
      ),
    ).toBe(presetThreadWidth('wide'))
  })
})

describe('web client conversation width persistence and visibility', () => {
  it('defaults to standard, persists wide in browser storage, and sanitizes invalid stored values', async () => {
    const storage = memoryStorage()
    const first = new WebSettings(storage)
    expect(first.current().appearance.conversationWidth).toBe('standard')

    await first.update({ appearance: { conversationWidth: 'wide' } })
    expect(first.current().appearance.conversationWidth).toBe('wide')

    const reloaded = new WebSettings(storage)
    expect(reloaded.current().appearance.conversationWidth).toBe('wide')

    for (const bad of ['full', '', 999, null]) {
      const corrupt = memoryStorage({
        'kettu.settings': JSON.stringify({ appearance: { conversationWidth: bad } }),
      })
      expect(new WebSettings(corrupt).current().appearance.conversationWidth).toBe('standard')
    }
  })

  it('keeps conversation-width visible in the web client settings', async () => {
    vi.doMock('@renderer/lib/platform', () => ({
      isHosted: false,
      isWeb: true,
    }))
    const { webClusters } = await import('@renderer/features/settings/web-sections')
    const appearance: SectionDef = {
      id: 'appearance',
      title: 'Appearance',
      description: 'Look and feel',
      icon: PaintBoardIcon,
      rows: [
        { id: 'theme', setting: 'appearance.theme', render: () => null },
        { id: 'app-icon', setting: 'appearance.app-icon', render: () => null },
        { id: 'zoom', setting: 'appearance.zoom', render: () => null },
        { id: 'text-size', setting: 'appearance.text-size', render: () => null },
        { id: 'conversation-width', setting: 'appearance.conversation-width', render: () => null },
      ],
    }
    const filtered = webClusters([[appearance]])
    expect(filtered[0]?.[0]?.rows.map((row) => row.id)).toEqual([
      'theme',
      'text-size',
      'conversation-width',
    ])
  })
})

describe('WidthGrip handle hints and bilingual copy', () => {
  it('renders accurate preset-aware hints for standard and wide presets', async () => {
    const { root } = fakeRoot()
    const storage = memoryStorage()
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
    Object.defineProperty(globalThis, 'document', {
      value: { documentElement: root },
      configurable: true,
    })

    let mockPreset: ConversationWidth = 'standard'
    vi.doMock('@renderer/stores/settings', () => ({
      useSettingsStore: <T>(selector: (state: { settings: SettingsFile }) => T): T =>
        selector({
          settings: {
            ...DEFAULT_SETTINGS,
            appearance: { ...DEFAULT_SETTINGS.appearance, conversationWidth: mockPreset },
          },
        }),
    }))
    vi.doMock('react-i18next', () => ({
      initReactI18next: { type: '3rdParty', init: () => {} },
      useTranslation: () => ({
        t: (key: string, params?: Record<string, string>) => {
          const parts = key.split('.')
          let cur: unknown = enSession
          for (const part of parts) {
            if (typeof cur !== 'object' || cur === null || !(part in cur)) return key
            cur = (cur as Record<string, unknown>)[part]
          }
          if (typeof cur !== 'string') return key
          return params ? cur.replace(/\{\{(\w+)\}\}/g, (_, k: string) => params[k] ?? '') : cur
        },
      }),
    }))

    const { WidthGrip } = await import('@renderer/features/session/thread-width-grips')

    const standardHtml = renderToStaticMarkup(
      createElement(WidthGrip, { side: 'right', size: { width: 728, most: 1600 } }),
    )
    expect(standardHtml).toContain('role="separator"')
    expect(standardHtml).toContain('aria-label="Resize the content width"')
    expect(standardHtml).toContain(
      'title="Drag to resize. Double-click to reset to Standard width."',
    )
    expect(standardHtml).toContain('aria-valuenow="728"')
    expect(standardHtml).toContain('aria-valuemax="1600"')

    mockPreset = 'wide'
    const wideHtml = renderToStaticMarkup(
      createElement(WidthGrip, { side: 'right', size: { width: 1088, most: 1600 } }),
    )
    expect(wideHtml).toContain('title="Drag to resize. Double-click to reset to Wide width."')
    expect(wideHtml).toContain('aria-valuenow="1088"')
  })

  it('has complete English and Chinese copy for Appearance and drag handle presets', () => {
    expect(enSettings.appearance.conversationWidth.name).toBe('Conversation width')
    expect(enSettings.appearance.conversationWidth.standard).toBe('Standard')
    expect(enSettings.appearance.conversationWidth.wide).toBe('Wide')

    expect(zhSettings.appearance.conversationWidth.name).toBe('会话宽度')
    expect(zhSettings.appearance.conversationWidth.standard).toBe('标准')
    expect(zhSettings.appearance.conversationWidth.wide).toBe('宽版')

    expect(enSession.thread.width.presets).toEqual({ standard: 'Standard', wide: 'Wide' })
    expect(zhSession.thread.width.presets).toEqual({ standard: '标准', wide: '宽版' })
  })
})
