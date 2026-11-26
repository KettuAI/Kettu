import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OVERLAY_LAYER, OVERLAY_OPEN_ATTR, useOverlayStore } from './overlays'

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

/** Extracts opening JSX tag snippets for a given component name (handles nested `{...}` props). */
function extractOpeningTags(source: string, tagPattern: RegExp): string[] {
  const tags: string[] = []
  let match: RegExpExecArray | null
  while ((match = tagPattern.exec(source)) !== null) {
    let idx = match.index + match[0].length
    let braceDepth = 0
    let quote: "'" | '"' | '`' | null = null
    while (idx < source.length) {
      const ch = source[idx]!
      if (quote) {
        if (ch === '\\') idx++
        else if (ch === quote) quote = null
      } else if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch
      } else if (ch === '{') {
        braceDepth++
      } else if (ch === '}') {
        braceDepth = Math.max(0, braceDepth - 1)
      } else if (ch === '>' && braceDepth === 0) {
        tags.push(source.slice(match.index, idx + 1))
        break
      }
      idx++
    }
  }
  return tags
}

describe('overlay layer coverage wiring', () => {
  it('marks every Base UI Popup in the renderer with data-overlay-layer', () => {
    const tsxFiles = listFiles(RENDERER_SRC, '.tsx')
    const popupFiles = tsxFiles.filter((file) => {
      const text = readFileSync(file, 'utf8')
      return /@base-ui\/react\//.test(text) && /<[A-Za-z0-9_]+\.Popup\b/.test(text)
    })

    expect(popupFiles.length).toBeGreaterThan(0)
    for (const file of popupFiles) {
      const text = readFileSync(file, 'utf8')
      const rel = relative(RENDERER_SRC, file).split(sep).join('/')
      const popups = extractOpeningTags(text, /<[A-Za-z0-9_]+\.Popup\b/g)
      expect(popups.length, `${rel} should match its Base UI Popup tags`).toBeGreaterThan(0)
      for (const tag of popups) {
        expect(tag, `${rel} Popup must carry ${OVERLAY_LAYER}`).toContain(OVERLAY_LAYER)
      }
    }
  })

  it('wires PromptBox completion popover as a dismissible overlay layer', () => {
    const text = readFileSync(
      join(RENDERER_SRC, 'features', 'session', 'composer', 'prompt-box.tsx'),
      'utf8',
    )
    expect(text).toMatch(/useOverlayPresence\(open,\s*\{\s*dismissible:\s*true\s*\}\)/)

    const positioners = extractOpeningTags(text, /<Popover\.Positioner\b/g)
    expect(positioners).toHaveLength(1)
    expect(positioners[0]).toContain('z-(--layer-menu)')
    expect(positioners[0]).toContain('app-region-no-drag')

    const popups = extractOpeningTags(text, /<Popover\.Popup\b/g)
    expect(popups).toHaveLength(1)
    expect(popups[0]).toContain(`${OVERLAY_LAYER}=""`)
  })

  it('wires all three prompt-chips popovers as passive overlays so drag regions stay enabled', () => {
    const text = readFileSync(
      join(RENDERER_SRC, 'features', 'session', 'composer', 'prompt-chips.tsx'),
      'utf8',
    )

    // Each of the 3 floating popovers (hover preview, pasted-link hint, command strip) registers
    // with the overlay store so BrowserPane freezes when overlapped, without suspending drag regions.
    const presenceCalls = text.match(/useOverlayPresence\([^)]*\)/g) ?? []
    expect(presenceCalls).toHaveLength(3)
    expect(text).not.toMatch(/dismissible:\s*true/)

    const positioners = extractOpeningTags(text, /<Popover\.Positioner\b/g)
    expect(positioners).toHaveLength(3)
    for (const positioner of positioners) {
      expect(positioner).toContain('z-(--layer-menu)')
      expect(positioner).not.toContain('z-40')
    }
    // The interactive pasted-link bar (the only non-pointer-events-none positioner) must stay clickable.
    const interactivePositioners = positioners.filter((tag) => !tag.includes('pointer-events-none'))
    expect(interactivePositioners).toHaveLength(1)
    expect(interactivePositioners[0]).toContain('app-region-no-drag')

    const popups = extractOpeningTags(text, /<Popover\.Popup\b/g)
    expect(popups).toHaveLength(3)
    for (const popup of popups) {
      expect(popup).toContain(`${OVERLAY_LAYER}=""`)
    }
  })

  it('marks custom floating overlays with data-overlay-layer and wires PlanRing presence', () => {
    for (const rel of [
      'app/quit-hint.tsx',
      'features/split/session-drag.tsx',
      'components/affect/model-picker.tsx',
      'components/affect/profile-menu.tsx',
      'components/affect/app-shell.tsx',
      'components/affect/date-range-picker.tsx',
    ]) {
      const text = readFileSync(join(RENDERER_SRC, rel), 'utf8')
      expect(text, `${rel} must carry ${OVERLAY_LAYER}`).toContain(OVERLAY_LAYER)
    }

    const planRing = readFileSync(
      join(RENDERER_SRC, 'features', 'account', 'plan-ring.tsx'),
      'utf8',
    )
    expect(planRing).toMatch(/useOverlayPresence\(open,\s*\{\s*dismissible:\s*true\s*\}\)/)
  })
})
