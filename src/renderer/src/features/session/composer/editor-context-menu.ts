// Right-click focus behavior for the CodeMirror composer editor.

import { EditorView } from '@codemirror/view'

/**
 * Focuses an unfocused editable CodeMirror view on right-click before Chromium builds the native
 * context menu, so Paste works on the first click without disturbing an existing selection.
 */
export function focusOnContextMenu(
  editor: Pick<EditorView, 'hasFocus' | 'focus' | 'state'> | null,
): void {
  if (!editor || editor.hasFocus) return
  if (!editor.state.facet(EditorView.editable)) return
  editor.focus()
}
