// The Files pane's editor, CodeMirror 6, in a chunk of its own that loads with the first file.

import { use, useEffect, useEffectEvent, useRef, useState } from 'react'
import { indentWithTab } from '@codemirror/commands'
import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { search } from '@codemirror/search'
import {
  Annotation,
  Compartment,
  EditorState,
  StateEffect,
  StateField,
  Text,
  Transaction,
  type Extension,
} from '@codemirror/state'
import { Decoration, keymap, ViewPlugin } from '@codemirror/view'
import { basicSetup, EditorView } from 'codemirror'
import type { FileContent } from '@shared/files'
import { useCodeThemes } from '@renderer/features/session/markdown/code-themes'
import { useDark } from '@renderer/hooks/use-dark'
import { i18n } from '@renderer/lib/i18n'
import { buffers, setDirty, type Buffer, type OpenFile } from '@renderer/stores/files'
import { editorTheme } from './code-theme'
import { lineBreakOf, lineChange } from './editor-text'
import { nameOf } from './paths'

type TextContent = Extract<FileContent, { kind: 'text' }>

// The search panel's rules match CodeMirror's own `.cm-panel.cm-search` so they win over it.
const chrome = EditorView.theme({
  '&': { height: '100%', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '20px',
    overscrollBehavior: 'contain',
  },
  '.cm-content': { padding: '8px 0' },
  '.cm-gutters': { paddingLeft: '8px' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 4px', minWidth: '28px' },
  '.cm-activeLineGutter': { color: 'var(--foreground)' },
  '.cm-foldGutter .cm-gutterElement': { width: '14px', color: 'var(--muted-foreground)' },
  '.cm-marked-line': { backgroundColor: 'var(--bg-selected)' },
  '.cm-panels': { backgroundColor: 'var(--background)', color: 'var(--foreground)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border-soft)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border-soft)' },
  '.cm-panel.cm-search': {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '6px',
    padding: '6px 8px 6px 12px',
    fontFamily: 'var(--font-sans)',
    fontSize: '12px',
  },
  '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': {
    margin: 0,
  },
  '.cm-panel.cm-search br': { flexBasis: '100%', height: 0 },
  '.cm-panel.cm-search .cm-textfield': { flex: '1 1 140px', minWidth: 0 },
  '.cm-panel.cm-search input[type=checkbox]': { margin: 0, accentColor: 'var(--primary)' },
  '.cm-panel.cm-search label': {
    fontSize: '12px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    color: 'var(--muted-foreground)',
  },
  '.cm-textfield': {
    height: '24px',
    margin: 0,
    padding: '0 8px',
    border: '1px solid var(--border)',
    borderRadius: 'calc(var(--radius) * 0.8)',
    backgroundColor: 'transparent',
    color: 'var(--foreground)',
    fontSize: '12px',
  },
  '.cm-textfield:focus': { outline: 'none', borderColor: 'var(--focus)' },
  '.cm-button': {
    height: '24px',
    margin: 0,
    padding: '0 8px',
    border: '1px solid var(--border)',
    borderRadius: 'calc(var(--radius) * 0.8)',
    backgroundImage: 'none',
    backgroundColor: 'transparent',
    color: 'var(--foreground)',
    fontSize: '12px',
  },
  '.cm-button:hover': { backgroundColor: 'var(--accent)' },
  '.cm-button:active': { backgroundImage: 'none', backgroundColor: 'var(--pressed)' },
  '.cm-panel.cm-search [name=close]': {
    position: 'static',
    order: -1,
    marginLeft: 'auto',
    padding: '0 4px',
    color: 'var(--muted-foreground)',
    fontSize: '16px',
    lineHeight: '24px',
  },
  '.cm-tooltip': {
    border: 'none',
    borderRadius: 'var(--radius)',
    backgroundColor: 'var(--popover)',
    color: 'var(--popover-foreground)',
    boxShadow: 'var(--menu-ring), var(--elevation-md)',
    overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', fontSize: '12px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--accent)',
    color: 'var(--accent-foreground)',
  },
})

/** CodeMirror's own words, in the interface's language; `$` stands for a number. */
function phrases(): Record<string, string> {
  const t = i18n.getFixedT(null, 'files')
  return {
    Find: t('editor.find'),
    Replace: t('editor.replace'),
    next: t('editor.next'),
    previous: t('editor.previous'),
    all: t('editor.all'),
    'match case': t('editor.matchCase'),
    regexp: t('editor.regexp'),
    'by word': t('editor.byWord'),
    replace: t('editor.replaceOne'),
    'replace all': t('editor.replaceAll'),
    close: t('editor.close'),
    'current match': t('editor.currentMatch'),
    'on line': t('editor.onLine'),
    'replaced $ matches': t('editor.replacedMatches'),
    'replaced match on line $': t('editor.replacedMatchOnLine'),
    'Go to line': t('editor.goToLine'),
    go: t('editor.go'),
    'Fold line': t('editor.foldLine'),
    'Unfold line': t('editor.unfoldLine'),
    'Folded lines': t('editor.foldedLines'),
    'Unfolded lines': t('editor.unfoldedLines'),
    to: t('editor.to'),
    'folded code': t('editor.foldedCode'),
    unfold: t('editor.unfold'),
    'Control character': t('editor.controlCharacter'),
    Completions: t('editor.completions'),
  }
}

const theme = new Compartment()
const language = new Compartment()
const readOnly = new Compartment()

/** A reload from disk: not an edit, and not something to undo. */
const fromDisk = Annotation.define<boolean>()

