// Lightweight CodeMirror highlight state for anchoring a selection while the file note popover
// is open, kept outside `code-editor.tsx` so the lazy editor chunk stays isolated.

import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'

export interface EditorSelectionRange {
  from: number
  to: number
}

/** Highlights a passage in the editor while the selection-anchored note popover is open. */
export const markNoteRange = StateEffect.define<EditorSelectionRange | null>()

export const noteRange = StateField.define<EditorSelectionRange | null>({
  create: () => null,
  update(range, tr) {
    for (const effect of tr.effects) if (effect.is(markNoteRange)) return effect.value
    if (!range || !tr.docChanged) return range
    const from = tr.changes.mapPos(range.from, 1)
    const to = tr.changes.mapPos(range.to, -1)
    return from < to ? { from, to } : null
  },
  provide: (field) =>
    EditorView.decorations.from(field, (range) => (view) => {
      if (!range) return Decoration.none
      const max = view.state.doc.length
      const from = Math.min(Math.max(0, range.from), max)
      const to = Math.min(Math.max(0, range.to), max)
      if (from >= to) return Decoration.none
      return Decoration.set([Decoration.mark({ class: 'cm-note-anchor' }).range(from, to)])
    }),
})
