import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OVERLAY_OPEN_ATTR, useOverlayStore } from './overlays'

const RENDERER_SRC = fileURLToPath(new URL('..', import.meta.url))

function createStubDocument() {
  const attrs = new Map<string, string>()
  const setAttribute = vi.fn((name: string, value: string) => {
    attrs.set(name, value)
  })
  const removeAttribute = vi.fn((name: string) => {
    attrs.delete(name)
  })
  return {
    attrs,
    setAttribute,
    removeAttribute,
    documentElement: {
      setAttribute,
      removeAttribute,
      hasAttribute: (name: string) => attrs.has(name),
    },
  }
}

function resetOverlayStore(): void {
  const state = useOverlayStore.getState()
  for (const id of Object.keys(state.open)) state.set(id, false)
  for (const id of Object.keys(useOverlayStore.getState().dismissible)) state.set(id, false)
}

function listFiles(dir: string, ext: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith(ext))
    .map((file) => join(dir, file))
    .sort()
}

describe('useOverlayStore', () => {
  let doc: ReturnType<typeof createStubDocument>

  beforeEach(() => {
    doc = createStubDocument()
    vi.stubGlobal('document', doc)
    resetOverlayStore()
    doc.setAttribute.mockClear()
    doc.removeAttribute.mockClear()
  })

  afterEach(() => {
    resetOverlayStore()
    vi.unstubAllGlobals()
  })

  it('tracks non-dismissible overlays (tooltips, hover cards, dialogs) without toggling data-overlay-open', () => {
    const store = useOverlayStore.getState()

    store.set('tooltip-1', true)
    store.set('dialog-1', true, { dismissible: false })

    expect(useOverlayStore.getState().open).toEqual({ 'tooltip-1': true, 'dialog-1': true })
    expect(useOverlayStore.getState().dismissible).toEqual({})
    expect(doc.documentElement.hasAttribute(OVERLAY_OPEN_ATTR)).toBe(false)
    expect(doc.setAttribute).not.toHaveBeenCalled()

    store.set('tooltip-1', false)
    store.set('dialog-1', false)

    expect(useOverlayStore.getState().open).toEqual({})
    expect(doc.removeAttribute).not.toHaveBeenCalled()
  })

  it('sets data-overlay-open while a dismissible overlay is open and clears it on close', () => {
    const store = useOverlayStore.getState()

    store.set('context-menu-1', true, { dismissible: true })

    expect(useOverlayStore.getState().open).toEqual({ 'context-menu-1': true })
    expect(useOverlayStore.getState().dismissible).toEqual({ 'context-menu-1': true })
    expect(doc.documentElement.hasAttribute(OVERLAY_OPEN_ATTR)).toBe(true)
    expect(doc.setAttribute).toHaveBeenCalledTimes(1)
    expect(doc.setAttribute).toHaveBeenCalledWith(OVERLAY_OPEN_ATTR, '')

    // Closing the overlay removes the root attribute so drag regions resume.
    store.set('context-menu-1', false)

    expect(useOverlayStore.getState().open).toEqual({})
    expect(useOverlayStore.getState().dismissible).toEqual({})
    expect(doc.documentElement.hasAttribute(OVERLAY_OPEN_ATTR)).toBe(false)
    expect(doc.removeAttribute).toHaveBeenCalledTimes(1)
    expect(doc.removeAttribute).toHaveBeenCalledWith(OVERLAY_OPEN_ATTR)
  })

  it('keeps data-overlay-open across overlapping dismissible overlays and ignores passive ones', () => {
    const store = useOverlayStore.getState()

    store.set('tooltip-1', true)
    store.set('menu-1', true, { dismissible: true })
    store.set('popover-1', true, { dismissible: true })

    expect(doc.documentElement.hasAttribute(OVERLAY_OPEN_ATTR)).toBe(true)
    expect(doc.setAttribute).toHaveBeenCalledTimes(1)

    // Closing one dismissible overlay keeps drag regions suspended while another stays open.
    store.set('menu-1', false)
    expect(doc.documentElement.hasAttribute(OVERLAY_OPEN_ATTR)).toBe(true)
    expect(doc.removeAttribute).not.toHaveBeenCalled()

    // Closing the last dismissible overlay restores drag regions even while a tooltip remains open.
    store.set('popover-1', false)
    expect(useOverlayStore.getState().open).toEqual({ 'tooltip-1': true })
    expect(useOverlayStore.getState().dismissible).toEqual({})
    expect(doc.documentElement.hasAttribute(OVERLAY_OPEN_ATTR)).toBe(false)
    expect(doc.removeAttribute).toHaveBeenCalledTimes(1)
  })

  it('is idempotent on repeated calls and handles changing dismissible flag in place', () => {
    const store = useOverlayStore.getState()

    store.set('menu-1', true, { dismissible: true })
    const snapshot = useOverlayStore.getState().open
    store.set('menu-1', true, { dismissible: true })
    expect(useOverlayStore.getState().open).toBe(snapshot)
    expect(doc.setAttribute).toHaveBeenCalledTimes(1)

    // Switching the same open id to non-dismissible clears data-overlay-open.
    store.set('menu-1', true, { dismissible: false })
    expect(useOverlayStore.getState().open).toEqual({ 'menu-1': true })
    expect(useOverlayStore.getState().dismissible).toEqual({})
    expect(doc.documentElement.hasAttribute(OVERLAY_OPEN_ATTR)).toBe(false)
  })

  it('does not throw when document is unavailable', () => {
    vi.unstubAllGlobals()
    expect(() => {
      useOverlayStore.getState().set('headless-menu', true, { dismissible: true })
      useOverlayStore.getState().set('headless-menu', false)
    }).not.toThrow()
  })
})

describe('drag region suspension wiring', () => {
  it('suspends drag regions for every stylesheet that declares -webkit-app-region: drag', () => {
    const cssFiles = listFiles(RENDERER_SRC, '.css')
    const dragFiles = cssFiles.filter((file) =>
      /-webkit-app-region:\s*drag\b/.test(readFileSync(file, 'utf8')),
    )

    expect(dragFiles.length).toBeGreaterThan(0)
    for (const file of dragFiles) {
      const text = readFileSync(file, 'utf8')
      const rel = relative(RENDERER_SRC, file).split(sep).join('/')
      expect(text, `${rel} must override drag regions under :root[${OVERLAY_OPEN_ATTR}]`).toMatch(
        new RegExp(`:root\\[${OVERLAY_OPEN_ATTR}\\][\\s\\S]*?-webkit-app-region:\\s*no-drag`),
      )
    }
  })

  it('marks dismissible UI primitives as dismissible and keeps passive/modal ones out', () => {
    const uiDir = join(RENDERER_SRC, 'components', 'ui')

    for (const name of [
      'context-menu.tsx',
      'dropdown-menu.tsx',
      'popover.tsx',
      'select.tsx',
      'combobox.tsx',
    ]) {
      const text = readFileSync(join(uiDir, name), 'utf8')
      expect(text, `${name} should pass { dismissible: true } to useOverlayRoot`).toMatch(
        /useOverlayRoot\([^)]*\{\s*dismissible:\s*true\s*\}\)/,
      )
      expect(text, `${name} positioner should carry app-region-no-drag`).toMatch(
        /app-region-no-drag/,
      )
    }

    for (const name of ['tooltip.tsx', 'hover-card.tsx', 'dialog.tsx', 'alert-dialog.tsx']) {
      const text = readFileSync(join(uiDir, name), 'utf8')
      expect(text, `${name} must not disable window dragging via dismissible`).not.toMatch(
        /dismissible:\s*true/,
      )
    }
  })
})
