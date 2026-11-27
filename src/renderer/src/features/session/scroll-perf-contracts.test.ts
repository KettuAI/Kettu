import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8')

describe('long-session scroll performance contracts', () => {
  it('replaces viewport mask scroll-fade-b with compositor-only scroll-fade-y-overlay', () => {
    const scroller = read('src/components/ui/message-scroller.tsx')
    const thread = read('src/features/session/thread.tsx')
    const globals = read('src/styles/globals.css')

    expect(scroller).not.toContain('scroll-fade-b')
    expect(thread).toContain('scroll-fade-y-overlay')
    expect(thread).toContain('[scroll-timeline:--scroll-fade-y_y]')
    expect(globals).toContain('@utility scroll-fade-y-overlay')
    expect(globals).toContain('@keyframes scroll-fade-bottom-reveal')
  })

  it('replaces per-item :has(.ui-as-popover) with explicit data-popover-open toggling', () => {
    const thread = read('src/features/session/thread.tsx')
    const appShell = read('src/components/affect/app-shell.tsx')

    expect(thread).not.toContain('has-[.ui-as-popover]')
    expect(thread).toContain('data-[popover-open]:[content-visibility:visible]')
    expect(appShell).toContain('data-popover-open')
    expect(appShell).toContain('popoverOpenCount')
  })

  it('delegates reply hover via content pointerover instead of per-item closures', () => {
    const thread = read('src/features/session/thread.tsx')
    expect(thread).toContain('onPointerOver={onContentPointerOver}')
    expect(thread).toContain('data-reply-key={replyKey ?? undefined}')
    expect(thread).not.toContain('onPointerEnter={() => hoverReply')
  })

  it('does not blank thread content at opacity 0 or poll frames in thread-entrance', () => {
    const entrance = read('src/features/session/thread-entrance.ts')
    expect(entrance).not.toContain("style.opacity = '0'")
    expect(entrance).not.toContain('requestAnimationFrame')
    expect(entrance).not.toContain('blur(')
  })

  it('restores saved session reading positions across normal session switches without Back/Forward gating', () => {
    const thread = read('src/features/session/thread.tsx')
    expect(thread).not.toContain('returnedTo(')
    expect(thread).toContain('readingPosition(sessionId)')
    expect(thread).toContain('attachReturnAnchor(')
    expect(thread).toContain('computeReturnGap(')
  })
})
