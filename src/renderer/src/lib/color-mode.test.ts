import { beforeEach, describe, expect, it, vi } from 'vitest'

const dataset: Record<string, string> = {}
let frames: (() => void)[] = []
let transitions: { update: () => void; finish: () => void }[] = []

function startViewTransition(update: () => void) {
  let finish = () => {}
  const finished = new Promise<void>((resolve) => (finish = resolve))
  transitions.push({ update, finish })
  return { ready: Promise.resolve(), finished }
}

vi.stubGlobal('document', { documentElement: { dataset }, startViewTransition })
vi.stubGlobal('requestAnimationFrame', (callback: () => void) => frames.push(callback))

const { showColorMode } = await import('./color-mode')

function drawFrames(count: number): void {
  for (let i = 0; i < count; i++) {
    const due = frames
    frames = []
    for (const callback of due) callback()
  }
}

describe('showColorMode', () => {
  beforeEach(() => {
    drawFrames(4)
    transitions = []
  })

  it('switches at once, holding transitions until a frame has drawn the new colors', () => {
    showColorMode('light', false)
    expect(dataset.theme).toBe('light')
    expect(dataset.switchingTheme).toBe('')
    expect(transitions).toHaveLength(0)
    drawFrames(1)
    expect(dataset.switchingTheme).toBe('')
    drawFrames(1)
    expect(dataset.switchingTheme).toBeUndefined()
  })

  it('flips inside a view transition when it fades, and lets go once it has finished', async () => {
    showColorMode('light', false)
    drawFrames(2)
    showColorMode('dark', true)
    expect(dataset.theme).toBe('light')
    expect(transitions).toHaveLength(1)
    transitions[0].update()
    expect(dataset.theme).toBe('dark')
    expect(dataset.switchingTheme).toBe('')
    transitions[0].finish()
    await Promise.resolve()
    drawFrames(2)
    expect(dataset.switchingTheme).toBeUndefined()
  })

  it('starts no second switch for the mode already on its way', () => {
    showColorMode('light', false)
    showColorMode('dark', true)
    showColorMode('dark', true)
    expect(transitions).toHaveLength(1)
  })

  it('keeps holding for a newer switch when an older one finishes', async () => {
    showColorMode('light', false)
    showColorMode('dark', true)
    showColorMode('light', true)
    transitions[0].update()
    transitions[1].update()
    transitions[0].finish()
    await Promise.resolve()
    drawFrames(2)
    expect(dataset.theme).toBe('light')
    expect(dataset.switchingTheme).toBe('')
    transitions[1].finish()
    await Promise.resolve()
    drawFrames(2)
    expect(dataset.switchingTheme).toBeUndefined()
  })
})
