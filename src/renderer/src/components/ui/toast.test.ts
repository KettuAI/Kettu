import { describe, expect, it } from 'vitest'
import { css as toasterCss } from '@renderer/components/affect/toaster'

function ruleBody(stylesheet: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = stylesheet.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))
  expect(match, `expected CSS rule for ${selector}`).not.toBeNull()
  return match![1]!
}

describe('Toaster overflow and line-clamp CSS contract', () => {
  it('clamps .ui-ts__title to 2 lines with overflow hidden and anywhere wrapping', () => {
    const titleRule = ruleBody(toasterCss, '.ui-ts__title')
    expect(titleRule).toContain('display: -webkit-box;')
    expect(titleRule).toContain('-webkit-box-orient: vertical;')
    expect(titleRule).toContain('-webkit-line-clamp: 2;')
    expect(titleRule).toContain('overflow: hidden;')
    expect(titleRule).toContain('overflow-wrap: anywhere;')
  })

  it('clamps .ui-ts__desc to 3 lines with overflow hidden and anywhere wrapping', () => {
    const descRule = ruleBody(toasterCss, '.ui-ts__desc')
    expect(descRule).toContain('display: -webkit-box;')
    expect(descRule).toContain('-webkit-box-orient: vertical;')
    expect(descRule).toContain('-webkit-line-clamp: 3;')
    expect(descRule).toContain('overflow: hidden;')
    expect(descRule).toContain('overflow-wrap: anywhere;')
  })

  it('keeps .ui-ts__text shrinkable inside the flex card so long tokens wrap instead of widening', () => {
    const textRule = ruleBody(toasterCss, '.ui-ts__text')
    expect(textRule).toContain('flex: 1;')
    expect(textRule).toContain('min-width: 0;')
  })
})
