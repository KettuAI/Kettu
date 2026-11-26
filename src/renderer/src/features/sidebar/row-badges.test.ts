import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { badgeInUse } from './row-badges'

const AFFECT_CSS_PATH = fileURLToPath(new URL('../../styles/affect.css', import.meta.url))
const APP_SHELL_PATH = fileURLToPath(
  new URL('../../components/affect/app-shell.tsx', import.meta.url),
)
const PHONE_CSS_PATH = fileURLToPath(new URL('../../styles/phone.css', import.meta.url))
const GLOBALS_CSS_PATH = fileURLToPath(new URL('../../styles/globals.css', import.meta.url))
const NAV_ENDS_PATH = fileURLToPath(new URL('./nav-ends.tsx', import.meta.url))

describe('badgeInUse', () => {
  it('returns false when row is null or has no active badge match', () => {
    expect(badgeInUse(null)).toBe(false)
    const row = { querySelector: () => null } as unknown as HTMLElement
    expect(badgeInUse(row)).toBe(false)
  })

  it('queries hovered or popup-open subagent, worktree, and PR badges', () => {
    let seenSelector = ''
    const row = {
      querySelector: (selector: string) => {
        seenSelector = selector
        return {}
      },
    } as unknown as HTMLElement

    expect(badgeInUse(row)).toBe(true)
    expect(seenSelector).toContain('[data-subagent-badge]')
    expect(seenSelector).toContain('[data-worktree-mark]')
    expect(seenSelector).toContain('[data-pr-badge]')
    expect(seenSelector).toContain(':hover')
    expect(seenSelector).toContain('[data-popup-open]')
  })
})

describe('sidebar badged row spacing styles', () => {
  const css = readFileSync(AFFECT_CSS_PATH, 'utf8')
  const start = css.indexOf('@property --kettu-row-cover')
  const end = css.indexOf("/* A deleted row's dust")
  const section = css.slice(start, end)

  it('keeps the permanent 42px end reservation on folder rows only, not idle badged session rows', () => {
    expect(section).toMatch(
      /\.ui-as-chat-folder-row:has\(> \.ui-as-chat-row__tools > \*\) \.kettu-row-end\s*\{\s*min-width: 42px;/,
    )
    expect(section).not.toMatch(
      /\.ui-as-chat-folder-row:has\(> \.ui-as-chat-row__tools > \*\) \.kettu-row-end,\s*\.ui-as-chat-row:has\(\[data-subagent-badge\]/,
    )
  })

  it('collapses empty idle end slots and reserves 16px for active indicators on badged rows', () => {
    expect(section).toContain(
      '.ui-as-chat-row:has([data-subagent-badge], [data-worktree-mark], [data-pr-badge])',
    )
    expect(section).toMatch(/\.kettu-row-end\s*\{[^}]*min-width:\s*16px;[^}]*margin-left:\s*0;/s)
    expect(section).toMatch(
      /\.kettu-row-end:not\(:has\(> :not\(:empty\)\)\)\s*\{[^}]*width:\s*0;[^}]*min-width:\s*0;[^}]*margin-left:\s*-8px;[^}]*overflow:\s*hidden;/s,
    )
  })

  it('expands the end slot to 42px on hover, focus-visible, open menu, or open badge popup', () => {
    expect(section).toMatch(
      /:has\(> \.ui-as-chat-row__tools > \*\):is\(\s*:hover,\s*:has\(:focus-visible\),\s*\[data-menu\],\s*:has\(:is\(\[data-subagent-badge\], \[data-worktree-mark\], \[data-pr-badge\]\)\[data-popup-open\]\)\s*\)/,
    )
    expect(section).toMatch(/\.kettu-row-end\s*\{\s*min-width:\s*42px;\s*\}/)
    expect(section).toMatch(
      /\.kettu-row-end:not\(:has\(> :not\(:empty\)\)\)\s*\{\s*width:\s*42px;\s*margin-left:\s*0;\s*\}/,
    )
  })

  it('disables badged row slide transitions for prefers-reduced-motion and data-reduce-motion', () => {
    expect(section).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.ui-as-chat-row:has\(\[data-subagent-badge\], \[data-worktree-mark\], \[data-pr-badge\]\) \.kettu-row-end[^}]*transition:\s*none !important;/s,
    )
    expect(section).toMatch(
      /:root\[data-reduce-motion='always'\]\s+\.ui-as-chat-row:has\(\[data-subagent-badge\], \[data-worktree-mark\], \[data-pr-badge\]\)\s+\.kettu-row-end[^}]*transition:\s*none !important;/s,
    )
  })

  it('scopes hover-only row spacing to fine-pointer desktop widths and keeps touch/phone widths clear', () => {
    expect(section).toContain('@media (hover: none), (pointer: coarse), (max-width: 719px)')
    expect(section).toContain('@media (hover: hover) and (pointer: fine) and (min-width: 720px)')
    expect(section).not.toMatch(/@media \(hover: hover\)\s*\{/)
    expect(section).toMatch(
      /:is\(\.ui-as-chat-row,\s*\.ui-as-chat-folder-row\)\s+\.kettu-row-end:not\(:has\(> :not\(:empty\)\)\)\s*\{\s*display:\s*none;\s*\}/,
    )
    expect(css).toMatch(
      /@media \(hover: none\),\s*\(pointer: coarse\),\s*\(max-width: 719px\)\s*\{\s*\.kettu-side-label__arrow\s*\{\s*opacity:\s*1;\s*\}\s*\}/,
    )
  })
})

describe('mobile and touch sidebar tool visibility styles', () => {
  const appShell = readFileSync(APP_SHELL_PATH, 'utf8')
  const phoneCss = readFileSync(PHONE_CSS_PATH, 'utf8')
  const globalsCss = readFileSync(GLOBALS_CSS_PATH, 'utf8')
  const navEnds = readFileSync(NAV_ENDS_PATH, 'utf8')

  it('reveals sidebar row tools and folder arrows for coarse pointers and phone viewports too', () => {
    expect(appShell).toContain('@media (hover: none), (pointer: coarse), (max-width: 719px)')
    expect(appShell).toMatch(
      /@media \(hover: none\), \(pointer: coarse\), \(max-width: 719px\) \{[^}]*\.ui-as-chat-row__tools, \.ui-as-chat-folder-row \.ui-as-chat-row__tools \{ opacity: 1; \}/s,
    )
    expect(appShell).toMatch(
      /@media \(hover: none\), \(pointer: coarse\), \(max-width: 719px\) \{[\s\S]*?\.ui-as-chat-folder__arrow \{ opacity: 1; \}/,
    )
    expect(appShell).toMatch(
      /\.ui-as-chat-folder-row:has\(> \.ui-as-chat-row__tools > :not\(\.ui-as-chat-row__pin\) ~ :not\(\.ui-as-chat-row__pin\)\) > \.ui-as-chat-folder \{ padding-right: 60px; \}/,
    )
  })

  it('hides NavShortcut on phone viewports and defines the no-hover custom variant', () => {
    expect(navEnds).toContain('<kbd')
    expect(navEnds).toContain('kettu-nav-shortcut')
    expect(navEnds).toContain('phone:hidden')
    expect(phoneCss).toContain('.kettu-nav-shortcut')
    expect(phoneCss).toContain("[data-slot='dropdown-menu-shortcut']")
    expect(phoneCss).toContain("[data-slot='context-menu-shortcut']")
    expect(globalsCss).toContain(
      '@custom-variant no-hover (@media (hover: none), (pointer: coarse), (max-width: 719px));',
    )
  })
})
