// The composer's chips: the leading command as marks the caret can enter, so Backspace turns it
// back into text one letter at a time, and mentions and links as atomic widgets the caret steps
// over and Backspace deletes whole. A mention or link being typed stays text until the caret
// leaves it.

import {
  Facet,
  RangeSet,
  RangeValue,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { createRoot, type Root } from 'react-dom/client'
import { RenderedChip, type ChipState } from './chip-view'
import { findChips, findLinks, mentionEndingAt, type Chip, type ChipContext } from './chips'

export interface ChipHooks extends ChipContext {
  /** The pointer rests on a chip, or left the one it was on. */
  onHover?: (chip: Chip | null, element: HTMLElement | null) => void
  /** A chip was clicked. */
  onOpen?: (chip: Chip) => void
  /** One link was pasted, now at `from` to `to`. */
  onLinkPasted?: (from: number, to: number) => void
  /** A range drawn as chosen besides the selection, as a link just pasted. */
  highlight?: { from: number; to: number } | null
}

export const chipHooks = Facet.define<ChipHooks, ChipHooks | null>({
  combine: (values) => values.at(-1) ?? null,
})

class Plain extends RangeValue {}
const PLAIN = new Plain()

/** Keeps the link from `from` to `to` as text, as Paste as text asks. */
export const keepAsText = StateEffect.define<{ from: number; to: number }>({
  map: ({ from, to }, changes) => ({ from: changes.mapPos(from, 1), to: changes.mapPos(to, -1) }),
})

const plainLinks = StateField.define<RangeSet<Plain>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    let next = set.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(keepAsText) && effect.value.to > effect.value.from) {
        next = next.update({ add: [PLAIN.range(effect.value.from, effect.value.to)] })
      }
    }
    return next
  },
})

const roots = new WeakMap<HTMLElement, Root>()

class ChipWidget extends WidgetType {
  constructor(
    readonly chip: Chip,
    readonly state: ChipState,
  ) {
    super()
  }
  eq(other: ChipWidget): boolean {
    return other.state === this.state && sameChip(other.chip, this.chip)
  }
  private render(root: Root, view: EditorView) {
    root.render(
      <RenderedChip chip={this.chip} state={this.state} onRendered={() => view.requestMeasure()} />,
    )
  }
  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement('span')
    dom.className = 'cm-chip'
    const root = createRoot(dom)
    roots.set(dom, root)
    this.render(root, view)
    return dom
  }
  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const root = roots.get(dom)
    if (!root) return false
    this.render(root, view)
    return true
  }
  destroy(dom: HTMLElement): void {
    const root = roots.get(dom)
    roots.delete(dom)
    // Not while React may be committing the change that removed it.
    if (root) queueMicrotask(() => root.unmount())
  }
  ignoreEvent(): boolean {
    return false
  }
}

/** Whether two chips draw the same, wherever they are in the text. */
function sameChip(a: Chip, b: Chip): boolean {
  if (a.kind === 'command' || b.kind === 'command') {
    return a.kind === b.kind && 'name' in a && 'name' in b && a.name === b.name
  }
  if (a.kind === 'link' || b.kind === 'link') {
    return a.kind === 'link' && b.kind === 'link' && a.url === b.url
  }
  return (
    a.kind === b.kind &&
    a.label === b.label &&
    a.lines === b.lines &&
    a.thumb === b.thumb &&
    !!a.missing === !!b.missing &&
    a.attachmentKey === b.attachmentKey &&
    a.path === b.path
  )
}

const commandMark = Decoration.mark({ class: 'cm-chip-command' })
const slashMark = Decoration.mark({ class: 'cm-chip-slash' })

interface Drawn {
  decorations: DecorationSet
  atomic: DecorationSet
  chips: Chip[]
}

const within = (chip: { from: number; to: number }, range: { from: number; to: number } | null) =>
  !!range && range.from <= chip.from && range.to >= chip.to && range.to > range.from

function draw(view: EditorView, typing: { from: number; to: number } | null): Drawn {
  const hooks = view.state.facet(chipHooks)
  if (!hooks) return { decorations: Decoration.none, atomic: Decoration.none, chips: [] }
  const plain = view.state.field(plainLinks)
  const selection = view.state.selection.main
  const marks = []
  const widgets = []
  const chips: Chip[] = []
  for (const chip of findChips(view.state.doc.toString(), hooks)) {
    if (chip.kind === 'command') {
      marks.push(commandMark.range(chip.from, chip.to), slashMark.range(chip.from, chip.from + 1))
      continue
    }
    if (typing && typing.from <= chip.to && typing.to >= chip.from) continue
    if (chip.kind === 'link') {
      let kept = false
      plain.between(chip.from, chip.to, () => {
        kept = true
        return false
      })
      if (kept) continue
    }
    const state: ChipState =
      within(chip, selection) || within(chip, hooks.highlight ?? null) ? 'selected' : 'default'
    widgets.push(
      Decoration.replace({ widget: new ChipWidget(chip, state) }).range(chip.from, chip.to),
    )
    chips.push(chip)
  }
  const atomic = Decoration.set(widgets)
  return { decorations: Decoration.set([...marks, ...widgets], true), atomic, chips }
}

