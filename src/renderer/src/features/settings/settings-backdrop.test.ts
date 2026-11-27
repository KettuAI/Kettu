import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseColor } from '@shared/themes'

type OpenChangeDetails = {
  reason: string
  cancel: () => void
  event: { target: EventTarget | null }
}
type OpenChangeHandler = (open: boolean, details: OpenChangeDetails) => void

let lastOnOpenChange: OpenChangeHandler | undefined
const closeSettingsMock = vi.fn()
const settingsBackMock = vi.fn()

// Render Base UI Dialog primitives inline during SSR so tests verify backdrop/popup markup and
// open-change wiring for SettingsDialogFrame.
vi.mock('@base-ui/react/dialog', () => {
  type DivProps = Record<string, unknown> & { children?: ReactNode }
  const passthrough = (tag: string, marker: string) =>
    function Stub({ children, ...rest }: DivProps) {
      const props: Record<string, unknown> = { ...rest, 'data-test-part': marker }
      delete props.initialFocus
      delete props.finalFocus
      return createElement(tag, props, children)
    }

  return {
    Dialog: {
      Root: ({
        open,
        onOpenChange,
        children,
      }: {
        open?: boolean
        onOpenChange?: OpenChangeHandler
        children?: ReactNode
      }) => {
        lastOnOpenChange = onOpenChange
        return open === false ? null : createElement('div', { 'data-slot': 'dialog' }, children)
      },
      Trigger: passthrough('button', 'trigger'),
      Portal: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
      Backdrop: passthrough('div', 'backdrop'),
      Popup: passthrough('div', 'popup'),
      Title: passthrough('h2', 'title'),
      Description: passthrough('p', 'description'),
      Close: passthrough('button', 'close'),
    },
  }
})

vi.mock('@hugeicons/core-free-icons', () => ({
  Cancel01Icon: [],
}))

vi.mock('@hugeicons/react', () => ({
  HugeiconsIcon: () => null,
}))

vi.mock('@renderer/components/affect/app-shell', () => ({
  Icon: () => null,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@renderer/stores/overlays', () => ({
  useOverlayRoot: (_open: unknown, _defaultOpen: unknown, onOpenChange?: OpenChangeHandler) =>
    onOpenChange,
}))

vi.mock('@renderer/stores/view', () => ({
  closeSettings: (...args: unknown[]) => closeSettingsMock(...args),
  openSettings: vi.fn(),
  settingsBack: (...args: unknown[]) => settingsBackMock(...args),
  useViewStore: vi.fn(() => false),
}))

const RENDERER_SRC = path.resolve(import.meta.dirname, '../..')

/** Parses top-level and at-rule CSS variable declarations by normalized selector. */
function parseTokenBlocks(css: string): Map<string, Map<string, string>> {
  const blocks = new Map<string, Map<string, string>>()
  const visit = (text: string, prefix: string): void => {
    let at = 0
    for (;;) {
      const open = text.indexOf('{', at)
      if (open < 0) return
      let depth = 1
      let close = open + 1
      for (; close < text.length && depth > 0; close++) {
        if (text[close] === '{') depth++
        else if (text[close] === '}') depth--
      }
      const prelude = text.slice(at, open).replace(/\s+/g, ' ').trim()
      const body = text.slice(open + 1, close - 1)
      if (prelude.startsWith('@')) {
        visit(body, `${prelude} `)
      } else {
        const declarations = new Map<string, string>()
        for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
          declarations.set(name!, value!.replace(/\s+/g, ' ').trim())
        }
        blocks.set(prefix + prelude, declarations)
      }
      at = close
    }
  }
  visit(css.replace(/\/\*[\s\S]*?\*\//g, ''), '')
  return blocks
}

/** Extracts the declaration block for an exact CSS selector. */
function cssRule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))
  expect(match, `expected CSS rule for ${selector}`).not.toBeNull()
  return match![1]!
}

