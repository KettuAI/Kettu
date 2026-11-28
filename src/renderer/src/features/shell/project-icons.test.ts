import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  PROJECT_ICON_COLORS,
  PROJECT_ICON_NAMES,
  isValidProjectEmoji,
  type ProjectIcon,
} from '@shared/project-icon'
import enSidebar from '@shared/locales/en/sidebar.json'
import zhSidebar from '@shared/locales/zh-CN/sidebar.json'

vi.mock('@renderer/components/affect/app-shell', () => ({
  FolderClosedMark: () =>
    createElement('svg', { className: 'ui-as-tray-link__folder', 'data-folder': 'closed' }),
}))

vi.mock('@renderer/components/affect/assistant-home', () => ({
  FolderMark: () =>
    createElement('svg', { className: 'ui-as-tray-link__folder', 'data-folder': 'open' }),
}))

import { ProjectMark } from './project-icon'
import {
  CURATED_PROJECT_EMOJIS,
  PROJECT_COLOR_SWATCHES,
  PROJECT_ICON_ENTRIES,
  PROJECT_ICON_GLYPHS,
  filterProjectIcons,
} from './project-icons'

describe('renderer project icon catalog', () => {
  it('maps every shared built-in icon name to a Hugeicons glyph and keywords', () => {
    expect(PROJECT_ICON_ENTRIES.map((entry) => entry.name)).toEqual([...PROJECT_ICON_NAMES])
    for (const name of PROJECT_ICON_NAMES) {
      expect(PROJECT_ICON_GLYPHS[name]).toBeDefined()
    }
    for (const entry of PROJECT_ICON_ENTRIES) {
      expect(entry.keywords.length).toBeGreaterThan(0)
    }
  })

  it('provides en and zh-CN translations for every built-in icon name and color', () => {
    for (const locale of [enSidebar, zhSidebar]) {
      expect(Object.keys(locale.project.edit.iconNames).sort()).toEqual(
        [...PROJECT_ICON_NAMES].sort(),
      )
      expect(Object.keys(locale.project.edit.iconColors).sort()).toEqual(
        ['default', ...PROJECT_ICON_COLORS].sort(),
      )
    }
  })

  it('validates every curated emoji against the shared single-emoji guard', () => {
    expect(new Set(CURATED_PROJECT_EMOJIS).size).toBe(CURATED_PROJECT_EMOJIS.length)
    for (const emoji of CURATED_PROJECT_EMOJIS) {
      expect(isValidProjectEmoji(emoji)).toBe(true)
    }
  })

  it('defines every preset color swatch in tokens.css for both light and dark modes', () => {
    const tokens = readFileSync(
      path.resolve(import.meta.dirname, '../../styles/tokens.css'),
      'utf8',
    )
    expect(PROJECT_COLOR_SWATCHES[0]).toEqual({ color: null, cssVar: null })
    expect(PROJECT_COLOR_SWATCHES.slice(1).map((s) => s.color)).toEqual([...PROJECT_ICON_COLORS])
    for (const color of PROJECT_ICON_COLORS) {
      const matches = tokens.match(new RegExp(`--project-icon-${color}:`, 'g')) ?? []
      // Light block, prefers-color-scheme: dark block, and [data-theme='dark'] block.
      expect(matches).toHaveLength(3)
    }
  })

  it('filters built-in icons by English and Chinese keywords', () => {
    expect(filterProjectIcons('')).toHaveLength(PROJECT_ICON_ENTRIES.length)
    expect(filterProjectIcons('terminal').map((e) => e.name)).toContain('terminal')
    expect(filterProjectIcons('终端').map((e) => e.name)).toContain('terminal')
    expect(filterProjectIcons('实验').map((e) => e.name)).toContain('flask')
    expect(filterProjectIcons('前端').map((e) => e.name)).toContain('globe')
    expect(filterProjectIcons('nonexistent-xyz')).toHaveLength(0)
  })

  it('renders default folder marks, colored built-in icons, and emojis consistently', () => {
    const closedDefault = renderToStaticMarkup(createElement(ProjectMark, {}))
    expect(closedDefault).toContain('ui-as-tray-link__folder')
    expect(closedDefault).not.toContain('data-project-icon')

    const openDefault = renderToStaticMarkup(createElement(ProjectMark, { open: true }))
    expect(openDefault).toContain('ui-as-tray-link__folder')
    expect(openDefault).not.toBe(closedDefault)

    const glyphDefault = renderToStaticMarkup(
      createElement(ProjectMark, { fallback: 'folder-glyph', size: 14 }),
    )
    expect(glyphDefault).toContain('<svg')
    expect(glyphDefault).not.toContain('ui-as-tray-link__folder')

    const coloredIcon = renderToStaticMarkup(
      createElement(ProjectMark, {
        icon: { kind: 'icon', value: 'terminal', color: 'blue' },
        size: 16,
      }),
    )
    expect(coloredIcon).toContain('data-project-icon="terminal"')
    expect(coloredIcon).toContain('data-project-icon-color="blue"')
    expect(coloredIcon).toContain('color:var(--project-icon-blue)')

    const plainIcon = renderToStaticMarkup(
      createElement(ProjectMark, {
        icon: { kind: 'icon', value: 'code' },
        size: 16,
      }),
    )
    expect(plainIcon).toContain('data-project-icon="code"')
    expect(plainIcon).toContain('data-project-icon-color="default"')
    expect(plainIcon).not.toContain('--project-icon-')

    const emojiIcon = renderToStaticMarkup(
      createElement(ProjectMark, {
        icon: { kind: 'emoji', value: '🦊' },
        size: 16,
      }),
    )
    expect(emojiIcon).toContain('data-project-icon="emoji"')
    expect(emojiIcon).toContain('🦊')

    // Forward-compatibility: an unrecognized icon name still renders a fallback glyph with its color.
    const unknownIcon = renderToStaticMarkup(
      createElement(ProjectMark, {
        icon: {
          kind: 'icon',
          value: 'future-icon' as ProjectIcon['value'],
          color: 'green',
        } as ProjectIcon,
      }),
    )
    expect(unknownIcon).toContain('color:var(--project-icon-green)')
    expect(unknownIcon).toContain('<svg')
  })
})
