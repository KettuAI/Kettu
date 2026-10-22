import { describe, expect, it } from 'vitest'
import { LOCALES } from '../locale'

const FILES = import.meta.glob<Record<string, unknown>>('./*/*.json', {
  eager: true,
  import: 'default',
})
const DECLARATION = Object.values(
  import.meta.glob<string>('../i18next.d.ts', { eager: true, query: '?raw', import: 'default' }),
)[0]!
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/

function namespaces(locale: string): string[] {
  return Object.keys(FILES)
    .filter((path) => path.startsWith(`./${locale}/`))
    .map((path) => path.slice(`./${locale}/`.length, -'.json'.length))
    .sort()
}

function load(locale: string, ns: string): Record<string, unknown> {
  return FILES[`./${locale}/${ns}.json`]!
}

/** Every leaf as `a.b.c` → value. */
function flatten(value: Record<string, unknown>, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (const [key, child] of Object.entries(value)) {
    const path = prefix + key
    if (typeof child === 'object' && child !== null && !Array.isArray(child)) {
      for (const [k, v] of flatten(child as Record<string, unknown>, `${path}.`)) out.set(k, v)
    } else {
      out.set(path, child)
    }
  }
  return out
}

/** Keys with plural forms folded into one, holding the `_other` form. */
function messages(locale: string, ns: string): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (const [key, value] of flatten(load(locale, ns))) {
    const base = key.replace(PLURAL_SUFFIX, '')
    if (base === key || key.endsWith('_other')) out.set(base, value)
    else if (!out.has(base)) out.set(base, undefined)
  }
  return out
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)].map((m) => m[1]!).sort()
}

const SOURCE = 'en'

describe('locale catalogs', () => {
  it('have the same namespaces in every language', () => {
    for (const locale of LOCALES) expect(namespaces(locale)).toEqual(namespaces(SOURCE))
  })

  it('are all typed in i18next.d.ts', () => {
    for (const ns of namespaces(SOURCE)) {
      expect(DECLARATION).toContain(`from './locales/en/${ns}.json'`)
      expect(DECLARATION).toContain(`${ns}: typeof ${ns}`)
    }
  })

  for (const ns of namespaces(SOURCE)) {
    describe(ns, () => {
      const source = messages(SOURCE, ns)

      for (const locale of LOCALES) {
        it(`${locale} has every message, with text and the same placeholders`, () => {
          const target = messages(locale, ns)
          expect([...target.keys()].sort()).toEqual([...source.keys()].sort())
          for (const [key, text] of target) {
            expect(typeof text, `${locale}/${ns}: ${key} needs an _other form`).toBe('string')
            expect((text as string).trim(), `${locale}/${ns}: ${key} is empty`).not.toBe('')
            expect(placeholders(text as string), `${locale}/${ns}: ${key}`).toEqual(
              placeholders(source.get(key) as string),
            )
          }
        })
      }
    })
  }
})