describe('Settings modal backdrop token and stylesheet contracts', () => {
  const tokensCss = readFileSync(path.join(RENDERER_SRC, 'styles/tokens.css'), 'utf8')
  const affectCss = readFileSync(path.join(RENDERER_SRC, 'styles/affect.css'), 'utf8')
  const globalsCss = readFileSync(path.join(RENDERER_SRC, 'styles/globals.css'), 'utf8')
  const appTsx = readFileSync(path.join(RENDERER_SRC, 'app/app.tsx'), 'utf8')

  it('maps --settings-scrim to the shared semantic --scrim token in light, dark, and installed themes', () => {
    const blocks = parseTokenBlocks(tokensCss)
    const light = blocks.get(":root, [data-theme='light']")
    const mediaDark = blocks.get(
      "@media (prefers-color-scheme: dark) :root:not([data-theme='light'])",
    )
    const dark = blocks.get("[data-theme='dark']")
    const installed = blocks.get(':root[data-installed-theme], [data-installed-theme] [data-theme]')

    expect(light).toBeDefined()
    expect(mediaDark).toBeDefined()
    expect(dark).toBeDefined()
    expect(installed).toBeDefined()

    expect(light!.get('--settings-scrim')).toBe('var(--scrim)')
    expect(mediaDark!.get('--settings-scrim')).toBe('var(--scrim)')
    expect(dark!.get('--settings-scrim')).toBe('var(--scrim)')
    expect(installed!.get('--settings-scrim')).toBe('var(--scrim)')

    // The resolved scrim visibly dims the workbench in both themes without blacking it out.
    const lightScrim = parseColor(light!.get('--scrim') ?? '')
    const darkScrim = parseColor(dark!.get('--scrim') ?? '')
    const mediaDarkScrim = parseColor(mediaDark!.get('--scrim') ?? '')
    expect(lightScrim).not.toBeNull()
    expect(darkScrim).not.toBeNull()
    expect(mediaDarkScrim).toEqual(darkScrim)
    expect(lightScrim!.a).toBeGreaterThanOrEqual(0.25)
    expect(lightScrim!.a).toBeLessThanOrEqual(0.5)
    expect(darkScrim!.a).toBeGreaterThanOrEqual(0.45)
    expect(darkScrim!.a).toBeLessThanOrEqual(0.75)

    // Both dark blocks keep matching modal shadows stronger than the light-mode drop.
    expect(dark!.get('--settings-drop')).toBe(mediaDark!.get('--settings-drop'))
    expect(dark!.get('--settings-drop')).not.toBe(light!.get('--settings-drop'))
  })

  it('covers the window with .kettu-settings-scrim, fades cleanly, and respects non-macOS title bars', () => {
    const scrimRule = cssRule(affectCss, '.kettu-settings-scrim')
    expect(scrimRule).toContain('position: fixed;')
    expect(scrimRule).toContain('inset: 0;')
    expect(scrimRule).toContain('z-index: 50;')
    expect(scrimRule).toContain('background: var(--settings-scrim);')
    expect(scrimRule).toContain('transition: opacity')

    const transitionRule = cssRule(
      affectCss,
      '.kettu-settings-scrim[data-starting-style],\n.kettu-settings-scrim[data-ending-style]',
    )
    expect(transitionRule).toContain('opacity: 0;')

    expect(globalsCss).toMatch(
      /:root\[data-client='desktop'\]:not\(\[data-platform='darwin'\]\)\s*:is\([\s\S]*?\.kettu-settings-scrim[\s\S]*?\)\s*\{\s*top:\s*var\(--title-bar\);\s*\}/,
    )
  })

  it('isolates the workbench stacking context at all viewport sizes so corner controls stay under the scrim', () => {
    expect(appTsx).toContain('className="absolute inset-0 isolate"')
    expect(appTsx).not.toContain('phone:isolate')
  })
})

describe('SettingsDialogFrame backdrop rendering and dismiss behavior', () => {
  beforeEach(() => {
    lastOnOpenChange = undefined
    closeSettingsMock.mockReset()
    settingsBackMock.mockReset()
  })

  it('renders the dimmed non-draggable backdrop before the dialog popup when open and unmounts both when closed', async () => {
    const { SettingsDialogFrame } = await import('./settings-dialog')

    const openHtml = renderToStaticMarkup(
      createElement(SettingsDialogFrame, {
        open: true,
        titleId: 'settings-title',
        children: 'Body',
      }),
    )

    const backdropMatch = openHtml.match(/<div[^>]*data-test-part="backdrop"[^>]*>/)
    const popupMatch = openHtml.match(/<div[^>]*data-test-part="popup"[^>]*>/)
    expect(backdropMatch).not.toBeNull()
    expect(popupMatch).not.toBeNull()
    expect(openHtml.indexOf(backdropMatch![0])).toBeLessThan(openHtml.indexOf(popupMatch![0]))

    expect(backdropMatch![0]).toContain('kettu-settings-scrim')
    expect(backdropMatch![0]).toContain('app-region-no-drag')
    expect(backdropMatch![0]).toContain('data-overlay-layer=""')

    expect(popupMatch![0]).toContain('kettu-settings')
    expect(popupMatch![0]).toContain('app-region-no-drag')
    expect(popupMatch![0]).toContain('data-settings-dialog=""')
    expect(popupMatch![0]).toContain('data-overlay-layer=""')

    const closedHtml = renderToStaticMarkup(
      createElement(SettingsDialogFrame, {
        open: false,
        titleId: 'settings-title',
        children: 'Body',
      }),
    )
    expect(closedHtml).toBe('')
  })

  it('closes Settings on backdrop click and routes Esc through settingsBack outside editable fields', async () => {
    const { SettingsDialogFrame } = await import('./settings-dialog')

    renderToStaticMarkup(
      createElement(SettingsDialogFrame, {
        open: true,
        titleId: 'settings-title',
        children: 'Body',
      }),
    )
    expect(lastOnOpenChange).toBeTypeOf('function')

    // Outside click on the backdrop closes Settings directly.
    const outsideCancel = vi.fn()
    lastOnOpenChange!(false, {
      reason: 'outside-press',
      cancel: outsideCancel,
      event: { target: null },
    })
    expect(outsideCancel).not.toHaveBeenCalled()
    expect(closeSettingsMock).toHaveBeenCalledTimes(1)

    // Esc outside an input cancels default close and steps back / closes via settingsBack.
    const escCancel = vi.fn()
    lastOnOpenChange!(false, {
      reason: 'escape-key',
      cancel: escCancel,
      event: { target: { tagName: 'DIV', isContentEditable: false } as unknown as EventTarget },
    })
    expect(escCancel).toHaveBeenCalledTimes(1)
    expect(settingsBackMock).toHaveBeenCalledTimes(1)

    // Esc inside a text input leaves Settings open.
    const inputCancel = vi.fn()
    lastOnOpenChange!(false, {
      reason: 'escape-key',
      cancel: inputCancel,
      event: { target: { tagName: 'INPUT', isContentEditable: false } as unknown as EventTarget },
    })
    expect(inputCancel).toHaveBeenCalledTimes(1)
    expect(settingsBackMock).toHaveBeenCalledTimes(1)
  })
})
