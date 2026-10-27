// The composer's text: a CodeMirror 6 editor that draws its Markdown as it is typed
// (markdown-preview.ts). Its document is the Markdown that is sent.

import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from 'react'
import { history, insertNewline, redo, standardKeymap, undo } from '@codemirror/commands'
import { Annotation, Compartment, EditorState, Prec, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  keymap,
  placeholder as placeholderText,
  WidgetType,
} from '@codemirror/view'
import { markdownPreview } from './markdown-preview'
import { leadingCommand } from './slash'

export interface ComposerEditorHandle {
  /** Focuses the box with the editor's own selection, which a DOM focus would lose. */
  focus(): void
  text(): string
  selection(): { from: number; to: number }
  /** Types `text` over the selection, as a paste would, so it can be undone. */
  insert(text: string): void
  /** Replaces the whole text and puts the caret at `caret`, the end by default. */
  setText(text: string, caret?: number): void
}

/** The list a popover shows, for the box's combobox attributes. */
export interface PopoverAria {
  listId: string
  activeId: string | undefined
}

// Changes the box makes itself, which it does not report back as typing.
const fromBox = Annotation.define<boolean>()

class HintWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }
  eq(other: HintWidget): boolean {
    return other.text === this.text
  }
  toDOM(): HTMLElement {
    const hint = document.createElement('span')
    hint.className = 'cm-hint'
    hint.setAttribute('aria-hidden', 'true')
    hint.textContent = this.text
    return hint
  }
}

function hintAtEnd(hint: string | undefined): Extension {
  if (!hint) return []
  const widget = Decoration.widget({ widget: new HintWidget(hint), side: 1 })
  return EditorView.decorations.of((view) => Decoration.set([widget.range(view.state.doc.length)]))
}

const commandMark = Decoration.mark({ class: 'cm-slash-command' })

function leadingCommandMark(names: readonly string[]): Extension {
  if (names.length === 0) return []
  return EditorView.decorations.of((view) => {
    const length = leadingCommand(view.state.doc.line(1).text, names)
    return length ? Decoration.set([commandMark.range(0, length)]) : Decoration.none
  })
}

function editability(disabled: boolean): Extension {
  return [EditorView.editable.of(!disabled), EditorState.readOnly.of(disabled)]
}

function attributes(label: string, popover: PopoverAria | null): Extension {
  return EditorView.contentAttributes.of({
    'aria-label': label,
    // A text field's spell check, which CodeMirror turns off.
    spellcheck: 'true',
    'aria-autocomplete': 'list',
    'aria-haspopup': 'listbox',
    'aria-expanded': popover ? 'true' : 'false',
    ...(popover ? { 'aria-controls': popover.listId } : {}),
    ...(popover?.activeId ? { 'aria-activedescendant': popover.activeId } : {}),
  })
}

