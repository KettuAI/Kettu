import { Linter } from 'eslint'
import tseslint from 'typescript-eslint'
import { describe, expect, it } from 'vitest'
import plugin, { rules } from './eslint-plugin.mjs'

function lint(code: string, filename = 'src/renderer/src/x.tsx') {
  return new Linter().verify(
    code,
    [
      {
        files: ['**/*.tsx'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        plugins: { overbench: plugin },
        rules: { 'overbench/no-color-literals': 'error' },
      },
    ],
    filename,
  )
}

describe('overbench/no-color-literals', () => {
  it('is exported by name and as the default plugin', () => {
    expect(Object.keys(rules)).toEqual(['no-color-literals'])
    expect(plugin.rules).toBe(rules)
  })

  it('reports each color in a string, at its position', () => {
    const messages = lint('export const a = "p-2 bg-red-500 #fff"')
    expect(messages.map((m) => [m.line, m.column, m.message.split(':')[0]])).toEqual([
      [1, 23, "Color literal 'bg-red-500'"],
      [1, 34, "Color literal '#fff'"],
    ])
    expect(messages[0].message).toContain('src/renderer/src/styles/tokens.css')
  })

  it('reports colors in template text and JSX attributes, not in the expressions', () => {
    const messages = lint(
      'export const a = (x: string) => <i className={`text-white ${x}`} fill="#000" />',
    )
    expect(messages.map((m) => m.message.split(':')[0])).toEqual([
      "Color literal 'text-white'",
      "Color literal '#000'",
    ])
  })

  it('reports an escaped string at the string itself', () => {
    const [message] = lint('export const a = "bg-black\\n"')
    expect(message).toMatchObject({ line: 1, column: 18 })
  })

  it('leaves tokens, regular expressions, numbers and comments alone', () => {
    const code = [
      'export const a = "bg-background text-muted-foreground"',
      'export const b = /#fff/',
      'export const c = 0xfff',
      'export const d = `color-mix(in srgb, var(--a) 10%, transparent)`',
      '// bg-red-500 #fff',
      'export const e = "#root"',
    ].join('\n')
    expect(lint(code)).toEqual([])
  })
})
