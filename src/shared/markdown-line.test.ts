import { describe, expect, it } from 'vitest'
import { markdownFirstLine } from './markdown-line'

describe('markdownFirstLine', () => {
  it('drops heading, quote, list and task marks', () => {
    expect(markdownFirstLine('## Morning briefing\n\nThree commits.')).toBe('Morning briefing')
    expect(markdownFirstLine("> Summarize yesterday's commits")).toBe(
      "Summarize yesterday's commits",
    )
    expect(markdownFirstLine('> - Three commits\n> - Two reviews')).toBe('Three commits')
    expect(markdownFirstLine('1. Fixed the clock\n2. Pushed the branch')).toBe('Fixed the clock')
    expect(markdownFirstLine('- [x] Ran the tests')).toBe('Ran the tests')
  })

  it('keeps the text of emphasis, strikethrough and inline code', () => {
    expect(markdownFirstLine('> **Summary**: 3 commits')).toBe('Summary: 3 commits')
    expect(markdownFirstLine('**All** tests _passed_')).toBe('All tests passed')
    expect(markdownFirstLine('~~Two~~ Three failures')).toBe('Two Three failures')
    expect(markdownFirstLine('Run `pnpm test` again')).toBe('Run pnpm test again')
  })

  it("shows a link's text without its address, and an address written out", () => {
    expect(markdownFirstLine('See [the report](https://example.com/r "Report") first')).toBe(
      'See the report first',
    )
    expect(markdownFirstLine('Deployed to https://example.com/app and <https://example.com>')).toBe(
      'Deployed to https://example.com/app and https://example.com',
    )
  })

  it("shows an image's alt text", () => {
    expect(markdownFirstLine('![Build passed](badge.svg) on main')).toBe('Build passed on main')
  })

  it("shows a code fence's first line of code", () => {
    expect(markdownFirstLine('```ts\n\nconst a = 1\nconst b = 2\n```')).toBe('const a = 1')
  })

  it('resolves escapes and collapses spaces', () => {
    expect(markdownFirstLine('3 \\*new\\* issues')).toBe('3 *new* issues')
    expect(markdownFirstLine('Two   **spaced**    words')).toBe('Two spaced words')
  })

  it('skips blank lines and a thematic break before the text', () => {
    expect(markdownFirstLine('\n\n---\n\nAll clear')).toBe('All clear')
  })

  it('takes the first line of a paragraph', () => {
    expect(markdownFirstLine('Checked the logs\nand found nothing')).toBe('Checked the logs')
  })

  it('reads Chinese text', () => {
    expect(markdownFirstLine('## **总结**：昨天有 3 个提交')).toBe('总结：昨天有 3 个提交')
  })

  it('gives an empty line for an answer without text', () => {
    expect(markdownFirstLine('')).toBe('')
    expect(markdownFirstLine('---\n\n```\n```')).toBe('')
  })
})
