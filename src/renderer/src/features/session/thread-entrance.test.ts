import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let reducedMotion = false

vi.mock('@renderer/stores/settings', () => ({
  prefersReducedMotion: () => reducedMotion,
}))

interface AnimatedCall {
  keyframes: Keyframe[]
  options: KeyframeAnimationOptions
  cancel: ReturnType<typeof vi.fn>
}

class FakeElement {
  dataset: Record<string, string> = {}
  style = {
    opacity: '',
    removeProperty: vi.fn((prop: string) => {
      if (prop === 'opacity') this.style.opacity = ''
    }),
  }
  firstElementChild: FakeElement | null = null
  lastElementChild: FakeElement | null = null
  nextElementSibling: FakeElement | null = null
  previousElementSibling: FakeElement | null = null
  scrollTop = 0
  scrollHeight = 0
  clientHeight = 0
  rectCalls = 0
  animated: AnimatedCall[] = []
  private rect: { top: number; bottom: number; height: number }

  constructor(
    id: string | null,
    rect: { top: number; bottom: number },
    scroll?: { scrollTop?: number; scrollHeight?: number; clientHeight?: number },
  ) {
    if (id !== null) this.dataset.messageId = id
    this.rect = { ...rect, height: rect.bottom - rect.top }
    if (scroll) {
      this.scrollTop = scroll.scrollTop ?? 0
      this.scrollHeight = scroll.scrollHeight ?? 0
      this.clientHeight = scroll.clientHeight ?? 0
    }
  }

  getBoundingClientRect() {
    this.rectCalls++
    return {
      ...this.rect,
      left: 0,
      right: 700,
      width: 700,
    }
  }

  animate(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    const cancel = vi.fn()
    this.animated.push({ keyframes, options, cancel })
    return { cancel } as unknown as Animation
  }
}

function linkItems(items: FakeElement[]): FakeElement {
  const content = new FakeElement(null, { top: 0, bottom: 2000 })
  for (let i = 0; i < items.length; i++) {
    if (i > 0) items[i]!.previousElementSibling = items[i - 1]!
    if (i < items.length - 1) items[i]!.nextElementSibling = items[i + 1]!
  }
  content.firstElementChild = items[0] ?? null
  content.lastElementChild = items.at(-1) ?? null
  return content
}

describe('playEntrance', () => {
  const rafMock = vi.fn()

  beforeEach(() => {
    reducedMotion = false
    rafMock.mockReset()
    vi.stubGlobal('HTMLElement', FakeElement)
    vi.stubGlobal('requestAnimationFrame', rafMock)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('never hides content at opacity 0 or polls requestAnimationFrame across frames', async () => {
    const { playEntrance } = await import('./thread-entrance')
    const viewport = new FakeElement(
      null,
      { top: 0, bottom: 600 },
      { scrollTop: 3400, scrollHeight: 4000, clientHeight: 600 },
    )
    const items = [
      // Off-screen above viewport (skipped via content-visibility: auto in real DOM).
      new FakeElement('m-0', { top: -3000, bottom: -2800 }),
      new FakeElement('m-1', { top: -200, bottom: -20 }),
      // Visible at the bottom of the thread.
      new FakeElement('m-2', { top: 40, bottom: 260 }),
      new FakeElement('m-3', { top: 280, bottom: 580 }),
    ]
    const content = linkItems(items)

    const cancel = playEntrance(
      viewport as unknown as HTMLElement,
      content as unknown as HTMLElement,
    )

    // Never blanks out the thread column or stalls waiting on scrollHeight quiescence.
    expect(content.style.opacity).toBe('')
    expect(rafMock).not.toHaveBeenCalled()

    // Animates only visible items without starting from opacity: 0 or using blur filters.
    expect(items[0]!.animated).toHaveLength(0)
    expect(items[0]!.rectCalls).toBe(0)
    expect(items[1]!.animated).toHaveLength(0)
    expect(items[2]!.animated).toHaveLength(1)
    expect(items[3]!.animated).toHaveLength(1)

    for (const item of [items[2]!, items[3]!]) {
      const call = item.animated[0]!
      const startFrame = call.keyframes[0]!
      expect(Number(startFrame.opacity)).toBeGreaterThan(0.5)
      expect(startFrame.filter).toBeUndefined()
      expect(call.options.delay ?? 0).toBe(0)
    }

    // Active/growing sessions whose scrollHeight changes immediately after mount remain visible.
    viewport.scrollHeight = 4250
    expect(content.style.opacity).toBe('')
    expect(rafMock).not.toHaveBeenCalled()

    // Cleanup cancels running animations.
    cancel()
    expect(items[2]!.animated[0]!.cancel).toHaveBeenCalledTimes(1)
    expect(items[3]!.animated[0]!.cancel).toHaveBeenCalledTimes(1)
  })

  it('honors prefersReducedMotion and skips all animations and layout reads', async () => {
    reducedMotion = true
    const { playEntrance } = await import('./thread-entrance')
    const viewport = new FakeElement(
      null,
      { top: 0, bottom: 600 },
      { scrollTop: 0, scrollHeight: 600, clientHeight: 600 },
    )
    const item = new FakeElement('m-1', { top: 20, bottom: 180 })
    const content = linkItems([item])

    const cancel = playEntrance(
      viewport as unknown as HTMLElement,
      content as unknown as HTMLElement,
    )
    cancel()

    expect(content.style.opacity).toBe('')
    expect(rafMock).not.toHaveBeenCalled()
    expect(viewport.rectCalls).toBe(0)
    expect(item.animated).toHaveLength(0)
  })

  it('no-ops cleanly when the viewport has zero height', async () => {
    const { playEntrance } = await import('./thread-entrance')
    const viewport = new FakeElement(null, { top: 0, bottom: 0 })
    const item = new FakeElement('m-1', { top: 0, bottom: 100 })
    const content = linkItems([item])

    playEntrance(viewport as unknown as HTMLElement, content as unknown as HTMLElement)()

    expect(content.style.opacity).toBe('')
    expect(item.animated).toHaveLength(0)
  })
})
