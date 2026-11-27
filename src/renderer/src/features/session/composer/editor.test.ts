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

describe('ComposerEditor multiline Tab suggestion layout (#2874)', () => {
  const source = readFileSync(join(import.meta.dirname, 'editor.tsx'), 'utf8')

  it('keeps plain placeholders single-line truncated so ordinary placeholders stay compact', () => {
    expect(source).toMatch(
      /['"]\.cm-placeholder['"]:\s*\{[\s\S]*?overflow:\s*['"]hidden['"][\s\S]*?textOverflow:\s*['"]ellipsis['"][\s\S]*?whiteSpace:\s*['"]nowrap['"]/,
    )
  })

  it('renders Tab suggestions inline so long suggestions wrap without stretching empty caret height', () => {
    expect(source).toMatch(
      /['"]\.cm-placeholder:has\(\.cm-suggestion\)['"]:\s*\{[\s\S]*?display:\s*['"]inline['"][\s\S]*?whiteSpace:\s*['"]normal['"][\s\S]*?overflowWrap:\s*['"]anywhere['"]/,
    )
    expect(source).toMatch(/['"]\.cm-suggestion['"]:\s*\{\s*display:\s*['"]inline['"],?\s*\}/)
    expect(source).toMatch(
      /['"]\.cm-suggestion-text['"]:\s*\{[\s\S]*?display:\s*['"]inline['"][\s\S]*?whiteSpace:\s*['"]pre-wrap['"][\s\S]*?overflowWrap:\s*['"]anywhere['"]/,
    )
    // Inline-flex on `.cm-suggestion` turned the placeholder into a tall inline-block box that
    // stretched the empty editor's native caret across multiple lines.
    expect(source).not.toMatch(/['"]\.cm-suggestion['"]:\s*\{[\s\S]*?inline-flex/)
  })

  it('caps wrapped suggestions to a bounded number of lines and keeps the Tab keycap inline', () => {
    expect(source).toMatch(
      /['"]\.cm-line:has\(\.cm-suggestion\)['"]:\s*\{[\s\S]*?WebkitLineClamp:\s*['"]4['"][\s\S]*?overflow:\s*['"]hidden['"]/,
    )
    expect(source).toContain('cm-suggestion-key')
    expect(source).toContain('suggestionOf.of(suggestion)')
    expect(source).toContain('suggestionPreviewText(suggestion)')
  })

  it('reconfigures empty-box placeholder in useLayoutEffect and clears suggestions on send (#2903)', () => {
    expect(source).toMatch(
      /useLayoutEffect\(\(\) => \{\s*view\.current\?\.dispatch\(\{\s*effects:\s*parts\.placeholder\.reconfigure\(emptyBox\(placeholder,\s*suggestion\)\),\s*\}\)\s*\},\s*\[parts,\s*placeholder,\s*suggestion\]\)/,
    )
    const composerSource = readFileSync(join(import.meta.dirname, 'composer.tsx'), 'utf8')
    expect(composerSource).toContain('suppressSuggestion(sessionId)')
    expect(composerSource).toContain('unshow?.({ restoreSuggestion: true })')
  })
})