// The line a reference points at, marked until another one is.
const markLine = StateEffect.define<number | null>()
const marked = StateField.define<number | null>({
  create: () => null,
  update(line, tr) {
    for (const effect of tr.effects) if (effect.is(markLine)) return effect.value
    return line
  },
  provide: (field) =>
    EditorView.decorations.from(field, (line) => (view) => {
      if (line === null || line > view.state.doc.lines) return Decoration.none
      const at = view.state.doc.line(line).from
      return Decoration.set([Decoration.line({ class: 'cm-marked-line' }).range(at)])
    }),
})

/**
 * Gives the file's language to each view the state shows in, once it loads: a buffer outlives its
 * views, so a view can take the state before the language arrives. A view given another state, or
 * destroyed, drops this plugin.
 */
function loadLanguage(description: LanguageDescription | null): Extension {
  if (!description) return []
  return ViewPlugin.define((view) => {
    let dropped = false
    void description.load().then((support) => {
      if (dropped || language.get(view.state) === support) return
      view.dispatch({ effects: language.reconfigure(support) })
    })
    return { destroy: () => (dropped = true) }
  })
}

function createBuffer(
  projectPath: string,
  path: string,
  content: TextContent,
  colors: Extension,
): Buffer {
  const buffer: Buffer = {
    path,
    version: content.version,
    base: Text.empty,
    state: EditorState.create(),
  }
  const extensions: Extension[] = [
    basicSetup,
    // Under the header, as the pane's other bars.
    search({ top: true }),
    EditorState.phrases.of(phrases()),
    keymap.of([indentWithTab]),
    EditorView.lineWrapping,
    // The file's own line break, so saving writes back the bytes it read.
    EditorState.lineSeparator.of(lineBreakOf(content.text)),
    theme.of(colors),
    language.of([]),
    loadLanguage(LanguageDescription.matchFilename(languages, nameOf(path))),
    readOnly.of(EditorState.readOnly.of(!content.editable)),
    marked,
    chrome,
    EditorView.updateListener.of((update) => {
      buffer.state = update.state
      if (!update.docChanged || update.transactions.some((tr) => tr.annotation(fromDisk))) return
      setDirty(projectPath, path, !update.state.doc.eq(buffer.base))
    }),
  ]
  buffer.state = EditorState.create({ doc: content.text, extensions })
  buffer.base = buffer.state.doc
  return buffer
}

/** Starts the project's buffer over from `content` and shows it in `editor`. */
function startBuffer(
  editor: EditorView,
  projectPath: string,
  path: string,
  content: TextContent,
  colors: Extension,
): void {
  const buffer = createBuffer(projectPath, path, content, colors)
  buffers.set(projectPath, buffer)
  editor.setState(buffer.state)
}

/** The text on disk changed and there are no edits: take it, keeping what did not change. */
function reload(
  view: EditorView,
  projectPath: string,
  buffer: Buffer,
  content: TextContent,
  colors: Extension,
): void {
  const { state } = view
  if (lineBreakOf(content.text) !== state.lineBreak) {
    startBuffer(view, projectPath, buffer.path, content, colors)
    return
  }
  const change = lineChange(state.doc.toJSON(), content.text.split(state.lineBreak))
  view.dispatch({
    ...(change && {
      changes: { ...change, insert: Text.of(change.insert.length ? change.insert : ['']) },
    }),
    effects: readOnly.reconfigure(EditorState.readOnly.of(!content.editable)),
    annotations: [fromDisk.of(true), Transaction.addToHistory.of(false)],
  })
  buffer.version = content.version
  buffer.base = view.state.doc
}

export default function CodeEditor({
  projectPath,
  file,
  content,
}: {
  projectPath: string
  file: OpenFile
  content: TextContent
}) {
  const box = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const isDark = useDark()
  const codeThemes = useCodeThemes()
  const codeTheme = isDark ? codeThemes.dark : codeThemes.light
  // The first theme loads with the editor, under its fallback; a later one while the last shows.
  const [first] = useState(() => editorTheme(codeTheme, isDark))
  const colors = useRef(use(first))

  // A buffer kept from before shows as it was left; otherwise the file starts one.
  const show = useEffectEvent((editor: EditorView) => {
    const buffer = buffers.get(projectPath)
    if (buffer?.path !== file.path) {
      startBuffer(editor, projectPath, file.path, content, colors.current)
      return
    }
    editor.setState(buffer.state)
    editor.dispatch({ effects: theme.reconfigure(colors.current) })
  })

  // One view per file; the state outlives it in `buffers`, with the edits and their history.
  useEffect(() => {
    const editor = new EditorView({ parent: box.current! })
    view.current = editor
    show(editor)
    return () => {
      editor.destroy()
      view.current = null
    }
  }, [projectPath, file.path, file.resets])

  useEffect(() => {
    let latest = true
    void editorTheme(codeTheme, isDark).then((extension) => {
      if (!latest) return
      colors.current = extension
      view.current?.dispatch({ effects: theme.reconfigure(extension) })
    })
    return () => {
      latest = false
    }
  }, [codeTheme, isDark])

  useEffect(() => {
    const editor = view.current
    const buffer = buffers.get(projectPath)
    if (!editor || buffer?.path !== file.path || file.dirty) return
    if (content.version !== buffer.version) {
      reload(editor, projectPath, buffer, content, colors.current)
    }
  }, [projectPath, file.path, file.dirty, content])

  useEffect(() => {
    const editor = view.current
    if (!editor || file.line === null) return
    const line = Math.min(Math.max(file.line, 1), editor.state.doc.lines)
    const at = editor.state.doc.line(line).from
    editor.dispatch({
      selection: { anchor: at },
      effects: [markLine.of(line), EditorView.scrollIntoView(at, { y: 'center' })],
    })
  }, [file.line, file.path, file.resets])

  return <div ref={box} className="absolute inset-0" data-selectable="" />
}
