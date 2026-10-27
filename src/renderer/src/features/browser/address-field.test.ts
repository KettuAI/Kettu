import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AddressField } from './address-field'

type Region = 'drag' | 'no-drag'

const VOID = new Set(['br', 'hr', 'img', 'input', 'link', 'meta'])

function regionOf(attributes: string): Region | null {
  const classes = /class="([^"]*)"/.exec(attributes)?.[1].split(/\s+/) ?? []
  if (classes.includes('app-region-drag')) return 'drag'
  if (classes.includes('app-region-no-drag')) return 'no-drag'
  return null
}

/** The nearest region on an input or its ancestors, as static markup nests them. */
function inputRegion(markup: string): Region | undefined {
  const ancestors: (Region | null)[] = []
  for (const [, closing, name, attributes] of markup.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g)) {
    if (closing) {
      ancestors.pop()
      continue
    }
    if (name.toLowerCase() === 'input') return regionOf(attributes) ?? ancestors.at(-1) ?? undefined
    const nearest = regionOf(attributes) ?? ancestors.at(-1) ?? null
    if (!attributes.endsWith('/') && !VOID.has(name.toLowerCase())) ancestors.push(nearest)
  }
  return undefined
}

describe('AddressField', () => {
  it('takes clicks out of the drag region of the header around it', () => {
    const markup = renderToStaticMarkup(
      createElement(
        'div',
        { className: 'app-region-drag' },
        createElement(AddressField, { url: 'https://example.com/', onNavigate: () => {} }),
      ),
    )

    expect(inputRegion(markup)).toBe('no-drag')
  })
})
