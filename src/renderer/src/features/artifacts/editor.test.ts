import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RUNTIME_VERSION, type DriveMessage } from '@shared/artifact-runtime/page-messages'

type SelectedHandler = (event: { origin: string; message: unknown }) => void

let selectedHandlers: SelectedHandler[] = []

function makeIframe(
  posted: DriveMessage[],
  layout: {
    left: number
    top: number
    width: number
    height: number
    offsetWidth: number
    offsetHeight: number
  },
): HTMLIFrameElement {
  return {
    contentWindow: {
      postMessage: (message: DriveMessage) => {
        posted.push(message)
      },
    },
    offsetWidth: layout.offsetWidth,
    offsetHeight: layout.offsetHeight,
    getBoundingClientRect: () => ({
      left: layout.left,
      top: layout.top,
      width: layout.width,
      height: layout.height,
      right: layout.left + layout.width,
      bottom: layout.top + layout.height,
      x: layout.left,
      y: layout.top,
      toJSON: () => ({}),
    }),
    focus: () => {},
  } as unknown as HTMLIFrameElement
}

describe('ArtifactEditor.revealPin', () => {
  beforeEach(() => {
    selectedHandlers = []
    vi.resetModules()
    vi.stubGlobal('window', {
      kettu: {
        client: 'desktop',
        artifacts: {
          onSelected: (listener: SelectedHandler) => {
            selectedHandlers.push(listener)
            return () => {
              selectedHandlers = selectedHandlers.filter((h) => h !== listener)
            }
          },
          onPageError: () => () => {},
        },
      },
    })
    vi.stubGlobal('document', { documentElement: {} })
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '#0060e2' }))
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('reveals and translates a visible pin box into scaled window coordinates even in View mode', async () => {
    const { ArtifactEditor } = await import('./editor')
    const origin = 'http://127.0.0.1:4123'
    const editor = new ArtifactEditor(origin)
    const posted: DriveMessage[] = []
    const frame = editor.frame(null)
    // Scale 0.5x inside a 1200x800 layout frame positioned at (100, 50).
    frame.link.attach(
      makeIframe(posted, {
        left: 100,
        top: 50,
        width: 600,
        height: 400,
        offsetWidth: 1200,
        offsetHeight: 800,
      }),
    )
    frame.open()

    // View mode has editor mode = null; revealPin still works so clicking CommentsCard opens ThreadPop.
    expect(editor.get().mode).toBeNull()
    const pending = editor.revealPin(null, 42)
    const revealMsg = posted.find(
      (m): m is Extract<DriveMessage, { kind: 'select-reveal' }> => m.kind === 'select-reveal',
    )
    expect(revealMsg).toEqual({
      v: RUNTIME_VERSION,
      kind: 'select-reveal',
      src: 42,
      channel: frame.link.channel,
    })

    for (const handler of selectedHandlers) {
      handler({
        origin,
        message: {
          v: RUNTIME_VERSION,
          id: 'k1',
          kind: 'select',
          channel: frame.link.channel,
          selection: null,
          located: { src: 42, box: { x: 200, y: 100, width: 20, height: 20 } },
        },
      })
    }

    await expect(pending).resolves.toEqual({
      left: 200,
      top: 100,
      right: 210,
      bottom: 110,
    })
    editor.dispose()
  })

  it('returns null immediately when the element is missing in the DOM', async () => {
    const { ArtifactEditor } = await import('./editor')
    const origin = 'http://127.0.0.1:4123'
    const editor = new ArtifactEditor(origin)
    const posted: DriveMessage[] = []
    const frame = editor.frame(null)
    frame.link.attach(
      makeIframe(posted, {
        left: 0,
        top: 0,
        width: 800,
        height: 600,
        offsetWidth: 800,
        offsetHeight: 600,
      }),
    )
    frame.open()

    const pending = editor.revealPin(null, 99)
    for (const handler of selectedHandlers) {
      handler({
        origin,
        message: {
          v: RUNTIME_VERSION,
          id: 'k2',
          kind: 'select',
          channel: frame.link.channel,
          selection: null,
          located: { src: 99, box: null },
        },
      })
    }

    await expect(pending).resolves.toBeNull()
    editor.dispose()
  })

  it('returns null without waiting when no matching frame is attached, and falls back on timeout', async () => {
    vi.useFakeTimers()
    const { ArtifactEditor } = await import('./editor')
    const origin = 'http://127.0.0.1:4123'
    const editor = new ArtifactEditor(origin)

    // No frame registered yet -> resolves null immediately.
    await expect(editor.revealPin(null, 10)).resolves.toBeNull()

    const posted: DriveMessage[] = []
    const frame = editor.frame(null)
    frame.link.attach(
      makeIframe(posted, {
        left: 0,
        top: 0,
        width: 800,
        height: 600,
        offsetWidth: 800,
        offsetHeight: 600,
      }),
    )
    frame.open()

    // Unresponsive frame -> falls back to null after REVEAL_WAIT_MS so the popover still opens.
    const timedOut = editor.revealPin(null, 10)
    await vi.advanceTimersByTimeAsync(150)
    await expect(timedOut).resolves.toBeNull()
    editor.dispose()
  })

  it('captures highlight boxes on picks and pins, tracks live scroll updates, and scrolls both iframe and host container back', async () => {
    const { ArtifactEditor } = await import('./editor')
    const origin = 'http://127.0.0.1:4123'
    const editor = new ArtifactEditor(origin)
    const posted: DriveMessage[] = []
    const frame = editor.frame(0)

    let hostScrollTop = 500
    const hostScrollTo = vi.fn(({ top }: { left?: number; top?: number; behavior?: string }) => {
      if (typeof top === 'number') hostScrollTop = top
    })
    const hostScroller = {
      scrollHeight: 2400,
      clientHeight: 600,
      scrollWidth: 800,
      clientWidth: 800,
      get scrollTop() {
        return hostScrollTop
      },
      set scrollTop(v: number) {
        hostScrollTop = v
      },
      scrollLeft: 0,
      scrollTo: hostScrollTo,
      parentElement: null,
      getBoundingClientRect: () => ({
        left: 100,
        top: 50,
        width: 800,
        height: 600,
        right: 900,
        bottom: 650,
        x: 100,
        y: 50,
        toJSON: () => ({}),
      }),
    }

    let iframeTop = 50 - hostScrollTop
    const iframe = makeIframe(posted, {
      left: 100,
      top: iframeTop,
      width: 800,
      height: 2400,
      offsetWidth: 800,
      offsetHeight: 2400,
    })
    ;(iframe as unknown as { parentElement: unknown }).parentElement = hostScroller
    iframe.getBoundingClientRect = () => ({
      left: 100,
      top: iframeTop,
      width: 800,
      height: 2400,
      right: 900,
      bottom: iframeTop + 2400,
      x: 100,
      y: iframeTop,
      toJSON: () => ({}),
    })
    vi.stubGlobal('getComputedStyle', (el?: unknown) =>
      el === hostScroller
        ? { overflowX: 'hidden', overflowY: 'auto' }
        : { getPropertyValue: () => '#0060e2' },
    )

    frame.link.attach(iframe)
    frame.open()
    editor.setMode('comment')

    // Picking an element translates its reported highlight box into window coordinates.
    for (const handler of selectedHandlers) {
      handler({
        origin,
        message: {
          v: RUNTIME_VERSION,
          id: 'k-pick',
          kind: 'select',
          channel: frame.link.channel,
          selection: {
            path: 'index.html',
            src: 42,
            tag: 'div',
            text: 'Long block',
            textOnly: false,
            style: {},
            box: { x: 40, y: 100, width: 300, height: 200 },
          },
        },
      })
    }
    expect(editor.get().picked?.box).toEqual({
      left: 140,
      top: iframeTop + 100,
      right: 440,
      bottom: iframeTop + 300,
    })

    // Tracking the anchor sends `select-anchor` and updates anchor listeners without churning editor subscribers.
    const generalListener = vi.fn()
    const anchorListener = vi.fn()
    editor.subscribe(generalListener)
    editor.subscribeAnchor(anchorListener)

    editor.trackAnchor({ page: 0, target: 42 }, hostScroller as unknown as HTMLElement)
    expect(posted.at(-1)).toEqual({
      v: RUNTIME_VERSION,
      kind: 'select-anchor',
      channel: frame.link.channel,
      target: 42,
    })

    for (const handler of selectedHandlers) {
      handler({
        origin,
        message: {
          v: RUNTIME_VERSION,
          id: 'k-anchor',
          kind: 'select',
          channel: frame.link.channel,
          selection: null,
          anchor: {
            box: { x: 40, y: 100, width: 300, height: 200 },
            viewport: { width: 800, height: 2400 },
          },
        },
      })
    }
    expect(generalListener).not.toHaveBeenCalled()
    expect(anchorListener).toHaveBeenCalledTimes(1)
    expect(editor.getAnchor()).toEqual({
      box: { left: 140, top: -350, right: 440, bottom: -150 },
      clip: { left: 100, top: 50, right: 900, bottom: 650 },
    })

    // Host-side scroll (like a long opened canvas frame) updates window coordinates via recomputeAnchor().
    hostScrollTop = 80
    iframeTop = 50 - hostScrollTop
    editor.recomputeAnchor()
    expect(editor.getAnchor()?.box).toEqual({
      left: 140,
      top: 70,
      right: 440,
      bottom: 270,
    })

    // Scroll away again, then invoke scrollToAnchor(): scrolls both the host scroller and the iframe smoothly.
    hostScrollTop = 900
    iframeTop = 50 - hostScrollTop
    editor.recomputeAnchor()
    editor.scrollToAnchor()
    expect(hostScrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }))
    expect(posted.at(-1)).toEqual({
      v: RUNTIME_VERSION,
      kind: 'select-scroll-anchor',
      target: 42,
    })

    // Stopping tracking tells the iframe to stop and clears the sticky message.
    editor.trackAnchor(null)
    expect(posted.at(-1)).toEqual({
      v: RUNTIME_VERSION,
      kind: 'select-anchor',
      channel: frame.link.channel,
      target: null,
    })
    expect(editor.getAnchor()).toBeNull()
    editor.dispose()
  })

  it('handles marquee multi-selection groups, union viewport boxes, item removal, mode switching, and frame release', async () => {
    const rafQueue: (() => void)[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      rafQueue.push(cb)
      return rafQueue.length
    })

    const { ArtifactEditor } = await import('./editor')
    const origin = 'http://127.0.0.1:4123'
    const editor = new ArtifactEditor(origin)
    const posted: DriveMessage[] = []
    const frame = editor.frame(null)
    // Scale 0.5x at window offset (100, 50).
    frame.link.attach(
      makeIframe(posted, {
        left: 100,
        top: 50,
        width: 600,
        height: 400,
        offsetWidth: 1200,
        offsetHeight: 800,
      }),
    )
    frame.open()
    editor.setMode('select')

    // Preview marquee throttles via rAF; commit cancels pending preview and sends commit: true.
    frame.marquee({ x: 10, y: 20, width: 100, height: 80 })
    frame.marquee({ x: 10, y: 20, width: 300, height: 180 })
    expect(posted.filter((m) => m.kind === 'select-marquee')).toHaveLength(0)
    rafQueue.splice(0).forEach((cb) => cb())
    expect(posted.at(-1)).toEqual({
      v: RUNTIME_VERSION,
      kind: 'select-marquee',
      rect: { x: 10, y: 20, width: 300, height: 180 },
      commit: false,
    })

    frame.marqueeCommit({ x: 10, y: 20, width: 320, height: 200 })
    expect(posted.at(-1)).toEqual({
      v: RUNTIME_VERSION,
      kind: 'select-marquee',
      rect: { x: 10, y: 20, width: 320, height: 200 },
      commit: true,
    })

    // Deliver two selected elements -> populates pickedGroup with scaled union box and clears single picked.
    for (const handler of selectedHandlers) {
      handler({
        origin,
        message: {
          v: RUNTIME_VERSION,
          id: 'k-multi',
          kind: 'select',
          channel: frame.link.channel,
          selection: null,
          selections: [
            {
              path: 'index.html',
              src: 10,
              tag: 'article',
              text: 'Card A',
              textOnly: false,
              style: {},
              box: { x: 40, y: 60, width: 200, height: 100 },
            },
            {
              path: 'index.html',
              src: 30,
              tag: 'article',
              text: 'Card B',
              textOnly: false,
              style: {},
              box: { x: 260, y: 100, width: 200, height: 160 },
            },
          ],
        },
      })
    }

    const group = editor.get().pickedGroup
    expect(editor.get().picked).toBeNull()
    expect(group?.selections).toHaveLength(2)
    // Scaled 0.5x at (100, 50): x [40..460] -> [120..330], y [60..260] -> [80..180].
    expect(group?.box).toEqual({ left: 120, top: 80, right: 330, bottom: 180 })

    // Removing index 0 keeps the same group.id, syncs select-remove to the iframe, and shrinks union box.
    const stableId = group!.id
    editor.removeFromPickedGroup(0)
    expect(posted.at(-1)).toEqual({ v: RUNTIME_VERSION, kind: 'select-remove', index: 0 })
    expect(editor.get().pickedGroup?.id).toBe(stableId)
    expect(editor.get().pickedGroup?.selections).toHaveLength(1)
    expect(editor.get().pickedGroup?.box).toEqual({ left: 230, top: 100, right: 330, bottom: 180 })

    // Switching to comment mode clears the marquee selection group and ignores multi-select messages.
    editor.setMode('comment')
    expect(editor.get().pickedGroup).toBeNull()
    for (const handler of selectedHandlers) {
      handler({
        origin,
        message: {
          v: RUNTIME_VERSION,
          id: 'k-multi-ignored',
          kind: 'select',
          channel: frame.link.channel,
          selection: null,
          selections: [
            {
              path: 'index.html',
              src: 10,
              tag: 'article',
              text: 'Card A',
              textOnly: false,
              style: {},
            },
          ],
        },
      })
    }
    expect(editor.get().pickedGroup).toBeNull()

    // Releasing the owning frame (e.g. leaving a focused canvas page) clears pickedGroup cleanly.
    editor.setMode('select')
    for (const handler of selectedHandlers) {
      handler({
        origin,
        message: {
          v: RUNTIME_VERSION,
          id: 'k-multi-2',
          kind: 'select',
          channel: frame.link.channel,
          selection: null,
          selections: [
            {
              path: 'index.html',
              src: 10,
              tag: 'article',
              text: 'Card A',
              textOnly: false,
              style: {},
            },
          ],
        },
      })
    }
    expect(editor.get().pickedGroup?.selections).toHaveLength(1)
    frame.release()
    expect(editor.get().pickedGroup).toBeNull()

    editor.dispose()
  })
})
