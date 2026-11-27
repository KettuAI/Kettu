import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type SettingsPatch, type UserFonts } from '@shared/settings'
import enSettings from '@shared/locales/en/settings.json'
import zhSettings from '@shared/locales/zh-CN/settings.json'

interface CapturedPicker {
  label: string
  value: { id: string | null; label: string }
  onValueChange: ((choice: { id: string | null; label: string } | null) => void) | undefined
  onOpenChange: ((open: boolean) => void) | undefined
}

let mockFonts: UserFonts = {}
let capturedPickers: CapturedPicker[] = []
let capturedResetClicks: Map<string, () => void> = new Map()
const updateMock = vi.fn<(patch: SettingsPatch) => Promise<void>>(async () => {})
const listInstalledFontsMock = vi.fn<
  (monospaceOnly: boolean) => Promise<{ state: 'ready'; families: string[] }>
>(async () => ({
  state: 'ready' as const,
  families: ['Fira Code', 'LXGW WenKai', 'PingFang SC'],
}))

vi.mock('@renderer/lib/platform', () => ({
  isWeb: false,
  isHosted: false,
  isMac: true,
  isWindows: false,
  platform: 'darwin',
  formatShortcut: (s: string) => s,
}))

vi.mock('./rows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./rows')>()
  return {
    ...actual,
    RowShell: ({ id, children }: { id?: string; children: ReactNode }) => {
      collectButtons(children)
      return actual.RowShell({ id, children })
    },
  }
})

vi.mock('@renderer/features/terminal/local-fonts', () => ({
  listInstalledFonts: (monospaceOnly: boolean) => listInstalledFontsMock(monospaceOnly),
}))

vi.mock('@base-ui/react/combobox', () => ({
  Combobox: {
    Trigger: ({
      render,
      children,
    }: {
      render: React.ReactElement<{ 'aria-label'?: string; children?: ReactNode }>
      children?: ReactNode
    }) => {
      const label = render.props['aria-label'] ?? ''
      const last = capturedPickers.at(-1)
      if (last && !last.label) last.label = label
      return createElement('button', { type: 'button', 'aria-label': label }, children)
    },
  },
}))

vi.mock('@renderer/components/ui/combobox', () => ({
  Combobox: ({
    value,
    onValueChange,
    onOpenChange,
    children,
  }: {
    value: { id: string | null; label: string }
    onValueChange?: (choice: { id: string | null; label: string } | null) => void
    onOpenChange?: (open: boolean) => void
    children?: ReactNode
  }) => {
    capturedPickers.push({ label: '', value, onValueChange, onOpenChange })
    return createElement('div', { 'data-combobox': value.id ?? '' }, children)
  },
  ComboboxContent: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ComboboxEmpty: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ComboboxInput: () => createElement('input', { type: 'text' }),
  ComboboxItem: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ComboboxList: ({
    children,
  }: {
    children?: (choice: { id: string | null; label: string }) => ReactNode
  }) =>
    createElement(
      'div',
      null,
      typeof children === 'function' ? children({ id: 'LXGW WenKai', label: 'LXGW WenKai' }) : null,
    ),
}))

vi.mock('@renderer/components/affect/app-shell', () => ({
  Icon: () => createElement('span', { 'data-testid': 'icon' }),
}))

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => {
      const parts = key.split('.')
      let cur: unknown = enSettings
      for (const part of parts) {
        if (typeof cur !== 'object' || cur === null || !(part in cur)) return key
        cur = (cur as Record<string, unknown>)[part]
      }
      if (typeof cur !== 'string') return key
      return params ? cur.replace(/\{\{(\w+)\}\}/g, (_, name: string) => params[name] ?? '') : cur
    },
  }),
}))

vi.mock('@renderer/stores/host-scope', () => ({
  useHostScope: () => ({
    useSettingsStore: Object.assign(
      <T>(selector: (state: { settings: typeof DEFAULT_SETTINGS }) => T): T =>
        selector({
          settings: {
            ...DEFAULT_SETTINGS,
            appearance: { ...DEFAULT_SETTINGS.appearance, fonts: mockFonts },
          },
        }),
      {
        getState: () => ({
          update: updateMock,
        }),
      },
    ),
  }),
}))

import { FontsCard } from './font-family'

function collectButtons(element: ReactNode): void {
  if (!element || typeof element !== 'object') return
  if (Array.isArray(element)) {
    for (const child of element) collectButtons(child)
    return
  }
  const el = element as { type?: unknown; props?: Record<string, unknown> }
  if (el.type === 'button' && typeof el.props?.onClick === 'function') {
    const label = String(el.props['aria-label'] ?? '')
    if (label) capturedResetClicks.set(label, el.props.onClick as () => void)
  }
  if (el.props?.children) collectButtons(el.props.children as ReactNode)
}

