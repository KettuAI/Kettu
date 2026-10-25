import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Button, buttonVariants } from './button'

describe('buttonVariants', () => {
  it('drops the base text size when compact sets its own', () => {
    const classes = buttonVariants({ size: 'compact' })

    expect(classes).toContain('text-control')
    expect(classes).not.toContain('text-ui')
  })

  it('drops the base text size when xs sets its own', () => {
    const classes = buttonVariants({ size: 'xs' })

    expect(classes).toContain('text-xs')
    expect(classes).not.toContain('text-ui')
  })

  it('keeps the base text size for the default size', () => {
    expect(buttonVariants()).toContain('text-ui')
  })
})

describe('buttonVariants depth', () => {
  it('draws the primary button as a gradient that lightens on hover', () => {
    const classes = buttonVariants({ variant: 'default' })

    expect(classes).toContain('bg-(image:--primary-gradient)')
    expect(classes).toContain('hover:bg-(image:--primary-gradient-hover)')
    expect(classes).toContain('shadow-primary')
    expect(classes).not.toContain('hover:bg-primary/80')
  })

  it('raises the outline button and darkens its line on hover instead of its fill', () => {
    const classes = buttonVariants({ variant: 'outline' })

    expect(classes).toContain('shadow-outline')
    expect(classes).toContain('hover:shadow-outline-hover')
    expect(classes).not.toContain('hover:bg-accent')
  })

  it('sinks a pressed quiet button', () => {
    expect(buttonVariants({ variant: 'quiet' })).toContain('aria-pressed:shadow-sunk')
  })
})

describe('Button', () => {
  it.each([
    ['default', 'default'],
    ['outline', 'xs'],
    ['secondary', 'sm'],
    ['ghost', 'compact'],
    ['link', 'icon'],
  ] as const)('matches buttonVariants for the %s style at %s', (variant, size) => {
    const classes = buttonVariants({ variant, size })
    const markup = renderToStaticMarkup(createElement(Button, { variant, size }))
    const unescaped = markup.replaceAll('&amp;', '&').replaceAll('&#x27;', "'")

    expect(unescaped).toContain(`class="${classes}"`)
  })
})
