import type { TagStyle } from '@codemirror/language'
import { tags, type Tag } from '@lezer/highlight'
import { codeToTokens, normalizeTheme, type BundledTheme, type RawThemeSetting } from 'shiki'
import { bundledThemes } from 'shiki/themes'
import { describe, expect, it } from 'vitest'
import { highlightSpecs } from './code-theme'

const specFor = (specs: TagStyle[], tag: Tag) =>
  specs.find((spec) => (Array.isArray(spec.tag) ? spec.tag : [spec.tag]).includes(tag))

const themeOf = (settings: RawThemeSetting[]) =>
  normalizeTheme({ name: 'test', type: 'light', settings })

describe('highlightSpecs', () => {
  const line = "export function greet() { return format('Hello', 42) } // greet"

  for (const id of ['github-light-default', 'github-dark-default', 'nord'] as BundledTheme[]) {
    it(`gives tokens the colors Shiki gives them in a code block: ${id}`, async () => {
      const specs = highlightSpecs(normalizeTheme((await bundledThemes[id]()).default))
      const { tokens } = await codeToTokens(line, { lang: 'typescript', theme: id })
      const shiki = (text: string) =>
        tokens
          .flat()
          .find((token) => token.content.includes(text))
          ?.color?.toLowerCase()
      const editor = (tag: Tag) => specFor(specs, tag)?.color?.toLowerCase()

      expect(editor(tags.keyword)).toBe(shiki('return'))
      expect(editor(tags.string)).toBe(shiki('Hello'))
      expect(editor(tags.comment)).toBe(shiki('// greet'))
      expect(editor(tags.number)).toBe(shiki('42'))
      expect(editor(tags.function(tags.variableName))).toBe(shiki('format'))
    })
  }

  it('takes the rule of the longest selector a scope starts with, in any order', () => {
    const specs = highlightSpecs(
      themeOf([
        { scope: 'keyword.control', settings: { foreground: '#222222' } },
        { scope: 'keyword', settings: { foreground: '#111111' } },
        { scope: 'keyword.control.import.other', settings: { foreground: '#333333' } },
      ]),
    )
    expect(specFor(specs, tags.keyword)?.color).toBe('#111111')
    expect(specFor(specs, tags.controlKeyword)?.color).toBe('#222222')
    expect(specFor(specs, tags.moduleKeyword)?.color).toBe('#222222')
  })

  it('takes each part from the longest selector that sets it, as TextMate does', () => {
    const specs = highlightSpecs(
      themeOf([
        { scope: 'keyword', settings: { foreground: '#111111' } },
        { scope: 'keyword.control', settings: { fontStyle: 'italic bold' } },
        { scope: 'markup.strikethrough', settings: { fontStyle: 'underline strikethrough' } },
      ]),
    )
    expect(specFor(specs, tags.controlKeyword)).toMatchObject({
      color: '#111111',
      fontStyle: 'italic',
      fontWeight: 'bold',
    })
    expect(specFor(specs, tags.strikethrough)).toEqual({
      tag: tags.strikethrough,
      textDecoration: 'underline line-through',
    })
  })

  it("takes a tag's next scope when the theme leaves its first one unstyled", () => {
    const specs = highlightSpecs(
      themeOf([{ scope: 'storage', settings: { foreground: '#444444' } }]),
    )
    expect(specFor(specs, tags.keyword)?.color).toBe('#444444')
  })

  it('gives a tag no rule when the theme styles none of its scopes', () => {
    const specs = highlightSpecs(
      themeOf([
        { scope: 'comment', settings: { foreground: '#555555' } },
        // A selector with the scopes around a token cannot match a tag on its own.
        { scope: 'source.ts keyword', settings: { foreground: '#666666' } },
      ]),
    )
    expect(specs).toEqual([{ tag: tags.comment, color: '#555555' }])
  })

  it('gives back a color that is not hex as the theme wrote it', () => {
    const specs = highlightSpecs(
      themeOf([{ scope: 'comment', settings: { foreground: 'inherit' } }]),
    )
    expect(specFor(specs, tags.comment)?.color).toBe('inherit')
  })
})