describe('FontsCard', () => {
  beforeEach(() => {
    mockFonts = {}
    capturedPickers = []
    capturedResetClicks = new Map()
    updateMock.mockClear()
    listInstalledFontsMock.mockClear()
  })

  it('renders primary and optional Chinese pickers for ui, prose and code with mixed previews', () => {
    const html = renderToStaticMarkup(createElement(FontsCard))

    expect(html).toContain('data-setting-row="font-ui"')
    expect(html).toContain('data-setting-row="font-ui-cjk"')
    expect(html).toContain('data-setting-row="font-prose"')
    expect(html).toContain('data-setting-row="font-prose-cjk"')
    expect(html).toContain('data-setting-row="font-code"')
    expect(html).toContain('data-setting-row="font-code-cjk"')

    expect(html).toContain('aria-label="Interface font"')
    expect(html).toContain('aria-label="Interface Chinese font"')
    expect(html).toContain('aria-label="Reply font"')
    expect(html).toContain('aria-label="Reply Chinese font"')
    expect(html).toContain('aria-label="Code font"')
    expect(html).toContain('aria-label="Code Chinese font"')

    expect(html).toContain(enSettings.appearance.fonts.default)
    expect(html).toContain(enSettings.appearance.fonts.cjkDefault)
    expect(html).not.toContain('k-font-clear')

    // Mixed preview contains English, digits, code symbols and Chinese characters.
    expect(html).toContain('data-testid="font-preview"')
    expect(html).toContain('Settings 2026')
    expect(html).toContain('界面按钮与标签')
    expect(html).toContain('The quick fox 2026')
    expect(html).toContain('回复正文')
    expect(html).toContain('const font = &quot;Kettu&quot;; // 代码注释 0123 !== =&gt; {}')
    expect(html).toContain('font-family:var(--theme-ui-face)')
    expect(html).toContain('font-family:var(--theme-prose-face)')
    expect(html).toContain('font-family:var(--theme-code-face)')
  })

  it('applies combined and Chinese-only stacks to the live preview and renders reset buttons', () => {
    mockFonts = {
      ui: 'SF Pro',
      uiCjk: 'PingFang SC',
      proseCjk: 'LXGW WenKai',
      code: 'Fira Code',
    }
    const html = renderToStaticMarkup(createElement(FontsCard))

    expect(html).toContain(
      'font-family:&quot;SF Pro&quot;, &quot;PingFang SC&quot;, var(--theme-ui-face)',
    )
    expect(html).toContain(
      'font-family:var(--theme-prose-latin), &quot;LXGW WenKai&quot;, var(--theme-prose-face)',
    )
    expect(html).toContain('font-family:&quot;Fira Code&quot;, var(--theme-code-face)')

    expect(html).toContain('aria-label="Reset Interface font"')
    expect(html).toContain('aria-label="Reset Interface Chinese font"')
    expect(html).not.toContain('aria-label="Reset Reply font"')
    expect(html).toContain('aria-label="Reset Reply Chinese font"')
    expect(html).toContain('aria-label="Reset Code font"')
    expect(html).not.toContain('aria-label="Reset Code Chinese font"')
  })

  it('updates primary and Chinese fonts independently while preserving the other selection', () => {
    mockFonts = { code: 'Fira Code' }
    renderToStaticMarkup(createElement(FontsCard))

    const codeCjkPicker = capturedPickers.find((p) => p.label === 'Code Chinese font')
    expect(codeCjkPicker).toBeDefined()
    codeCjkPicker?.onValueChange?.({ id: 'LXGW WenKai', label: 'LXGW WenKai' })
    expect(updateMock).toHaveBeenCalledWith({
      appearance: { fonts: { code: 'Fira Code', codeCjk: 'LXGW WenKai' } },
    })

    // Selecting the default choice clears only the targeted slot.
    updateMock.mockClear()
    mockFonts = { code: 'Fira Code', codeCjk: 'LXGW WenKai' }
    capturedPickers = []
    renderToStaticMarkup(createElement(FontsCard))

    const codeCjkClear = capturedPickers.find((p) => p.label === 'Code Chinese font')
    codeCjkClear?.onValueChange?.({ id: null, label: 'System Chinese' })
    expect(updateMock).toHaveBeenCalledWith({
      appearance: { fonts: { code: 'Fira Code' } },
    })
  })

  it('clears the selected Chinese font via its reset button without dropping the primary font', () => {
    mockFonts = { ui: 'Inter', uiCjk: 'PingFang SC' }
    renderToStaticMarkup(createElement(FontsCard))

    const resetUiCjk = capturedResetClicks.get('Reset Interface Chinese font')
    expect(resetUiCjk).toBeDefined()
    resetUiCjk?.()
    expect(updateMock).toHaveBeenCalledWith({
      appearance: { fonts: { ui: 'Inter' } },
    })
  })

  it('lists monospace fonts only for Code primary while listing all fonts for Code Chinese', () => {
    renderToStaticMarkup(createElement(FontsCard))

    const codePrimary = capturedPickers.find((p) => p.label === 'Code font')
    const codeCjk = capturedPickers.find((p) => p.label === 'Code Chinese font')
    expect(codePrimary).toBeDefined()
    expect(codeCjk).toBeDefined()

    codePrimary?.onOpenChange?.(true)
    expect(listInstalledFontsMock).toHaveBeenLastCalledWith(true)

    codeCjk?.onOpenChange?.(true)
    expect(listInstalledFontsMock).toHaveBeenLastCalledWith(false)
  })

  it('keeps bilingual font labels and Chinese font search keywords aligned', () => {
    expect(enSettings.appearance.fonts.cjkKeywords).toContain('chinese')
    expect(enSettings.appearance.fonts.cjkKeywords).toContain('cjk')
    expect(zhSettings.appearance.fonts.cjkKeywords).toContain('中文字体')
    expect(zhSettings.appearance.fonts.cjkKeywords).toContain('cjk')
    expect(enSettings.appearance.fonts.ui.cjkName).toBe('Interface Chinese font')
    expect(zhSettings.appearance.fonts.ui.cjkName).toBe('界面中文字体')
    expect(enSettings.appearance.fonts.prose.cjkName).toBe('Reply Chinese font')
    expect(zhSettings.appearance.fonts.prose.cjkName).toBe('回复中文字体')
    expect(enSettings.appearance.fonts.code.cjkName).toBe('Code Chinese font')
    expect(zhSettings.appearance.fonts.code.cjkName).toBe('代码中文字体')
  })
})