// The box's type, as the thread's prose, and the Markdown styles of the thread's `.markdown`.
const theme = EditorView.theme({
  '&': { maxHeight: 'min(40svh, 24rem)', color: 'var(--text-primary)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-sans)', lineHeight: '24px' },
  '.cm-content': {
    padding: 'var(--box-padding)',
    minHeight: 'var(--box-min-height)',
    fontSize: 'var(--prose-size)',
    caretColor: 'var(--text-primary)',
    // Otherwise the content grows to its longest line, and the placeholder's 100% would be its
    // own text, which runs under the buttons beside the box.
    width: '100%',
  },
  '.cm-line': { padding: '0' },
  // One line, cut with an ellipsis, so a long placeholder does not make the caret two lines tall.
  '.cm-placeholder': {
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'var(--text-placeholder)',
  },
  '.cm-hint': { color: 'var(--text-placeholder)' },
  // A shadow takes the tint 2 px past the text without moving it; it adds 2 px to the radius.
  '.cm-slash-command': {
    color: 'var(--info)',
    background: 'var(--info-tint)',
    borderRadius: '2px',
    boxShadow: '0 0 0 2px var(--info-tint)',
  },
  '.cm-md-mark': { color: 'var(--text-tertiary)' },
  '.cm-md-strong': { color: 'var(--foreground)', fontWeight: 'var(--font-weight-semibold)' },
  '.cm-md-em': { fontStyle: 'italic' },
  '.cm-md-em-han': { fontWeight: 'var(--font-weight-medium)' },
  '.cm-md-strike': { textDecoration: 'line-through' },
  '.cm-md-code': {
    borderRadius: '4px',
    background: 'var(--bg-code-inline)',
    color: 'var(--text-primary)',
    padding: '0.1em 0.35em',
    fontFamily: 'var(--font-mono)',
    fontVariantLigatures: 'none',
    fontSize: '0.8em',
  },
  '.cm-md-link': {
    color: 'var(--link)',
    textDecoration: 'underline',
    textDecorationColor: 'color-mix(in srgb, var(--link) 40%, transparent)',
    textUnderlineOffset: '3px',
  },
  '.cm-md-bullet, .cm-md-number': {
    color: 'var(--muted-foreground)',
    fontVariantNumeric: 'tabular-nums',
  },
  '.cm-line.cm-md-h': {
    color: 'var(--foreground)',
    fontWeight: 'var(--font-weight-semibold)',
    lineHeight: '1.4',
  },
  '.cm-line.cm-md-h1': { fontSize: '1.3333em' },
  '.cm-line.cm-md-h2': { fontSize: '1.1333em' },
  '.cm-line.cm-md-h4, .cm-line.cm-md-h5, .cm-line.cm-md-h6': { color: 'var(--muted-foreground)' },
  '.cm-line.cm-md-quote': {
    borderLeft: '2px solid var(--border)',
    paddingLeft: '12px',
    color: 'var(--muted-foreground)',
  },
})

