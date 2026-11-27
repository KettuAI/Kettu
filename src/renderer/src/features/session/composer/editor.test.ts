import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import { focusOnContextMenu } from './editor-context-menu'

describe('focusOnContextMenu', () => {
  it('focuses an unfocused editable composer before the native context menu opens', () => {
    const focus = vi.fn()
    const state = EditorState.create({ extensions: [EditorView.editable.of(true)] })
    focusOnContextMenu({ hasFocus: false, focus, state })
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('does not refocus an already focused composer, preserving its selection', () => {
    const focus = vi.fn()
    const state = EditorState.create({ extensions: [EditorView.editable.of(true)] })
    focusOnContextMenu({ hasFocus: true, focus, state })
    expect(focus).not.toHaveBeenCalled()
  })

  it('does not focus a disabled composer or missing editor instance', () => {
    const focus = vi.fn()
    const disabledState = EditorState.create({ extensions: [EditorView.editable.of(false)] })
    focusOnContextMenu({ hasFocus: false, focus, state: disabledState })
    focusOnContextMenu(null)
    expect(focus).not.toHaveBeenCalled()
  })
})

describe('ComposerEditor right-click hit-testing wiring', () => {
  const source = readFileSync(join(import.meta.dirname, 'editor.tsx'), 'utf8')

  it('keeps .cm-placeholder non-blocking for pointer hit-testing', () => {
    expect(source).toMatch(/['"]\.cm-placeholder['"]:\s*\{[\s\S]*?pointerEvents:\s*['"]none['"]/)
  })

  it('focuses on contextmenu capture without preventing the native context menu', () => {
    expect(source).toContain('onContextMenuCapture={() => focusOnContextMenu(view.current)}')
    expect(source).not.toMatch(/onContextMenu\w*=\{[^}]*preventDefault/)
  })
})
