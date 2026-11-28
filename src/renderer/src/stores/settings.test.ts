import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PaintBoardIcon } from '@hugeicons/core-free-icons'
import { afterEach, describe, expect, it, vi } from 'vitest'
import enSettings from '@shared/locales/en/settings.json'
import zhSettings from '@shared/locales/zh-CN/settings.json'
import { CODE_SIZES, DEFAULT_SETTINGS, USER_FONT_ROLES } from '@shared/settings'
import type { SectionDef } from '@renderer/features/settings/model'
import { WebSettings } from '@renderer/web/settings'
import { applyAppearance, applyCodeSize, applyUserFonts } from './settings'

function fakeRoot() {
  const properties = new Map<string, string>()
  const attributes = new Map<string, string>()
  const dataset: Record<string, string | undefined> = {}
  const root = {
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

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
  }
}

describe('applyUserFonts and globals.css Latin prefixes', () => {
  it('clears all user font CSS properties and data attributes when unset', () => {
    const { root, properties, attributes } = fakeRoot()
    applyUserFonts(root, { ui: 'Inter', uiCjk: 'PingFang SC', codeCjk: 'LXGW WenKai' })
    applyUserFonts(root, {})

    for (const role of USER_FONT_ROLES) {
      expect(properties.has(`--user-${role}-face`)).toBe(false)
      expect(attributes.has(`data-user-font-${role}`)).toBe(false)
    }
  })

  it('sets data-user-font-<role> only when a primary face is set, preserving theme Latin features on Chinese-only overrides', () => {
    const { root, properties, attributes } = fakeRoot()
    applyUserFonts(root, {
      ui: 'Manrope',
      uiCjk: 'PingFang SC',
      proseCjk: 'LXGW WenKai',
      code: 'Fira Code',
    })

    expect(properties.get('--user-ui-face')).toBe('"Manrope", "PingFang SC", var(--theme-ui-face)')
    expect(attributes.has('data-user-font-ui')).toBe(true)

    expect(properties.get('--user-prose-face')).toBe(
      'var(--theme-prose-latin), "LXGW WenKai", var(--theme-prose-face)',
    )
    expect(attributes.has('data-user-font-prose')).toBe(false)

    expect(properties.get('--user-code-face')).toBe('"Fira Code", var(--theme-code-face)')
    expect(attributes.has('data-user-font-code')).toBe(true)
  })

  it('defines pure-Latin prefixes in globals.css without system-ui or Platform Chinese', () => {
    const cssPath = fileURLToPath(new URL('../styles/globals.css', import.meta.url))
    const css = readFileSync(cssPath, 'utf8')
    const systemLatin = /--face-system-latin:\s*([^;]+);/.exec(css)?.[1] ?? ''
    const systemMonoLatin = /--face-system-mono-latin:\s*([^;]+);/.exec(css)?.[1] ?? ''

    expect(systemLatin).not.toBe('')
    expect(systemLatin).not.toContain('system-ui')
    expect(systemLatin).not.toContain('Platform Chinese')

    expect(systemMonoLatin).not.toBe('')
    expect(systemMonoLatin).not.toContain('ui-monospace')
    expect(systemMonoLatin).not.toContain('Platform Chinese')

    expect(css).toContain('--theme-ui-latin:')
    expect(css).toContain('--theme-prose-latin:')
    expect(css).toContain('--theme-code-latin:')
  })
})

