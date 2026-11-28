import { describe, expect, it, vi } from 'vitest'
import type { RepositoryReferenceItem } from '@shared/git'

vi.mock('@renderer/lib/platform', () => ({
  isMac: true,
  isWindows: false,
  isLinux: false,
  isMod: () => false,
  isWeb: false,
  platform: 'darwin',
  hasBand: false,
  formatShortcut: (shortcut: string) => shortcut,
}))

import {
  fencedCodeLines,
  filterAndRankReferences,
  hashPickerShown,
  hashRefAt,
  isInsideCodeFence,
  replaceHashRef,
} from './github-picker'
import { popoverKey } from './mentions'
import { resolvePopoverPlacement, viewportBounds } from './popover-position'

const ITEMS: RepositoryReferenceItem[] = [
  {
    kind: 'issue',
    owner: 'KettuAI',
    repo: 'Kettu',
    number: 2600,
    title: 'Support # picker for GitHub issues and PRs',
    url: 'https://github.com/KettuAI/Kettu/issues/2600',
    state: 'open',
    updatedAt: 1000,
  },
  {
    kind: 'pull',
    owner: 'KettuAI',
    repo: 'Kettu',
    number: 2652,
    title: 'Recognize schemeless github links',
    url: 'https://github.com/KettuAI/Kettu/pull/2652',
    state: 'merged',
    updatedAt: 2000,
  },
  {
    kind: 'issue',
    owner: 'KettuAI',
    repo: 'Kettu',
    number: 26,
    title: 'Early issue about markdown',
    url: 'https://github.com/KettuAI/Kettu/issues/26',
    state: 'completed',
    updatedAt: 500,
  },
  {
    kind: 'pull',
    owner: 'KettuAI',
    repo: 'Kettu',
    number: 2901,
    title: 'Fix picker focus handling for #2600',
    url: 'https://github.com/KettuAI/Kettu/pull/2901',
    state: 'draft',
    updatedAt: 3000,
  },
]

describe('hashRefAt trigger detection and Markdown/code guards (#2600)', () => {
  it('triggers on word-leading # and #query at line start, after whitespace, or after CJK text', () => {
    expect(hashRefAt('#', 1)).toEqual({ start: 0, query: '' })
    expect(hashRefAt('#26', 3)).toEqual({ start: 0, query: '26' })
    expect(hashRefAt('Fix #picker', 11)).toEqual({ start: 4, query: 'picker' })
    expect(hashRefAt('看一下#2600', 8)).toEqual({ start: 3, query: '2600' })
    expect(hashRefAt('line1\n#fix', 10)).toEqual({ start: 6, query: 'fix' })
  })

  it('does not trigger on Markdown headings (# Heading, ## Title, ### Sub)', () => {
    expect(hashRefAt('# ', 2)).toBeNull()
    expect(hashRefAt('# Heading', 9)).toBeNull()
    expect(hashRefAt('##', 2)).toBeNull()
    expect(hashRefAt('## Title', 8)).toBeNull()
    expect(hashRefAt('###', 3)).toBeNull()
    expect(hashRefAt('line1\n## Heading', 16)).toBeNull()
  })

  it('does not trigger inside words, URLs, paths, or invalid query punctuation', () => {
    expect(hashRefAt('foo#123', 7)).toBeNull()
    expect(hashRefAt('https://example.com#sec', 23)).toBeNull()
    expect(hashRefAt('file.ts#L10', 11)).toBeNull()
    expect(hashRefAt('&#123', 5)).toBeNull()
    expect(hashRefAt('#/path', 6)).toBeNull()
    expect(hashRefAt('#a:b', 4)).toBeNull()
    expect(hashRefAt('#a#b', 4)).toBeNull()
    expect(hashRefAt('#123', null)).toBeNull()
  })

  it('does not trigger inside open/closed fenced code blocks or inline code spans', () => {
    const openFence = '```python\n# comment'
    expect(isInsideCodeFence(openFence, openFence.length)).toBe(true)
    expect(hashRefAt('```python\n#26', 13)).toBeNull()

    const closedFence = '```python\n#26\n```\nSee #26'
    expect(hashRefAt(closedFence, 13)).toBeNull()
    expect(hashRefAt(closedFence, closedFence.length)).toEqual({ start: 22, query: '26' })
    expect([...fencedCodeLines(closedFence)]).toEqual([1, 2, 3])

    expect(hashRefAt('Run `#26` now', 8)).toBeNull()
    expect(hashRefAt('Run `#26` and #26', 17)).toEqual({ start: 14, query: '26' })
  })
})

