// The composer's chips: the leading command as marks the caret can enter, so Backspace turns it
// back into text one letter at a time, and mentions and links as atomic widgets the caret steps
// over and Backspace deletes whole. A mention or link being typed stays text until the caret
// leaves it. A chip never spans lines, so an edit looks for chips again on the lines it touched.

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
import type { EditorState, Line } from '@codemirror/state'
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
  /** The draft attachments the text's mentions stand for, by key, whenever that changes. */
  onMentioned?: (keys: ReadonlySet<string>) => void
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

/** The chips on one line; only the first line can start with a command. */
function chipsOfLine(line: Line, hooks: ChipHooks): Chip[] {
  const context = line.number === 1 ? hooks : { commands: [], resolve: hooks.resolve }
  const chips = findChips(line.text, context)
  if (line.from === 0) return chips
  return chips.map((chip) => ({ ...chip, from: chip.from + line.from, to: chip.to + line.from }))
}

/** Every chip in the text, typed ones included, in order. */
function findAll(state: EditorState): Chip[] {
  const hooks = state.facet(chipHooks)
  if (!hooks) return []
  const chips: Chip[] = []
  for (let n = 1; n <= state.doc.lines; n++) chips.push(...chipsOfLine(state.doc.line(n), hooks))
  return chips
}

/** The chips after an edit: those on lines it left alone moved with the text, the rest found again. */
function refind(found: readonly Chip[], update: ViewUpdate): Chip[] {
  const hooks = update.state.facet(chipHooks)
  if (!hooks) return []
  const { doc } = update.state
  const touched: { from: number; to: number }[] = []
  update.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    const from = doc.lineAt(fromB).from
    const to = doc.lineAt(toB).to
    const last = touched.at(-1)
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to)
    else touched.push({ from, to })
  })
  const hit = (pos: number) => touched.some((range) => pos >= range.from && pos <= range.to)
  const chips: Chip[] = []
  for (const chip of found) {
    const from = update.changes.mapPos(chip.from, 1)
    const to = update.changes.mapPos(chip.to, -1)
    if (to <= from || hit(from) || hit(to)) continue
    chips.push(from === chip.from && to === chip.to ? chip : { ...chip, from, to })
  }
  for (const range of touched) {
    for (let pos = range.from; pos <= range.to;) {
      const line = doc.lineAt(pos)
      chips.push(...chipsOfLine(line, hooks))
      pos = line.to + 1
    }
  }
  return chips.sort((a, b) => a.from - b.from)
}

/** The draft attachments the chips stand for, by key. */
function attachmentKeys(chips: readonly Chip[]): Set<string> {
  const keys = new Set<string>()
  for (const chip of chips)
    if ('attachmentKey' in chip && chip.attachmentKey) keys.add(chip.attachmentKey)
  return keys
}

function draw(
  view: EditorView,
  found: readonly Chip[],
  typing: { from: number; to: number } | null,
): Drawn {
  const hooks = view.state.facet(chipHooks)
  if (!hooks) return { decorations: Decoration.none, atomic: Decoration.none, chips: [] }
  const plain = view.state.field(plainLinks)
  const selection = view.state.selection.main
  const marks = []
  const widgets = []
  const chips: Chip[] = []
  for (const chip of found) {
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
    found: Chip[]
    drawn: Drawn
    keys: ReadonlySet<string> = new Set()
    typing: { from: number; to: number } | null = null
    hovered: HTMLElement | null = null
    constructor(readonly view: EditorView) {
      this.found = findAll(view.state)
      this.drawn = draw(view, this.found, null)
      this.report(view.state)
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
      const hooks = update.state.facet(chipHooks)
      const before = update.startState.facet(chipHooks)
      // What resolves a chip changed, so every one is looked at again.
      const rescan = hooks?.commands !== before?.commands || hooks?.resolve !== before?.resolve
      if (rescan) this.found = findAll(update.state)
      else if (update.docChanged) this.found = refind(this.found, update)
      if (rescan || update.docChanged) this.report(update.state)
      if (
        rescan ||
        update.docChanged ||
        update.selectionSet ||
        hooks !== before ||
        update.startState.field(plainLinks) !== update.state.field(plainLinks)
      ) {
        this.drawn = draw(update.view, this.found, this.typing)
      }
    }
    report(state: EditorState) {
      const keys = attachmentKeys(this.found)
      if (keys.size === this.keys.size && [...keys].every((key) => this.keys.has(key))) return
      this.keys = keys
      const tell = state.facet(chipHooks)?.onMentioned
      if (tell) queueMicrotask(() => tell(keys))
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