describe('code font size appearance, web persistence and CSS tokens', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('applies data-code-size via applyCodeSize and applyAppearance independently of textSize', () => {
    const { root, dataset, properties } = fakeRoot()
    for (const preset of CODE_SIZES) {
      applyCodeSize(root, preset)
      expect(dataset.codeSize).toBe(preset)
    }

    vi.stubGlobal('document', { documentElement: root })
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })

    applyAppearance({
      ...DEFAULT_SETTINGS,
      appearance: {
        ...DEFAULT_SETTINGS.appearance,
        theme: 'light',
        textSize: 'large',
        codeSize: 'small',
      },
    })
    expect(dataset.textSize).toBe('large')
    expect(dataset.codeSize).toBe('small')
    expect(properties.get('--zoom')).toBe(String(DEFAULT_SETTINGS.appearance.zoom))

    applyAppearance({
      ...DEFAULT_SETTINGS,
      appearance: {
        ...DEFAULT_SETTINGS.appearance,
        theme: 'light',
        textSize: 'default',
        codeSize: 'large',
      },
    })
    expect(dataset.textSize).toBe('default')
    expect(dataset.codeSize).toBe('large')
  })

  it('persists codeSize in web storage and sanitizes invalid stored values', async () => {
    const storage = memoryStorage()
    const first = new WebSettings(storage)
    expect(first.current().appearance.codeSize).toBe('default')

    await first.update({ appearance: { codeSize: 'large' } })
    expect(first.current().appearance.codeSize).toBe('large')
    expect(first.current().appearance.textSize).toBe('default')

    const reloaded = new WebSettings(storage)
    expect(reloaded.current().appearance.codeSize).toBe('large')

    for (const bad of ['medium', 'xlarge', '', 13, null, {}]) {
      const corrupt = memoryStorage({
        'kettu.settings': JSON.stringify({ appearance: { codeSize: bad } }),
      })
      expect(new WebSettings(corrupt).current().appearance.codeSize).toBe('default')
    }
  })

  it('keeps code-size visible in the web client settings', async () => {
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
        { id: 'code-size', setting: 'appearance.code-size', render: () => null },
      ],
    }
    const filtered = webClusters([[appearance]])
    expect(filtered[0]?.[0]?.rows.map((row) => row.id)).toEqual(['theme', 'text-size', 'code-size'])
  })

  it('preserves exact default CSS sizes and wires code size offsets across code surfaces', () => {
    const globalsCss = readFileSync(
      fileURLToPath(new URL('../styles/globals.css', import.meta.url)),
      'utf8',
    )
    const sessionCss = readFileSync(
      fileURLToPath(new URL('../styles/session.css', import.meta.url)),
      'utf8',
    )
    const affectCss = readFileSync(
      fileURLToPath(new URL('../styles/affect.css', import.meta.url)),
      'utf8',
    )
    const editorSrc = readFileSync(
      fileURLToPath(new URL('../features/files/code-editor.tsx', import.meta.url)),
      'utf8',
    )

    // Base tokens remain unchanged so compact UI labels using text-code are untouched, and default
    // offsets are 0 px so existing textSize presets keep their exact rendering.
    expect(globalsCss).toContain('--text-code: 12px;')
    expect(globalsCss).toContain('--text-code--line-height: 20px;')
    expect(globalsCss).toContain('--code-size-offset: 0px;')
    expect(globalsCss).toContain('--code-line-height-offset: 0px;')
    expect(globalsCss).toContain('--code-size: calc(var(--text-code) + var(--code-size-offset));')
    expect(globalsCss).toContain(
      '--code-line-height: calc(var(--text-code--line-height) + var(--code-line-height-offset));',
    )
    expect(globalsCss).toMatch(
      /:root\[data-code-size='small'\]\s*\{[^}]*--code-size-offset:\s*-1px;[^}]*--code-line-height-offset:\s*-2px;/,
    )
    expect(globalsCss).toMatch(
      /:root\[data-code-size='large'\]\s*\{[^}]*--code-size-offset:\s*1px;[^}]*--code-line-height-offset:\s*2px;/,
    )

    // Code surfaces wired to code size tokens.
    expect(globalsCss).toContain('--diffs-font-size: var(--code-size);')
    expect(globalsCss).toContain('--diffs-line-height: var(--code-line-height);')
    expect(globalsCss).toContain('font-size: calc(0.8667em + var(--code-size-offset));')
    expect(globalsCss).toContain(
      'font-size: calc(var(--prose-size) - 2.5px + var(--code-size-offset));',
    )
    expect(globalsCss).toContain(
      'font-size: calc(var(--prose-size) - 3px + var(--code-size-offset));',
    )
    expect(globalsCss).toContain(
      '--diffs-line-height: calc(21px + var(--code-line-height-offset));',
    )

    expect(sessionCss).toContain(
      'font-size: calc(var(--prose-size) - 2.5px + var(--code-size-offset));',
    )
    expect(sessionCss).toContain('font-size: var(--code-size);')
    expect(sessionCss).toContain('line-height: var(--code-line-height);')

    expect(affectCss).toContain('.k-inset.k-code-preview')
    expect(affectCss).toContain('font-size: calc(12.5px + var(--code-size-offset));')
    expect(affectCss).toContain('line-height: calc(20px + var(--code-line-height-offset));')

    expect(editorSrc).toContain("fontSize: 'var(--code-size)'")
    expect(editorSrc).toContain("lineHeight: 'var(--code-line-height)'")
  })

  it('has complete English and Chinese copy for Appearance code size', () => {
    expect(enSettings.appearance.codeSize.name).toBe('Code size')
    expect(enSettings.appearance.codeSize.small).toBe('Small')
    expect(enSettings.appearance.codeSize.default).toBe('Default')
    expect(enSettings.appearance.codeSize.large).toBe('Large')

    expect(zhSettings.appearance.codeSize.name).toBe('代码字号')
    expect(zhSettings.appearance.codeSize.small).toBe('小')
    expect(zhSettings.appearance.codeSize.default).toBe('默认')
    expect(zhSettings.appearance.codeSize.large).toBe('大')
  })
})
