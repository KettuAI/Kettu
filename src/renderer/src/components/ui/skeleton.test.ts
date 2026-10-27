import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Skeleton } from './skeleton'

function classesOf(markup: string) {
  return /class="([^"]*)"/.exec(markup)?.[1]
}

describe('Skeleton', () => {
  it('renders a div with the skeleton slot by default', () => {
    const markup = renderToStaticMarkup(createElement(Skeleton, { className: 'h-3 w-20' }))

    expect(markup.startsWith('<div')).toBe(true)
    expect(markup).toContain('data-slot="skeleton"')
    expect(classesOf(markup)).toContain('animate-pulse rounded-md bg-muted h-3 w-20')
  })

  it('renders a span when given render, with the same slot and classes', () => {
    const div = renderToStaticMarkup(createElement(Skeleton, { className: 'h-3 w-20' }))
    const span = renderToStaticMarkup(
      createElement(Skeleton, { className: 'h-3 w-20', render: createElement('span') }),
    )

    expect(span.startsWith('<span')).toBe(true)
    expect(span).toContain('data-slot="skeleton"')
    expect(classesOf(span)).toBe(classesOf(div))
  })
})
