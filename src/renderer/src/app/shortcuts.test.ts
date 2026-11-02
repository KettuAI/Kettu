import { describe, expect, it, vi } from 'vitest'

type Listener = (event: KeyboardEvent) => void
const keydowns: { listener: Listener; capture: boolean }[] = []

vi.stubGlobal('window', {
  kettu: { perf: false, platform: 'darwin', app: { onShortcut: () => () => {} } },
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  addEventListener: (type: string, listener: Listener, capture?: boolean) => {
    if (type === 'keydown') keydowns.push({ listener, capture: capture === true })
  },
  removeEventListener: () => {},
})
vi.stubGlobal('document', { querySelector: () => null, activeElement: null })
// The hook's effect runs at once, which installs its listeners on the window above.
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useEffect: (effect: () => void) => effect(),
}))

const { historyStep, pageHandlesMenuKeys, pageHandlesZoomKeys, useKeyboardShortcuts } =
  await import('./shortcuts')
const { openSettings, useViewStore } = await import('@renderer/stores/view')

/** A key event whose target sits inside the elements `inside` names. */
function key(code: string, modifiers: Partial<KeyboardEvent> = {}, inside: string[] = []) {
  return {
    code,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    target: { closest: (selector: string) => (inside.includes(selector) ? {} : null) },
    ...modifiers,
  } as unknown as KeyboardEvent
}

describe('historyStep', () => {
  it('goes back and forward with Cmd and a bracket on macOS', () => {
    expect(historyStep(key('BracketLeft', { metaKey: true }), 'darwin')).toBe('back')
    expect(historyStep(key('BracketRight', { metaKey: true }), 'darwin')).toBe('forward')
    expect(historyStep(key('ArrowLeft', { altKey: true }), 'darwin')).toBeNull()
  })

  it('goes back and forward with Alt and an arrow on Windows and Linux', () => {
    for (const platform of ['win32', 'linux']) {
      expect(historyStep(key('ArrowLeft', { altKey: true }), platform)).toBe('back')
      expect(historyStep(key('ArrowRight', { altKey: true }), platform)).toBe('forward')
      expect(historyStep(key('BracketLeft', { ctrlKey: true }), platform)).toBeNull()
      expect(historyStep(key('BracketLeft', { metaKey: true }), platform)).toBeNull()
    }
  })

  it('leaves the keys alone with another modifier held', () => {
    expect(historyStep(key('BracketLeft', { metaKey: true, shiftKey: true }), 'darwin')).toBeNull()
    expect(historyStep(key('BracketLeft', { metaKey: true, altKey: true }), 'darwin')).toBeNull()
    expect(historyStep(key('BracketLeft', { metaKey: true, ctrlKey: true }), 'darwin')).toBeNull()
    expect(historyStep(key('ArrowLeft', { altKey: true, shiftKey: true }), 'win32')).toBeNull()
    expect(historyStep(key('ArrowLeft', { altKey: true, ctrlKey: true }), 'win32')).toBeNull()
    expect(historyStep(key('ArrowLeft'), 'win32')).toBeNull()
  })

  it("leaves them to the Files pane's editor", () => {
    const editor = ['[data-code-editor]']
    expect(historyStep(key('BracketLeft', { metaKey: true }, editor), 'darwin')).toBeNull()
    expect(historyStep(key('ArrowLeft', { altKey: true }, editor), 'linux')).toBeNull()
  })

  it('leaves them to a terminal on Windows and Linux, not on macOS', () => {
    const terminal = ['[data-terminal]']
    expect(historyStep(key('ArrowLeft', { altKey: true }, terminal), 'win32')).toBeNull()
    expect(historyStep(key('ArrowRight', { altKey: true }, terminal), 'linux')).toBeNull()
    expect(historyStep(key('BracketLeft', { metaKey: true }, terminal), 'darwin')).toBe('back')
  })

  it('takes a key passed on from a page, which has no target', () => {
    const forwarded = { ...key('ArrowLeft', { altKey: true }), target: null }
    expect(historyStep(forwarded, 'win32')).toBe('back')
  })
})

describe('the keys the page handles itself', () => {
  it('takes the app menu keys where no app menu has them: off macOS, and in a browser', () => {
    expect(pageHandlesMenuKeys('darwin', 'desktop')).toBe(false)
    expect(pageHandlesMenuKeys('win32', 'desktop')).toBe(true)
    expect(pageHandlesMenuKeys('darwin', 'web')).toBe(true)
    expect(pageHandlesMenuKeys('linux', 'web')).toBe(true)
  })

  it("leaves zoom to macOS's menu and to a browser's own zoom", () => {
    expect(pageHandlesZoomKeys('darwin', 'desktop')).toBe(false)
    expect(pageHandlesZoomKeys('win32', 'desktop')).toBe(true)
    expect(pageHandlesZoomKeys('win32', 'web')).toBe(false)
  })
})

describe('Esc in Settings', () => {
  /**
   * Presses a key with focus on the page, calling the window's listeners as a browser does: those
   * in the capture phase, then `page`, as a popup listening on the document, then those in the
   * bubble phase unless the key was stopped.
   */
  function press(key: string, page: (event: KeyboardEvent) => void = () => {}): void {
    let stopped = false
    let prevented = false
    const event = {
      key,
      code: key,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      isComposing: false,
      get defaultPrevented() {
        return prevented
      },
      target: { tagName: 'BODY', isContentEditable: false, closest: () => null },
      preventDefault: () => (prevented = true),
      stopPropagation: () => (stopped = true),
    } as unknown as KeyboardEvent
    for (const { listener } of keydowns.filter((k) => k.capture)) listener(event)
    page(event)
    if (stopped) return
    for (const { listener } of keydowns.filter((k) => !k.capture)) listener(event)
  }

  it('leaves the key to an open popup, which stops it, and goes back once none takes it', () => {
    useKeyboardShortcuts()
    openSettings('general')
    // A select closing on Esc, which keeps the key from the page under it.
    press('Escape', (event) => event.stopPropagation())
    expect(useViewStore.getState().settings.open).toBe(true)
    press('Escape')
    expect(useViewStore.getState().settings.open).toBe(false)
  })
})
