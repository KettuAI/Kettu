import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findChips, type ChipContext } from './chips'

const ctx = (extra: Partial<ChipContext> = {}): ChipContext => ({
  commands: ['compact', 'status'],
  skills: ['code-review', 'security-audit', '$lint'],
  resolve: (token) => (token === 'auth.ts' ? { kind: 'file', path: 'src/auth.ts' } : null),
  ...extra,
})

describe('findChips with exclusive commands and stackable skills', () => {
  it('recognizes a leading exclusive command as command and ignores exclusive commands inline', () => {
    expect(findChips('/compact hello /status', ctx())).toEqual([
      { kind: 'command', from: 0, to: 8, name: 'compact' },
    ])
  })

  it('recognizes one or multiple skills at the start and inline as skill chips', () => {
    const text = '/code-review inspect @auth.ts and apply /security-audit with /$lint'
    const chips = findChips(text, ctx())
    expect(chips.map((c) => ({ kind: c.kind, from: c.from, to: c.to }))).toEqual([
      { kind: 'skill', from: 0, to: 12 },
      { kind: 'file', from: 21, to: 29 },
      { kind: 'skill', from: 40, to: 55 },
      { kind: 'skill', from: 61, to: 67 },
    ])
  })

  it('distinguishes a leading exclusive command from stacked skills in the same message', () => {
    const text = '/status /code-review /security-audit'
    const chips = findChips(text, ctx())
    expect(chips).toEqual([
      { kind: 'command', from: 0, to: 7, name: 'status' },
      { kind: 'skill', from: 8, to: 20, name: 'code-review' },
      { kind: 'skill', from: 21, to: 36, name: 'security-audit' },
    ])
  })

  it('keeps remaining skill chips intact when one skill is removed', () => {
    const text = '/code-review /security-audit check auth'
    const withoutFirst = text.slice(12) // " /security-audit check auth"
    expect(findChips(withoutFirst, ctx())).toEqual([
      { kind: 'skill', from: 1, to: 16, name: 'security-audit' },
    ])
  })

  it('does not turn URL paths into skill chips', () => {
    const text = 'See https://example.com/code-review and /security-audit'
    const chips = findChips(text, ctx())
    expect(chips.map((c) => c.kind)).toEqual(['link', 'skill'])
  })

  it('turns full and schemeless GitHub stack URLs into link chips', () => {
    const text =
      'Review https://github.com/KettuAI/Kettu/stacks/42 and github.com/KettuAI/Kettu/stacks/7.'
    const chips = findChips(text, ctx())
    expect(chips).toEqual([
      {
        kind: 'link',
        from: 7,
        to: 49,
        url: 'https://github.com/KettuAI/Kettu/stacks/42',
        host: 'github.com',
        path: '/KettuAI/Kettu/stacks/42',
        local: false,
      },
      {
        kind: 'link',
        from: 54,
        to: 87,
        url: 'https://github.com/KettuAI/Kettu/stacks/7',
        host: 'github.com',
        path: '/KettuAI/Kettu/stacks/7',
        local: false,
      },
    ])
  })

  it('recognizes skill chips immediately before or after CJK text without spaces', () => {
    const text = '请用/code-review检查并结合/security-audit复核'
    expect(findChips(text, ctx())).toEqual([
      { kind: 'skill', from: 2, to: 14, name: 'code-review' },
      { kind: 'skill', from: 19, to: 34, name: 'security-audit' },
    ])
  })

  it('recognizes #123 and owner/repo#456 as GitHub link chips only when githubRepo is present', () => {
    const text =
      'See #2600, other/repo#42, `#999`, #L10, #ff0000, foo#123, and https://example.com/p#123'
    // Without a linked GitHub repository, #123 stays plain text and only the full URL is a link.
    expect(findChips(text, ctx())).toEqual([
      {
        kind: 'link',
        from: 62,
        to: 87,
        url: 'https://example.com/p#123',
        host: 'example.com',
        path: '/p#123',
        local: false,
      },
    ])

    // With a linked GitHub repository, #2600 and other/repo#42 resolve cleanly while code/anchors/colors stay text.
    expect(findChips(text, ctx({ githubRepo: { owner: 'KettuAI', repo: 'Kettu' } }))).toEqual([
      {
        kind: 'link',
        from: 4,
        to: 9,
        url: 'https://github.com/KettuAI/Kettu/issues/2600',
        host: 'github.com',
        path: '/KettuAI/Kettu/issues/2600',
        local: false,
      },
      {
        kind: 'link',
        from: 11,
        to: 24,
        url: 'https://github.com/other/repo/issues/42',
        host: 'github.com',
        path: '/other/repo/issues/42',
        local: false,
      },
      {
        kind: 'link',
        from: 62,
        to: 87,
        url: 'https://example.com/p#123',
        host: 'example.com',
        path: '/p#123',
        local: false,
      },
    ])
  })
})

describe('composer skill feedback and popover dismissal wiring', () => {
  const promptBox = readFileSync(join(import.meta.dirname, 'prompt-box.tsx'), 'utf8')
  const usePromptBoxSource = readFileSync(join(import.meta.dirname, 'use-prompt-box.ts'), 'utf8')
  const promptChips = readFileSync(join(import.meta.dirname, 'prompt-chips.tsx'), 'utf8')
  const chipView = readFileSync(join(import.meta.dirname, 'chip-view.tsx'), 'utf8')
  const editorChips = readFileSync(join(import.meta.dirname, 'editor-chips.tsx'), 'utf8')

  it('dismisses the slash popover atomically on skill choice without stale-caret flicker', () => {
    expect(promptBox).toContain('slashPopoverAt(text, caret, commands, completedSlash)')
    expect(promptBox).toContain('setCompletedSlash({ start: insertedStart, name: item.name })')
    expect(promptBox).toContain('setSlashDismissed(insertedStart)')
    // update() must set editor text and source caret together instead of calling changed(next) with a stale caret.
    expect(usePromptBoxSource).toMatch(
      /const update = \(next: string, at = next\.length\) => \{\s*closeHistory\(\)\s*writeDraft\(draft, next\)\s*editor\.current\?\.setText\(next, at\)\s*source\.set\(next, at\)/,
    )
  })

  it('does not keep a persistent floating strip open for selected skills', () => {
    expect(promptChips).toMatch(/const strip = activeCommand !== null && focused && !popoverOpen/)
  })

  it('renders skill chips with distinct tinted badge styling and exits typing mode after CJK separators', () => {
    expect(chipView).toContain("chip.kind === 'skill'")
    expect(chipView).toContain('SparklesIcon')
    expect(editorChips).toContain('findSkillTokens(line.text, hooks.skills)')
  })
})