/** The mention the caret ends, as a pick of a folder writes it: still being typed. */
function mentionAt(view: EditorView, head: number): { from: number; to: number } | null {
  const line = view.state.doc.lineAt(head)
  const start = mentionEndingAt(line.text.slice(0, head - line.from))
  return start < 0 ? null : { from: line.from + start, to: head }
}

/** The link or mention the caret is typing: the one it is in or at the end of, if any. */
function typingAt(view: EditorView, head: number): { from: number; to: number } | null {
  const line = view.state.doc.lineAt(head)
  for (const link of findLinks(line.text)) {
    const from = line.from + link.from
    const to = line.from + link.to
    if (head >= from && head <= to) return { from, to }
  }
  const mention = mentionAt(view, head)
  if (mention) return mention
  // A link still being typed, such as `https:/`, is not a link yet but will be.
  const before = line.text.slice(0, head - line.from)
  const start = before.search(/\S+$/)
  return start >= 0 && /^https?:?\/{0,2}/.test(before.slice(start))
    ? { from: line.from + start, to: head }
    : null
}

const chipPlugin = ViewPlugin.fromClass(
  class {
    drawn: Drawn
    typing: { from: number; to: number } | null = null
    hovered: HTMLElement | null = null
    constructor(readonly view: EditorView) {
      this.drawn = draw(view, null)
    }
    update(update: ViewUpdate) {
      const head = update.state.selection.main.head
      const event = (name: string) => update.transactions.some((tr) => tr.isUserEvent(name))
      if (update.docChanged) {
        if ((event('input.type') || event('input.complete')) && update.state.selection.main.empty) {
          this.typing = typingAt(update.view, head)
        } else if (this.typing && event('delete')) {
          // Deleting within what is being typed keeps it text, so a chip never takes the rest.
          this.typing = {
            from: update.changes.mapPos(this.typing.from, -1),
            to: update.changes.mapPos(this.typing.to, 1),
          }
        } else {
          this.typing =
            update.state.selection.main.empty && !event('delete')
              ? mentionAt(update.view, head)
              : null
        }
      }
      if (this.typing && (head < this.typing.from || head > this.typing.to)) this.typing = null
      if (update.transactions.some((tr) => tr.isUserEvent('input.paste'))) {
        this.typing = null
        this.pasted(update)
      }
      if (
        update.docChanged ||
        update.selectionSet ||
        update.startState.facet(chipHooks) !== update.state.facet(chipHooks) ||
        update.startState.field(plainLinks) !== update.state.field(plainLinks)
      ) {
        this.drawn = draw(update.view, this.typing)
      }
    }
    pasted(update: ViewUpdate) {
      const hooks = update.state.facet(chipHooks)
      if (!hooks?.onLinkPasted || update.transactions.length !== 1) return
      update.changes.iterChanges((_fromA, _toA, fromB, _toB, inserted) => {
        const text = inserted.toString()
        const links = findLinks(text)
        if (links.length === 1 && links[0]!.from === 0 && links[0]!.to === text.length) {
          const report = hooks.onLinkPasted!
          queueMicrotask(() => report(fromB, fromB + text.length))
        }
      })
    }
    chipAt(element: HTMLElement): Chip | null {
      const pos = this.view.posAtDOM(element)
      return this.drawn.chips.find((chip) => chip.from === pos) ?? null
    }
  },
  {
    decorations: (plugin) => plugin.drawn.decorations,
    eventHandlers: {
      mousedown(event) {
        const element = (event.target as HTMLElement).closest<HTMLElement>('.cm-chip')
        if (!element || event.button !== 0) return false
        const chip = this.chipAt(element)
        const hooks = this.view.state.facet(chipHooks)
        if (!chip || !hooks?.onOpen) return false
        event.preventDefault()
        hooks.onOpen(chip)
        return true
      },
      mouseover(event) {
        const element = (event.target as HTMLElement).closest<HTMLElement>('.cm-chip')
        if (element === this.hovered) return false
        this.hovered = element
        this.view.state.facet(chipHooks)?.onHover?.(element ? this.chipAt(element) : null, element)
        return false
      },
      mouseleave() {
        if (!this.hovered) return false
        this.hovered = null
        this.view.state.facet(chipHooks)?.onHover?.(null, null)
        return false
      },
    },
  },
)

/** The chips, from the context `hooks` gives; reconfigure it as the context changes. */
export function chips(): Extension {
  return [
    plainLinks,
    chipPlugin,
    EditorView.atomicRanges.of((view) => view.plugin(chipPlugin)?.drawn.atomic ?? RangeSet.empty),
  ]
}
