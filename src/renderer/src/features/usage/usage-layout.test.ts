import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DateRangePicker } from '@renderer/components/affect/date-range-picker'

const RENDERER_SRC = path.resolve(import.meta.dirname, '../..')

/** Extracts the declaration block for an exact CSS selector. */
function cssRule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))
  expect(match, `expected CSS rule for ${selector}`).not.toBeNull()
  return match![1]
}

describe('Usage header and date picker responsive layout contracts', () => {
  const usageCss = readFileSync(path.join(RENDERER_SRC, 'features/usage/usage.css'), 'utf8')
  const phoneCss = readFileSync(path.join(RENDERER_SRC, 'styles/phone.css'), 'utf8')

  it('allows Usage header control groups and pickers to wrap and shrink without overflowing narrow panes', () => {
    const groupRule = cssRule(usageCss, '.k-u__group')
    expect(groupRule).toContain('flex-wrap: wrap;')
    expect(groupRule).toContain('min-width: 0;')
    expect(groupRule).toContain('max-width: 100%;')

    const pickRule = cssRule(usageCss, '.k-u-pick')
    expect(pickRule).toContain('max-width: 100%;')
    expect(pickRule).toContain('min-width: 0;')
  })

  it('caps the Usage calendar panel width to the k-usage container inline size rather than 100vw', () => {
    expect(usageCss).toContain('container: k-usage / inline-size;')
    const calRule = cssRule(usageCss, '.k-u__cal')
    expect(calRule).toContain('--ui-drpc-panel-width: min(652px, calc(100cqi - 16px));')
  })

  it('wraps Usage controls cleanly on phone/narrow web viewports without an overflow-x clipping scroller', () => {
    const usageBlockIndex = phoneCss.indexOf(':root .k-u__head')
    expect(usageBlockIndex).toBeGreaterThan(-1)
    const nextMediaIndex = phoneCss.indexOf('@media', usageBlockIndex)
    const usagePhoneSection =
      nextMediaIndex === -1
        ? phoneCss.slice(usageBlockIndex)
        : phoneCss.slice(usageBlockIndex, nextMediaIndex)

    expect(usagePhoneSection).toContain('flex-wrap: wrap;')
    expect(usagePhoneSection).not.toContain('overflow-x: auto')
    expect(usagePhoneSection).not.toContain('flex-wrap: nowrap')
  })

  it('renders DateRangePicker dialog with overlay marker, placement attributes, presets rail, and footer actions', () => {
    const today = new Date(2026, 10, 27)
    const html = renderToStaticMarkup(
      createElement(DateRangePicker, {
        className: 'k-u__cal',
        align: 'end',
        compare: false,
        defaultOpen: true,
        today,
        max: today,
        value: { start: new Date(2026, 9, 29), end: today },
      }),
    )

    expect(html).toContain('class="ui-drpc k-u__cal"')
    expect(html).toContain('data-overlay-layer=""')
    expect(html).toContain('data-side="bottom"')
    expect(html).toContain('data-align="end"')
    expect(html).toContain('role="dialog"')
    expect(html).toContain('role="listbox"')
    expect(html).toContain('ui-drpc__presets')
    expect(html).toContain('ui-drpc__foot')
    expect(html).toContain('Cancel')
    expect(html).toContain('Apply')
  })
})
