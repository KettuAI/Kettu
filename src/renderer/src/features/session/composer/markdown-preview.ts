// The composer's Markdown, drawn as it is typed. The text stays Markdown, which is what is sent;
// each element shows as the thread renders it, and the marks that make it show only where the
// selection is while the box has focus.

import { DocInput } from '@codemirror/language'
import type { EditorState, Range } from '@codemirror/state'
import {
  Decoration,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from '@codemirror/view'
import { GFM, parser } from '@lezer/markdown'
import { HAN } from '@renderer/lib/han'

const markdown = parser.configure(GFM)
// Parse enough text before the viewport to recover a block's context, but not the whole draft.
const CONTEXT = 20_000
type SyntaxNode = ReturnType<typeof markdown.parse>['topNode']

class BulletWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const bullet = document.createElement('span')
    bullet.className = 'cm-md-bullet'
    bullet.textContent = '•'
    return bullet
  }
}

const hidden = Decoration.replace({})
const bullet = Decoration.replace({ widget: new BulletWidget() })
const markCache = new Map<string, Decoration>()
const lineCache = new Map<string, Decoration>()

function mark(className: string): Decoration {
  let deco = markCache.get(className)
  if (!deco) markCache.set(className, (deco = Decoration.mark({ class: className })))
  return deco
}

function lineClass(className: string): Decoration {
  let deco = lineCache.get(className)
  if (!deco) lineCache.set(className, (deco = Decoration.line({ class: className })))
  return deco
}

// The inline elements and their classes; their marks hide while the selection is away.
const INLINE = new Map([
  ['StrongEmphasis', 'cm-md-strong'],
  ['Emphasis', 'cm-md-em'],
  ['Strikethrough', 'cm-md-strike'],
  ['InlineCode', 'cm-md-code'],
])
const INLINE_MARKS = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark'])
const HEADING = /^(?:ATX|Setext)Heading([1-6])$/

/**
 * The decorations for `state` within `visible`: each element styled, and its marks hidden unless
 * the selection touches the element (its line, for headings, quotes and list items) while
 * `focused`.
 */
export function previewDecorations(
  state: EditorState,
  focused: boolean,
  visible: readonly { from: number; to: number }[] = [{ from: 0, to: state.doc.length }],
): DecorationSet {
  const { doc, selection } = state
  const ranges: Range<Decoration>[] = []
  const touches = (from: number, to: number) =>
    focused && selection.ranges.some((range) => range.from <= to && range.to >= from)
  const lineTouched = (pos: number) => {
    const line = doc.lineAt(pos)
    return touches(line.from, line.to)
  }
  const show = (from: number, to: number) => {
    if (from < to) ranges.push(mark('cm-md-mark').range(from, to))
  }
  const hide = (from: number, to: number) => {
    if (from >= to) return
    // A view plugin may not replace a line break, which a link's `](` and URL can hold.
    if (doc.lineAt(from).number !== doc.lineAt(to).number) show(from, to)
    else ranges.push(hidden.range(from, to))
  }
  // A heading's opening mark and a quote's mark take the space after them with them.
  const withSpace = (to: number) => (doc.sliceString(to, to + 1) === ' ' ? to + 1 : to)
  const eachLine = (from: number, to: number, className: string) => {
    for (let pos = from; pos <= to;) {
      const line = doc.lineAt(pos)
      ranges.push(lineClass(className).range(line.from))
      pos = line.to + 1
    }
  }
  // `[text](url "title")`: the text styled, the rest a mark. A link with no URL, such as `[1]`,
  // stays as typed, as the thread shows one with no definition.
  const link = (node: SyntaxNode, offset: number) => {
    if (!node.getChild('URL')) return
    const open = node.firstChild
    let close = open?.nextSibling ?? null
    while (
      close &&
      !(
        close.name === 'LinkMark' && doc.sliceString(offset + close.from, offset + close.to) === ']'
      )
    )
      close = close.nextSibling
    if (!open || !close) return
    if (open.to < close.from)
      ranges.push(mark('cm-md-link').range(offset + open.to, offset + close.from))
    if (touches(offset + node.from, offset + node.to)) {
      show(offset + open.from, offset + open.to)
      show(offset + close.from, offset + node.to)
    } else {
      hide(offset + open.from, offset + open.to)
      hide(offset + close.from, offset + node.to)
    }
  }

  for (const { from: start, to: end } of visible) {
    if (start >= end) continue
    // A visible range is enough to draw, but a block that begins above it needs some context.
    const contextStart = doc.lineAt(Math.max(0, start - CONTEXT)).from
    const contextEnd = doc.lineAt(end).to
    const tree = markdown.parse(new DocInput(doc), [], [{ from: contextStart, to: contextEnd }])
    tree.iterate({
      from: start - contextStart,
      to: end - contextStart,
      enter: (ref) => {
        const { name } = ref
        const from = contextStart + ref.from
        const to = contextStart + ref.to
        const node = ref.node
        const heading = HEADING.exec(name)
        if (heading) {
          eachLine(Math.max(from, start), Math.min(to, end), `cm-md-h cm-md-h${heading[1]}`)
        } else if (name === 'Blockquote') {
          eachLine(Math.max(from, start), Math.min(to, end), 'cm-md-quote')
        } else if (INLINE.has(name)) {
          const han = name === 'Emphasis' && HAN.test(doc.sliceString(from, to))
          ranges.push(mark(han ? 'cm-md-em-han' : INLINE.get(name)!).range(from, to))
        } else if (name === 'Link') {
          link(node, contextStart)
        } else if (INLINE_MARKS.has(name)) {
          const parent = node.parent
          if (!parent || !INLINE.has(parent.name)) return
          if (touches(parent.from, parent.to)) show(from, to)
          else hide(from, to)
        } else if (name === 'HeaderMark') {
          if (node.parent?.name.startsWith('Setext') || lineTouched(from)) show(from, to)
          else hide(from, node.prevSibling ? to : withSpace(to))
        } else if (name === 'QuoteMark') {
          if (lineTouched(from)) show(from, to)
          else hide(from, withSpace(to))
        } else if (name === 'ListMark') {
          if (node.parent?.parent?.name === 'OrderedList')
            ranges.push(mark('cm-md-number').range(from, to))
          else if (lineTouched(from)) show(from, to)
          else ranges.push(bullet.range(from, to))
        }
      },
    })
  }
  return Decoration.set(ranges, true)
}

/** The decorations, kept in step with the text, the selection, the focus, the parse and the view. */
export const markdownPreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = previewDecorations(view.state, view.hasFocus, view.visibleRanges)
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.focusChanged || update.viewportChanged)
        this.decorations = previewDecorations(
          update.state,
          update.view.hasFocus,
          update.view.visibleRanges,
        )
    }
  },
  { decorations: (plugin) => plugin.decorations },
)