export function ComposerEditor({
  ref,
  initialText,
  label,
  placeholder,
  disabled,
  hint,
  commands,
  size,
  popover,
  onChange,
  onCaret,
  onKeyDown,
  onPaste,
  onFocus,
  onBlur,
  onCompositionStart,
  onCompositionEnd,
}: {
  ref: Ref<ComposerEditorHandle>
  initialText: string
  label: string
  placeholder: string
  disabled: boolean
  /** The slash command's input hint, after the text. */
  hint: string | undefined
  /** The names of the agent's commands, for marking the one the text starts with. */
  commands: readonly string[]
  /** The text's least height and its padding, as CSS lengths. */
  size: { minHeight: string; padding: string }
  popover: PopoverAria | null
  /** Typing changed the text; setText does not call it. */
  onChange: (text: string) => void
  /** Typing or the pointer moved the caret, or null while a range is selected. */
  onCaret: (caret: number | null) => void
  /** True when the key was handled, which keeps it from the editor. */
  onKeyDown: (event: KeyboardEvent) => boolean
  /** True when the paste was handled. */
  onPaste: (event: ClipboardEvent) => boolean
  onFocus: () => void
  onBlur: (event: FocusEvent) => void
  onCompositionStart: () => void
  onCompositionEnd: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const [parts] = useState(() => ({
    placeholder: new Compartment(),
    editable: new Compartment(),
    attributes: new Compartment(),
    hint: new Compartment(),
    command: new Compartment(),
  }))
  // What the first render had, which the editor starts with.
  const initial = useRef({ initialText, placeholder, disabled, label, popover, hint, commands })
  const changed = useEffectEvent(onChange)
  const moved = useEffectEvent(onCaret)
  const keyDown = useEffectEvent(onKeyDown)
  const pasted = useEffectEvent(onPaste)
  const focused = useEffectEvent(onFocus)
  const blurred = useEffectEvent(onBlur)
  const composeStarted = useEffectEvent(onCompositionStart)
  const composeEnded = useEffectEvent(onCompositionEnd)

  useLayoutEffect(() => {
    const first = initial.current
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: first.initialText,
        selection: { anchor: first.initialText.length },
        extensions: [
          Prec.highest(
            EditorView.domEventHandlers({
              keydown: (event) => keyDown(event),
              paste: (event) => pasted(event),
              // Files dropped on the box are attachments, which the column's drop handler adds;
              // CodeMirror would type their contents.
              drop: (event) => !!event.dataTransfer?.types.includes('Files'),
              focus: () => {
                focused()
                return false
              },
              blur: (event) => {
                blurred(event)
                return false
              },
              compositionstart: () => {
                composeStarted()
                return false
              },
              compositionend: () => {
                composeEnded()
                return false
              },
            }),
          ),
          history(),
          keymap.of([
            // A text field's newline, with no indentation carried from the line above.
            { key: 'Enter', run: insertNewline, shift: insertNewline },
            // The composer sends or steers with these; where it does not, they type nothing.
            { key: 'Mod-Enter', run: () => true, shift: () => true },
            { key: 'Mod-z', run: undo, preventDefault: true },
            { key: 'Mod-y', mac: 'Mod-Shift-z', run: redo, preventDefault: true },
            { linux: 'Ctrl-Shift-z', run: redo, preventDefault: true },
            ...standardKeymap,
          ]),
          markdownPreview,
          EditorView.lineWrapping,
          EditorView.cursorScrollMargin.of({ x: 5, y: 16 }),
          theme,
          parts.placeholder.of(placeholderText(first.placeholder)),
          parts.editable.of(editability(first.disabled)),
          parts.attributes.of(attributes(first.label, first.popover)),
          parts.hint.of(hintAtEnd(first.hint)),
          parts.command.of(leadingCommandMark(first.commands)),
          EditorView.updateListener.of((update) => {
            if (update.transactions.some((tr) => tr.annotation(fromBox))) return
            if (update.docChanged) changed(update.state.doc.toString())
            if (update.docChanged || update.selectionSet) {
              const main = update.state.selection.main
              moved(main.empty ? main.head : null)
            }
          }),
        ],
      }),
    })
    view.current = editor
    return () => {
      editor.destroy()
      view.current = null
    }
  }, [parts])

  useEffect(() => {
    view.current?.dispatch({ effects: parts.placeholder.reconfigure(placeholderText(placeholder)) })
  }, [parts, placeholder])
  useEffect(() => {
    view.current?.dispatch({ effects: parts.editable.reconfigure(editability(disabled)) })
  }, [parts, disabled])
  useEffect(() => {
    view.current?.dispatch({ effects: parts.hint.reconfigure(hintAtEnd(hint)) })
  }, [parts, hint])
  useEffect(() => {
    view.current?.dispatch({ effects: parts.command.reconfigure(leadingCommandMark(commands)) })
  }, [parts, commands])
  const listId = popover?.listId
  const activeId = popover?.activeId
  useEffect(() => {
    const aria = listId ? { listId, activeId } : null
    view.current?.dispatch({ effects: parts.attributes.reconfigure(attributes(label, aria)) })
  }, [parts, label, listId, activeId])

  useImperativeHandle(
    ref,
    () => ({
      focus: () => view.current?.focus(),
      text: () => view.current?.state.doc.toString() ?? '',
      selection: () => {
        const main = view.current?.state.selection.main
        return { from: main?.from ?? 0, to: main?.to ?? 0 }
      },
      insert: (text) => {
        const editor = view.current
        if (!editor) return
        editor.dispatch(editor.state.replaceSelection(text), {
          scrollIntoView: true,
          userEvent: 'input.paste',
        })
      },
      setText: (text, caret = text.length) => {
        const editor = view.current
        if (!editor) return
        editor.dispatch({
          changes: { from: 0, to: editor.state.doc.length, insert: text },
          selection: { anchor: caret },
          annotations: fromBox.of(true),
          scrollIntoView: true,
        })
      },
    }),
    [],
  )

  return (
    <div
      ref={host}
      className="min-w-0"
      style={{ '--box-padding': size.padding, '--box-min-height': size.minHeight } as CSSProperties}
    />
  )
}