describe('hashPickerShown, replaceHashRef, filterAndRankReferences, and keyboard handling (#2600)', () => {
  it('suppresses the picker after Esc dismisses that # while preserving text, and guards IME composition', () => {
    const trigger = { start: 4, query: '26' }
    expect(hashPickerShown(trigger, null, null)).toBe(true)
    expect(hashPickerShown(trigger, 4, null)).toBe(false)
    expect(hashPickerShown(trigger, 0, null)).toBe(true)
    expect(hashPickerShown(trigger, null, { open: false })).toBe(false)
    expect(hashPickerShown(trigger, null, { open: true })).toBe(true)
  })

  it('replaces #query with canonical GitHub URL and trailing space while preserving surrounding text', () => {
    const url = 'https://github.com/KettuAI/Kettu/issues/2600'
    expect(replaceHashRef('Check #260', { start: 6, query: '260' }, url)).toEqual({
      text: `Check ${url} `,
      caret: 6 + url.length + 1,
    })
    // Reuses an existing space after the caret without doubling it.
    expect(replaceHashRef('Check #260 please', { start: 6, query: '260' }, url)).toEqual({
      text: `Check ${url} please`,
      caret: 6 + url.length + 1,
    })
    // Preserves characters immediately after the caret when picking mid-text.
    expect(replaceHashRef('Check #26, thanks', { start: 6, query: '26' }, url)).toEqual({
      text: `Check ${url} , thanks`,
      caret: 6 + url.length + 1,
    })
  })

  it('ranks exact number match first, then number prefix, then title match, then newest updated', () => {
    // Empty query: newest updated first.
    expect(filterAndRankReferences(ITEMS, '').map((r) => r.item.number)).toEqual([
      2901, 2652, 2600, 26,
    ])
    // Numeric query "26": exact #26 > prefixes #2652/#2600 (newest first) > title match #2901 ("#2600").
    const byNum = filterAndRankReferences(ITEMS, '26')
    expect(byNum.map((r) => r.item.number)).toEqual([26, 2652, 2600, 2901])
    expect(byNum[0]!.numberMatches).toEqual([1, 2])
    expect(byNum[3]!.titleMatches.length).toBe(2)

    // Title query "picker": matches both items with "picker" in title, newest first.
    const byTitle = filterAndRankReferences(ITEMS, 'picker')
    expect(byTitle.map((r) => r.item.number)).toEqual([2901, 2600])
    expect(byTitle[0]!.titleMatches.length).toBe('picker'.length)
  })

  it('handles Esc, Enter, Tab, IME composition, and empty results cleanly in popoverKey', () => {
    const base = {
      composing: false,
      modified: false,
      slashOpen: false,
      mentionOpen: false,
      mentionRows: false,
      hashOpen: true,
      hashRows: true,
    }
    expect(popoverKey('Escape', base)).toBe('popover')
    expect(popoverKey('Enter', base)).toBe('popover')
    expect(popoverKey('Tab', base)).toBe('choose')
    // When no rows match, Enter still sends instead of blocking the composer.
    expect(popoverKey('Enter', { ...base, hashRows: false })).toBe('composer')
    expect(popoverKey('Tab', { ...base, hashRows: false })).toBe('composer')
    expect(popoverKey('Escape', { ...base, hashRows: false })).toBe('popover')
    // IME composition blocks all popover keys.
    expect(popoverKey('Enter', { ...base, composing: true })).toBe('block')
    expect(popoverKey('Escape', { ...base, composing: true })).toBe('block')
    // Modified keys pass through to composer.
    expect(popoverKey('Enter', { ...base, modified: true })).toBe('composer')
  })

  it('anchors the hash popover horizontally at the # trigger character like mention popovers', () => {
    const placement = resolvePopoverPlacement({
      kind: 'hash',
      box: { top: 620, bottom: 680, left: 120, right: 760 },
      trigger: { top: 650, bottom: 674, left: 280, right: 290 },
      viewport: viewportBounds(820, { top: 40, bottom: 5 }),
    })
    expect(placement).toEqual({
      side: 'top',
      anchor: { x: 280, y: 620, width: 480, height: 60 },
    })
  })
})
