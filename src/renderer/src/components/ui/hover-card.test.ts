import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@base-ui/react/preview-card', () => ({
  PreviewCard: {
    Root: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
      createElement('div', { 'data-mock-root': '', ...props }, children),
    Trigger: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
      createElement('button', { type: 'button', ...props }, children),
    Portal: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
      createElement('div', { 'data-mock-portal': '', ...props }, children),
    Positioner: ({
      children,
      className,
      side,
      align,
    }: {
      children?: ReactNode
      className?: string
      side?: string
      align?: string
    }) =>
      createElement(
        'div',
        { 'data-mock-positioner': '', className, 'data-side': side, 'data-align': align },
        children,
      ),
    Popup: ({
      children,
      className,
      ...props
    }: {
      children?: ReactNode
      className?: string
      [key: string]: unknown
    }) => createElement('div', { ...props, className }, children),
  },
}))

import { HoverCardContent } from './hover-card'

const RENDERER_SRC = fileURLToPath(new URL('../..', import.meta.url))

describe('HoverCardContent motion and reduced-motion attributes', () => {
  it('uses Base UI interruptible starting/ending transitions with symmetric 4px side offsets and reduced-motion guards', () => {
    const html = renderToStaticMarkup(
      createElement(
        HoverCardContent,
        { side: 'right', align: 'start', className: 'w-[340px]' },
        'Card',
      ),
    )

    expect(html).toContain('data-slot="hover-card-content"')
    expect(html).toContain('data-overlay-layer=""')
    expect(html).toContain('transition-[opacity,transform]')
    expect(html).toContain('duration-200')
    expect(html).toContain('ease-out-quint')
    expect(html).toContain('data-[ending-style]:duration-(--duration-fast)')
    expect(html).toContain('data-[ending-style]:ease-standard')

    // Symmetric directional offsets on enter and exit across all sides.
    expect(html).toContain('data-[side=right]:[--hover-x:-4px]')
    expect(html).toContain('data-[side=left]:[--hover-x:4px]')
    expect(html).toContain('data-[side=top]:[--hover-y:4px]')
    expect(html).toContain('data-[side=bottom]:[--hover-y:-4px]')
    expect(html).toContain('data-[side=inline-end]:[--hover-x:-4px]')
    expect(html).toContain('data-[side=inline-start]:[--hover-x:4px]')
    expect(html).toContain('data-[starting-style]:opacity-0')
    expect(html).toContain('data-[ending-style]:opacity-0')
    expect(html).toContain(
      'data-[starting-style]:[transform:translate3d(var(--hover-x,0px),var(--hover-y,0px),0)_scale(0.985)]',
    )
    expect(html).toContain(
      'data-[ending-style]:[transform:translate3d(var(--hover-x,0px),var(--hover-y,0px),0)_scale(0.985)]',
    )

    // Respects both OS prefers-reduced-motion and app data-reduce-motion='always' via motion-reduce.
    expect(html).toContain('motion-reduce:transition-none')
    expect(html).toContain('motion-reduce:data-[starting-style]:[transform:none]')
    expect(html).toContain('motion-reduce:data-[ending-style]:[transform:none]')

    // Old harsh non-interruptible keyframe animations are removed.
    expect(html).not.toContain('animate-in')
    expect(html).not.toContain('animate-out')
    expect(html).not.toContain('slide-in-from-')
    expect(html).not.toContain('zoom-in-95')
    expect(html).not.toContain('zoom-out-95')
  })
})

describe('Portal CSS tokens for hover-card artifact tiles (#3065)', () => {
  it('defines --ease on :root so portal transitions never become IACVT', () => {
    const globals = readFileSync(`${RENDERER_SRC}/styles/globals.css`, 'utf8')
    expect(globals).toMatch(/:root\s*\{[\s\S]*?--ease:\s*var\(--ease-out-quint\);/)
    expect(globals).toContain('@keyframes card-outputs-in')
  })

  it('resolves every CSS custom property in artifact-card.css safely outside .ui-as portals', () => {
    const css = readFileSync(`${RENDERER_SRC}/features/artifacts/artifact-card.css`, 'utf8')
    const tokens = readFileSync(`${RENDERER_SRC}/styles/tokens.css`, 'utf8')
    const globals = readFileSync(`${RENDERER_SRC}/styles/globals.css`, 'utf8')
    const rootTokens = new Set(
      [...(tokens + '\n' + globals).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!),
    )

    // Component-local variables set directly on .k-art / .k-th.
    const localVars = new Set(['--k-glow-1', '--k-glow-2', '--t'])

    // Verify no bare shell-only or shadcn-conflicting variables remain without :root resolution.
    expect(css).not.toMatch(/var\(--card\)/)
    expect(css).not.toMatch(/var\(--muted\)/)
    expect(css).not.toMatch(/var\(--accent\)/)
    expect(css).not.toMatch(/var\(--subtle\)/)
    expect(css).not.toMatch(/var\(--line\)/)
    expect(css).not.toMatch(/var\(--card-shadow\)/)
    expect(css).not.toMatch(/var\(--chip\)/)
    expect(css).not.toMatch(/var\(--frame\)/)
    expect(css).not.toMatch(/var\(--strong\)/)
    expect(css).not.toMatch(/var\(--ease\)/)

    // Every var(...) must either resolve directly in :root / local scope or specify a :root fallback.
    const varCalls = [...css.matchAll(/var\((--[a-z0-9-]+)(?:,\s*var\((--[a-z0-9-]+)\))?\)/g)]
    expect(varCalls.length).toBeGreaterThan(0)
    for (const [, primary, fallback] of varCalls) {
      const resolved =
        localVars.has(primary!) ||
        rootTokens.has(primary!) ||
        (fallback && rootTokens.has(fallback))
      expect(
        resolved,
        `var(${primary}${fallback ? `, var(${fallback})` : ''}) must resolve in :root`,
      ).toBe(true)
    }

    // Compact artifact tiles lift gently without clipping inside hover cards and honor reduced motion.
    expect(css).toContain('.k-art[data-compact]:hover .k-art__page')
  })

  it('adds smooth hover transition to ReferenceRow and compact data attribute to ArtifactTile', () => {
    const cardOutputs = readFileSync(`${RENDERER_SRC}/features/sidebar/card-outputs.tsx`, 'utf8')
    expect(cardOutputs).toContain('transition-colors duration-(--duration-fast) hover:bg-hover')
    expect(cardOutputs).toContain('data-compact=""')
  })
})
