import { describe, expect, it, vi } from 'vitest'
import {
  attachHeldBubbleDismiss,
  type HeldBubbleDismissTarget,
  type HeldBubbleEventHost,
} from './use-held-bubble'

class FakeEventHost implements HeldBubbleEventHost {
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()

  addEventListener(type: string, listener: (event: unknown) => void, capture = false): void {
    const key = `${type}:${capture ? 'c' : 'b'}`
    const bucket = this.listeners.get(key) ?? new Set()
    bucket.add(listener)
    this.listeners.set(key, bucket)
  }

  removeEventListener(type: string, listener: (event: unknown) => void, capture = false): void {
    const key = `${type}:${capture ? 'c' : 'b'}`
    this.listeners.get(key)?.delete(listener)
  }

  dispatch(type: string, event: unknown, capture = false): void {
    const key = `${type}:${capture ? 'c' : 'b'}`
    for (const listener of [...(this.listeners.get(key) ?? [])]) {
      listener(event)
    }
  }

  count(type: string, capture = false): number {
    return this.listeners.get(`${type}:${capture ? 'c' : 'b'}`)?.size ?? 0
  }
}

describe('attachHeldBubbleDismiss (#2927)', () => {
  it('ignores the opening pointer event, dismisses on outside click, and never dismisses on clicks inside the bubble', async () => {
    const doc = new FakeEventHost()
    const win = new FakeEventHost()
    const bubbleNode = { kind: 'bubble' }
    const takeOverButton = { kind: 'button' }
    const outsideArea = { kind: 'chat-pane' }
    const bubble: HeldBubbleDismissTarget = {
      contains: (node) => node === bubbleNode || node === takeOverButton,
    }
    const onDismiss = vi.fn()

    const stop = attachHeldBubbleDismiss({
      bubble: () => bubble,
      onDismiss,
      doc,
      win,
    })

    // Same synchronous tick as the opening click must not immediately dismiss the new bubble.
    doc.dispatch('pointerdown', { target: outsideArea }, true)
    expect(onDismiss).not.toHaveBeenCalled()

    // After microtask arming, clicks inside the bubble (including its Take over button) stay open.
    await Promise.resolve()
    doc.dispatch('pointerdown', { target: bubbleNode }, true)
    doc.dispatch('pointerdown', { target: takeOverButton }, true)
    expect(onDismiss).not.toHaveBeenCalled()

    // Clicking anywhere outside the bubble dismisses immediately.
    doc.dispatch('pointerdown', { target: outsideArea }, true)
    expect(onDismiss).toHaveBeenCalledTimes(1)

    stop()
    expect(doc.count('pointerdown', true)).toBe(0)
    expect(doc.count('keydown', true)).toBe(0)
    expect(win.count('blur', false)).toBe(0)
  })

  it('dismisses on Escape and window blur, while ignoring repeat Escape and other keys', async () => {
    const doc = new FakeEventHost()
    const win = new FakeEventHost()
    const onDismiss = vi.fn()

    const stop = attachHeldBubbleDismiss({
      bubble: () => ({ contains: () => false }),
      onDismiss,
      doc,
      win,
    })

    // Non-Escape keys and repeated Escape are ignored.
    doc.dispatch('keydown', { key: 'Enter', repeat: false }, true)
    doc.dispatch('keydown', { key: 'Escape', repeat: true }, true)
    expect(onDismiss).not.toHaveBeenCalled()

    // Pressing Escape dismisses immediately.
    doc.dispatch('keydown', { key: 'Escape', repeat: false }, true)
    expect(onDismiss).toHaveBeenCalledTimes(1)

    // Window blur dismisses once armed.
    await Promise.resolve()
    win.dispatch('blur', {}, false)
    expect(onDismiss).toHaveBeenCalledTimes(2)

    // After cleanup, further events do nothing.
    stop()
    doc.dispatch('keydown', { key: 'Escape', repeat: false }, true)
    win.dispatch('blur', {}, false)
    expect(onDismiss).toHaveBeenCalledTimes(2)
  })
})
