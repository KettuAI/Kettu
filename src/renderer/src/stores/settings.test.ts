import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { USER_FONT_ROLES } from '@shared/settings'
import { applyUserFonts } from './settings'

function fakeRoot() {
  const properties = new Map<string, string>()
  const attributes = new Map<string, string>()
  const root = {
    style: {
      setProperty: (name: string, value: string) => properties.set(name, value),
      removeProperty: (name: string) => properties.delete(name),
    },
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
  } as unknown as HTMLElement
  return { root, properties, attributes }
}

describe('applyUserFonts and globals.css Latin prefixes', () => {
  it('clears all user font CSS properties and data attributes when unset', () => {
    const { root, properties, attributes } = fakeRoot()
    applyUserFonts(root, { ui: 'Inter', uiCjk: 'PingFang SC', codeCjk: 'LXGW WenKai' })
    applyUserFonts(root, {})

    for (const role of USER_FONT_ROLES) {
      expect(properties.has(`--user-${role}-face`)).toBe(false)
      expect(attributes.has(`data-user-font-${role}`)).toBe(false)
    }
  })

  it('sets data-user-font-<role> only when a primary face is set, preserving theme Latin features on Chinese-only overrides', () => {
    const { root, properties, attributes } = fakeRoot()
    applyUserFonts(root, {
      ui: 'Manrope',
      uiCjk: 'PingFang SC',
      proseCjk: 'LXGW WenKai',
      code: 'Fira Code',
    })

    expect(properties.get('--user-ui-face')).toBe('"Manrope", "PingFang SC", var(--theme-ui-face)')
    expect(attributes.has('data-user-font-ui')).toBe(true)

    expect(properties.get('--user-prose-face')).toBe(
      'var(--theme-prose-latin), "LXGW WenKai", var(--theme-prose-face)',
    )
    expect(attributes.has('data-user-font-prose')).toBe(false)

    expect(properties.get('--user-code-face')).toBe('"Fira Code", var(--theme-code-face)')
    expect(attributes.has('data-user-font-code')).toBe(true)
  })

  it('defines pure-Latin prefixes in globals.css without system-ui or Platform Chinese', () => {
    const cssPath = fileURLToPath(new URL('../styles/globals.css', import.meta.url))
    const css = readFileSync(cssPath, 'utf8')
    const systemLatin = /--face-system-latin:\s*([^;]+);/.exec(css)?.[1] ?? ''
    const systemMonoLatin = /--face-system-mono-latin:\s*([^;]+);/.exec(css)?.[1] ?? ''

    expect(systemLatin).not.toBe('')
    expect(systemLatin).not.toContain('system-ui')
    expect(systemLatin).not.toContain('Platform Chinese')

    expect(systemMonoLatin).not.toBe('')
    expect(systemMonoLatin).not.toContain('ui-monospace')
    expect(systemMonoLatin).not.toContain('Platform Chinese')

    expect(css).toContain('--theme-ui-latin:')
    expect(css).toContain('--theme-prose-latin:')
    expect(css).toContain('--theme-code-latin:')
  })
})
