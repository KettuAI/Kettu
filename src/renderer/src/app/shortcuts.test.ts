import { describe, expect, it, vi } from 'vitest'

vi.stubGlobal('window', {
  kettu: { perf: false, platform: 'darwin' },
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
})

const { historyStep, pageHandlesMenuKeys, pageHandlesZoomKeys } = await import('./shortcuts')

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
