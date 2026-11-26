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
})
