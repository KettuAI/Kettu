import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
} from 'react'
import { cjk } from '@streamdown/cjk'
import { createCodePlugin } from '@streamdown/code'
import { useTranslation } from 'react-i18next'
import { defaultRehypePlugins, Streamdown, type ExtraProps, type StreamdownProps } from 'streamdown'
import { markdownBlocks } from '@shared/artifact-document'
import { blockTag, blockWords, plainWords } from '@shared/artifact-document-anchors'
import { documentSections, type ChangedPassage } from '@shared/artifact-changes'
import { MESSAGE_BYTES } from '@shared/artifact-runtime/page-messages'
import {
  DOC_HEADINGS,
  DOC_KEPT_CHARS,
  DOC_PLACES,
  DOC_QUOTE_CHARS,
  type DocHeading,
  type DocKept,
  type DocPlace,
  type DocReport,
  type DocSaveState,
} from '@shared/artifact-runtime/document-sheet'
import type { ViewerConfig, ViewerView } from '@shared/artifact-types'
import { Empty, EmptyDescription, EmptyHeader } from '@renderer/components/ui/empty'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { kettuCodeTheme } from '@renderer/features/session/markdown/code-themes'
import { cn } from '@renderer/lib/utils'
import { markReady } from '../common/boot'
import { useSource, type Loaded } from '../common/use-source'
import { editedSource, mapSource, type SourceMap } from './edit-source'
import { report, useDrive } from './use-drive'
import { wordDiff } from './word-diff'

const plugins = {
  code: createCodePlugin({ themes: [kettuCodeTheme('light'), kettuCodeTheme('dark')] }),
  cjk,
}

// Links leave the page through the app, which asks before it opens one.
const linkSafety = { enabled: false }

/** A link, opened in the whole frame, where Kettu catches it and offers the browser. */
function Link({ href, title, children }: ComponentProps<'a'> & ExtraProps) {
  return (
    <a data-streamdown="link" href={href} title={title} target="_self" rel="noreferrer">
      {children}
    </a>
  )
}

const components = { a: Link }

// Pictures are the version's files, by paths relative to the page, which Streamdown lets through
// only when it has a base to resolve them against.
const rehypePlugins: StreamdownProps['rehypePlugins'] = Object.entries(defaultRehypePlugins).map(
  ([name, plugin]) =>
    name === 'harden' && Array.isArray(plugin)
      ? [plugin[0], { ...(plugin[1] as object), defaultOrigin: location.href }]
      : plugin,
)

/**
 * One block of the Markdown. Each renders apart, with the document's link definitions, so a block
 * that changes renders alone.
 */
const Block = memo(function Block({ source }: { source: string }) {
  return (
    <Streamdown
      mode="static"
      skipHtml
      plugins={plugins}
      components={components}
      rehypePlugins={rehypePlugins}
      linkSafety={linkSafety}
      controls={false}
      lineNumbers={false}
    >
      {source}
    </Streamdown>
  )
})

interface Part {
  from: number
  to: number
  kind: string
  /** The block's own text. */
  raw: string
  /** What renders it: its text with the link definitions it may use. */
  source: string
}

/** The text's blocks with the link definitions each needs to render on its own. */
function partsOf(text: string): Part[] {
  const blocks = markdownBlocks(text)
  const definitions = blocks
    .filter((block) => block.kind === 'LinkReference')
    .map((block) => text.slice(block.from, block.to))
    .join('\n')
  return blocks
    .filter((block) => block.kind !== 'LinkReference')
    .map((block) => {
      const raw = text.slice(block.from, block.to)
      return {
        from: block.from,
        to: block.to,
        kind: block.kind,
        raw,
        source: definitions ? `${raw}\n\n${definitions}` : raw,
      }
    })
}

/** Blocks whose text can be typed in place: not a table, a rule or raw HTML. */
const TYPED_IN_PLACE =
  /^(?:Paragraph|(?:ATX|Setext)Heading\d|BulletList|OrderedList|FencedCode|CodeBlock|Blockquote)$/

/** How long typing rests before it is saved as a version. */
const SAVE_AFTER_MS = 900
/** What a report may take of a message, leaving room for the message around it. */
const REPORT_BYTES = MESSAGE_BYTES - 2_048

function docBox(rect: DOMRect): { x: number; y: number; width: number; height: number } {
  return {
    x: rect.left + window.scrollX,
    y: rect.top + window.scrollY,
    width: rect.width,
    height: rect.height,
  }
}

/** A block's words for a diff: its Markdown marks dropped, one line per list item. */
function plainLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => plainWords(line))
    .filter((line) => line !== '')
}

function Diff({ before, after }: { before: string; after: string }) {
  return (
    <>
      {wordDiff(before, after).map((part, i) =>
        part.op === 'same' ? (
          <span key={i}>{part.text}</span>
        ) : part.op === 'removed' ? (
          <del key={i} className="kd-del">
            {part.text}
          </del>
        ) : (
          <ins key={i} className="kd-ins">
            {part.text}
          </ins>
        ),
      )}
    </>
  )
}

/** A changed block with its earlier words struck and its new ones marked, as plain text. */
function ChangedWords({ kind, before, after }: { kind: string; before: string; after: string }) {
  const heading = /Heading(\d)$/.exec(kind)
  if (heading) {
    const level = Number(heading[1])
    const H = `h${Math.min(6, level)}` as 'h2'
    return (
      <H data-streamdown={`heading-${level}`}>
        <Diff before={plainWords(before)} after={plainWords(after)} />
      </H>
    )
  }
  const was = plainLines(before)
  const now = plainLines(after)
  if ((kind === 'BulletList' || kind === 'OrderedList') && was.length === now.length) {
    const List = kind === 'OrderedList' ? 'ol' : 'ul'
    return (
      <List data-streamdown={kind === 'OrderedList' ? 'ordered-list' : 'unordered-list'}>
        {now.map((line, i) => (
          <li key={i} data-streamdown="list-item">
            <Diff before={was[i]!} after={line} />
          </li>
        ))}
      </List>
    )
  }
  return (
    <p>
      <Diff before={was.join(' ')} after={now.join(' ')} />
    </p>
  )
}

interface Editing {
  /** The block's index among the parts, and where it starts. */
  index: number
  at: number
  /** What it rendered when typing began, which stays on screen while it is typed. */
  source: string
  /** Its text as last saved, or as it was. */
  saved: string
  /** Where the click that began it landed, for the caret. */
  point: { x: number; y: number } | null
  /** Its text as typed in an earlier frame, which it shows from the start; else as saved. */
  typed?: string
}

/** The document with a block replaced, found again nearest its place when a new version moved it. */
function withBlock(
  was: string,
  at: number,
  block: string,
  base: string,
): { text: string; at: number } | null {
  let found = base.slice(at, at + was.length) === was ? at : -1
  if (found < 0) {
    for (let i = base.indexOf(was); i >= 0; i = base.indexOf(was, i + 1)) {
      if (found < 0 || Math.abs(i - at) < Math.abs(found - at)) found = i
    }
  }
  if (found < 0) return null
  return { text: base.slice(0, found) + block + base.slice(found + was.length), at: found }
}

export function DocumentViewer({ config, view }: { config: ViewerConfig; view: ViewerView }) {
  const { t } = useTranslation('viewers')
  const asks = useRef<(ask: 'undo' | 'retry') => void>(() => {})
  const state = useDrive((ask) => asks.current(ask))
  const doc = useSource(config, state?.version ?? null)
  const text = doc.loaded?.text ?? null
  const version = doc.loaded?.version ?? config.version
  const parts = useMemo(() => (text === null ? [] : partsOf(text)), [text])
  const sections = useMemo(() => (text === null ? [] : documentSections(text)), [text])
  const article = useRef<HTMLElement>(null)
  const mode = state?.mode ?? 'view'
  const embed = state?.embed ?? false

  useLayoutEffect(() => {
    if (text !== null) void markReady()
  }, [text])

  // The window's theme and the sheet it lays the document out on.
  useLayoutEffect(() => {
    if (state) document.documentElement.dataset.theme = state.theme
  }, [state])
  useLayoutEffect(() => {
    document.documentElement.toggleAttribute('data-embed', embed)
  }, [embed])

  // What the shown version changed, and its earlier words while Changes is on.
  const marks = state?.marks && state.marks.from < version ? state.marks : null
  const [earlier, setEarlier] = useState<{ version: number; text: string } | null>(null)
  const showChanges = !!marks && !!state?.changes && mode !== 'edit'
  useEffect(() => {
    if (!showChanges || !marks || earlier?.version === marks.from) return
    let live = true
    void doc.textOf(marks.from).then((old) => {
      if (live && old !== null) setEarlier({ version: marks.from, text: old })
    })
    return () => {
      live = false
    }
  }, [showChanges, marks, earlier?.version, doc])
  const passages = useMemo(() => {
    const changed = new Map<number, ChangedPassage>()
    const removed = new Map<number, ChangedPassage[]>()
    for (const passage of marks?.passages ?? []) {
      if (passage.change === 'removed') {
        removed.set(passage.from, [...(removed.get(passage.from) ?? []), passage])
      } else changed.set(passage.from, passage)
    }
    return { changed, removed }
  }, [marks])
  const changedSlugs = useMemo(
    () => new Set((marks?.passages ?? []).map((p) => p.section).filter((s) => s !== null)),
    [marks],
  )
  const headingAt = useMemo(() => {
    const out = new Map<number, string>()
    for (const section of sections) if (section.slug !== null) out.set(section.from, section.slug)
    return out
  }, [sections])
  const oldText = earlier && marks && earlier.version === marks.from ? earlier.text : null
  // The blocks an agent is writing, by where they start; the first of them takes its tag.
  const writing = state?.writing ?? null
  const heldSpan = useMemo(() => {
    if (!writing) return null
    if (writing.section === null) return { from: 0, to: Infinity }
    const section = sections.find((s) => s.slug === writing.section)
    return section ? { from: section.from, to: section.to } : null
  }, [writing, sections])
  const heldAt = (from: number) => !!heldSpan && from >= heldSpan.from && from < heldSpan.to

  // Typing in place.
  const [editing, setEditing] = useState<Editing | null>(null)
  const edit = useRef<{
    map: SourceMap | null
    timer: number
    busy: boolean
    again: boolean
    /** The document before the first save of this run, which Undo writes back. */
    before: Loaded | null
    last: number | null
    state: DocSaveState | null
  }>({ map: null, timer: 0, busy: false, again: false, before: null, last: null, state: null })
  const loaded = useRef(doc.loaded)
  useEffect(() => {
    loaded.current = doc.loaded
  })
  const editingRef = useRef(editing)
  useEffect(() => {
    editingRef.current = editing
  })

  /** `kept` is what did not save, for the window to keep; null once nothing waits. */
  const tell = useCallback(
    (next: DocSaveState, saved: number | null = edit.current.last, kept?: DocKept | null) => {
      edit.current.state = next
      report({
        t: 'save',
        state: next,
        version: saved,
        undo: edit.current.before !== null,
        ...(kept !== undefined && { kept }),
      })
    },
    [],
  )

  const docRef = useRef(doc)
  useEffect(() => {
    docRef.current = doc
  })
  const blockElement = useCallback(
    (index: number): HTMLElement | null =>
      article.current?.querySelector<HTMLElement>(`[data-index="${index}"]`) ?? null,
    [],
  )

  const save = useCallback(async (): Promise<void> => {
    const now = editingRef.current
    const run = edit.current
    const doc = docRef.current
    const element = now ? blockElement(now.index) : null
    if (!now || !element || !run.map) return
    if (run.busy) {
      run.again = true
      return
    }
    const block = editedSource(element, run.map)
    if (block === null) return tell('refused')
    if (block === now.saved) {
      // Typed back to what it was, nothing waits to save any more.
      if (run.state === 'editing' || run.state === 'failed' || run.state === 'conflict') {
        tell(run.last === null ? 'editing' : 'saved', undefined, null)
      }
      return
    }
    const kept =
      block.length <= DOC_KEPT_CHARS && now.saved.length <= DOC_KEPT_CHARS
        ? { at: now.at, was: now.saved, now: block }
        : null
    const base = loaded.current
    if (!base || doc.head === null) return tell('failed', undefined, kept)
    run.busy = true
    tell('saving')
    let next = withBlock(now.saved, now.at, block, base.text)
    let written = next === null ? null : await doc.write(doc.head, next.text)
    if (written && !written.ok && written.code === 'conflict') {
      // Another version came first: the same change on it, if its block is still there.
      const latest = await docRef.current.latest()
      next = latest ? withBlock(now.saved, now.at, block, latest.text) : null
      written = latest && next !== null ? await doc.write(latest.version, next.text) : null
    }
    run.busy = false
    if (!written || !written.ok || next === null) {
      tell(
        written?.ok === false && written.code === 'invalid'
          ? 'refused'
          : written
            ? 'failed'
            : 'conflict',
        undefined,
        kept,
      )
    } else {
      run.before ??= base
      run.last = written.version
      const typing = { ...now, at: next.at, saved: block }
      editingRef.current = typing
      setEditing(typing)
      tell('saved', written.version, null)
    }
    if (run.again) {
      run.again = false
      asks.current('retry')
    }
  }, [tell, blockElement])

  const undo = useCallback(async (): Promise<void> => {
    const run = edit.current
    const doc = docRef.current
    const before = run.before
    if (!before || doc.head === null || run.busy) return
    clearTimeout(run.timer)
    run.busy = true
    tell('saving')
    const written = await doc.write(doc.head, before.text)
    run.busy = false
    if (!written.ok) return tell(written.code === 'conflict' ? 'conflict' : 'failed')
    run.before = null
    run.map = null
    run.last = written.version
    editingRef.current = null
    setEditing(null)
    tell('saved', written.version, null)
  }, [tell])

  useEffect(() => {
    asks.current = (ask) => void (ask === 'undo' ? undo() : save())
  }, [undo, save])

  // Leaving Edit ends the typing once it is saved; what did not save stays where it was typed.
  const finish = useCallback(async (): Promise<boolean> => {
    const run = edit.current
    clearTimeout(run.timer)
    if (!editingRef.current) return true
    await save()
    if (run.state === 'failed' || run.state === 'conflict' || run.state === 'refused') return false
    run.map = null
    editingRef.current = null
    setEditing(null)
    return true
  }, [save])
  useEffect(() => {
    if (mode !== 'edit') {
      void finish()
      edit.current.before = null
    }
  }, [mode, finish])

  // The block being typed in: its words found in its source, and the caret where it was clicked.
  useLayoutEffect(() => {
    if (!editing) return
    const element = blockElement(editing.index)
    if (!element || edit.current.map) return
    const codeBlock = /Code/.test(parts[editing.index]?.kind ?? '')
    edit.current.map = mapSource(element, editing.typed ?? editing.saved, codeBlock)
    // A block shown again as typed takes the keyboard once it is clicked.
    if (editing.typed === undefined) element.focus()
    const point = editing.point
    const range = point ? document.caretRangeFromPoint(point.x, point.y) : null
    const selection = window.getSelection()
    if (range && element.contains(range.startContainer)) {
      selection?.removeAllRanges()
      selection?.addRange(range)
    }
  }, [editing, blockElement, parts])

  const startEditing = (index: number, point: { x: number; y: number } | null): void => {
    const part = parts[index]
    if (!part || !TYPED_IN_PLACE.test(part.kind) || doc.head === null || doc.head !== version)
      return
    if (editingRef.current?.at === part.from) return
    void finish().then((done) => {
      if (!done) return
      const next = { index, at: part.from, source: part.source, saved: part.raw, point }
      edit.current.map = null
      editingRef.current = next
      setEditing(next)
      tell('editing')
    })
  }

  // What an earlier frame typed and could not save: its block shows it again, as it failed.
  const keptAsked = state?.kept ?? null
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current || !keptAsked || text === null || mode !== 'edit') return
    if (doc.head === null || doc.head !== version) return
    restored.current = true
    if (editingRef.current) return
    let index = -1
    parts.forEach((part, i) => {
      if (part.raw !== keptAsked.was || !TYPED_IN_PLACE.test(part.kind)) return
      if (
        index < 0 ||
        Math.abs(part.from - keptAsked.at) < Math.abs(parts[index]!.from - keptAsked.at)
      )
        index = i
    })
    const part = parts[index]
    // A newer version changed the block: what was typed has no place to show.
    if (!part) return tell('conflict', undefined, keptAsked)
    const next = {
      index,
      at: part.from,
      source: keptAsked.now + part.source.slice(part.raw.length),
      saved: part.raw,
      point: null,
      typed: keptAsked.now,
    }
    edit.current.map = null
    editingRef.current = next
    // After this pass, as a click that starts typing does.
    queueMicrotask(() => {
      setEditing(next)
      tell('failed', undefined, keptAsked)
    })
  }, [keptAsked, text, mode, doc.head, version, parts, tell])

  // The layout the window lays its pins, outline and scroll on.
  const lastLayout = useRef('')
  const measure = useCallback(() => {
    if (!state || !article.current || text === null) return
    const placeOf = (el: HTMLElement): { y: number; height: number } => {
      const rect = el.getBoundingClientRect()
      return { y: rect.top + window.scrollY, height: rect.height }
    }
    const headings: DocHeading[] = []
    for (const section of sections) {
      if (section.slug === null || section.heading === null) continue
      const index = parts.findIndex((p) => p.from === section.from)
      const el = index < 0 ? null : blockElement(index)
      if (!el) continue
      headings.push({
        at: section.from,
        level: section.level,
        slug: section.slug,
        text: section.heading,
        y: placeOf(el).y,
      })
      if (headings.length === DOC_HEADINGS) break
    }
    const places: DocPlace[] = []
    for (const at of state.track.slice(0, DOC_PLACES)) {
      let index = parts.findIndex((p) => at >= p.from && at < p.to)
      if (index < 0) index = parts.findIndex((p) => p.from >= at)
      const el = index < 0 ? null : blockElement(index)
      if (el) places.push({ at, ...placeOf(el) })
    }
    const height = Math.ceil(article.current.getBoundingClientRect().height)
    const layout: DocReport = { t: 'layout', version, height, headings, places }
    let json = JSON.stringify(layout)
    // A long document's last headings go first, then its last places, to fit one message.
    while (
      new TextEncoder().encode(json).length > REPORT_BYTES &&
      (headings.length || places.length)
    ) {
      if (headings.length) headings.splice(Math.floor(headings.length * 0.9))
      else places.splice(Math.floor(places.length * 0.9))
      json = JSON.stringify(layout)
    }
    if (json === lastLayout.current) return
    lastLayout.current = json
    report(layout)
  }, [state, text, sections, parts, version, blockElement])
  const frame = useRef(0)
  const schedule = useCallback(() => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(measure)
  }, [measure])
  useLayoutEffect(() => {
    schedule()
  })
  useEffect(() => {
    const el = article.current
    if (!el) return
    const observer = new ResizeObserver(schedule)
    observer.observe(el)
    // Pictures change the height as they load.
    el.addEventListener('load', schedule, true)
    return () => {
      observer.disconnect()
      el.removeEventListener('load', schedule, true)
    }
  }, [schedule, text])

  // Words selected in View, for the window's small bar.
  const selected = useRef(false)
  const readSelection = useCallback(() => {
    if (!state || mode !== 'view') return
    const selection = window.getSelection()
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
    const start = range?.startContainer
    const block =
      start && (start instanceof Element ? start : start.parentElement)?.closest('[data-at]')
    const quote = selection?.toString().replace(/\s+/g, ' ').trim() ?? ''
    if (!range || selection?.isCollapsed || !block || !quote || !article.current?.contains(block)) {
      if (selected.current) report({ t: 'select', at: null })
      selected.current = false
      return
    }
    const at = Number((block as HTMLElement).dataset.at)
    const part = parts.find((p) => p.from === at)
    if (!part) return
    selected.current = true
    report({
      t: 'select',
      at,
      tag: blockTag(part.kind),
      text: blockWords(part.raw),
      quote: Array.from(quote).slice(0, DOC_QUOTE_CHARS).join(''),
      box: docBox(range.getBoundingClientRect()),
    })
  }, [state, mode, parts])
  useEffect(() => {
    const onUp = () => setTimeout(readSelection)
    document.addEventListener('mouseup', onUp)
    document.addEventListener('keyup', onUp)
    return () => {
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('keyup', onUp)
    }
  }, [readSelection])
  useEffect(() => {
    if (mode !== 'view' && selected.current) {
      selected.current = false
      window.getSelection()?.removeAllRanges()
      report({ t: 'select', at: null })
    }
  }, [mode])

  if (doc.failed) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyDescription>{t('load.failed')}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const onClick = (event: React.MouseEvent): void => {
    if (!state || mode === 'view') return
    const target = event.target as Element
    const block = target.closest<HTMLElement>('[data-at]')
    // A link or a button in the document does nothing while blocks are picked or typed in.
    if (target.closest('a')) event.preventDefault()
    if (!block) return
    const at = Number(block.dataset.at)
    const index = parts.findIndex((p) => p.from === at)
    const part = parts[index]
    if (!part) return
    if (mode === 'comment') {
      report({
        t: 'pick',
        at,
        tag: blockTag(part.kind),
        text: blockWords(part.raw),
        box: docBox(block.getBoundingClientRect()),
      })
    } else if (!heldAt(part.from)) {
      // A section an agent is writing takes no typing until its turn ends.
      startEditing(index, { x: event.clientX, y: event.clientY })
    }
  }

  const onInput = (): void => {
    const run = edit.current
    clearTimeout(run.timer)
    if (run.state !== 'editing') tell('editing')
    run.timer = window.setTimeout(() => void save(), SAVE_AFTER_MS)
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (!editing) return
    const code = /Code/.test(parts[editing.index]?.kind ?? '')
    if (
      event.key === 'Escape' ||
      (event.key === 'Enter' && !code && !event.nativeEvent.isComposing)
    ) {
      event.preventDefault()
      void finish().then(() => (document.activeElement as HTMLElement | null)?.blur())
    }
  }

  const pad = state?.pad
  const narrow = pad !== undefined && pad <= 24
  const style = {
    '--doc-scale': (state?.size ?? 100) / 100,
    ...(pad !== undefined ? { '--doc-pad': `${pad}px` } : {}),
  } as CSSProperties

  const removedBlocks = (at: number) =>
    (passages.removed.get(at) ?? []).map((passage, i) =>
      showChanges && oldText !== null && passage.before ? (
        <div key={`removed-${at}-${i}`} className="kd-block" data-removed="">
          <Block source={oldText.slice(passage.before.from, passage.before.to)} />
        </div>
      ) : (
        <span key={`removed-${at}-${i}`} className="kd-gone" aria-hidden />
      ),
    )

  return (
    <main
      className={cn('kd-page', view === 'thumbnail' && 'document-thumbnail')}
      data-driven={state ? '' : undefined}
    >
      <article
        ref={article}
        className="markdown kd-doc"
        data-mode={state ? mode : 'view'}
        data-narrow={narrow || undefined}
        data-changes={showChanges || undefined}
        data-still={state?.still || undefined}
        aria-busy={text === null}
        style={style}
        onClick={onClick}
        onInput={onInput}
        onKeyDown={onKeyDown}
      >
        {text === null ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        ) : (
          <>
            {parts.map((part, index) => {
              const passage = passages.changed.get(part.from)
              const typing = editing?.index === index
              const slug = headingAt.get(part.from)
              const tag =
                slug && changedSlugs.has(slug)
                  ? `"v${marks?.sections?.[slug] ?? version}"`
                  : undefined
              const held = heldAt(part.from)
              // A section's tag sits after its heading; all of it being written, the pill says so.
              const firstHeld =
                held && writing?.section != null && !heldAt(parts[index - 1]?.from ?? -1)
              const words =
                showChanges && passage?.change === 'changed' && passage.before && oldText !== null
                  ? oldText.slice(passage.before.from, passage.before.to)
                  : null
              return [
                ...removedBlocks(part.from),
                // A block typed in is a new element once typing ends, so what the browser changed in
                // it never stays over what the document now says.
                <div
                  key={typing ? `typing-${index}` : index}
                  className="kd-block"
                  data-at={part.from}
                  data-index={index}
                  data-tag={blockTag(part.kind)}
                  data-changed={passage?.change}
                  data-step={state?.step === part.from || undefined}
                  data-on={state?.focus === part.from || undefined}
                  data-writing={held || undefined}
                  data-editing={typing || undefined}
                  data-fixed={TYPED_IN_PLACE.test(part.kind) ? undefined : ''}
                  data-writer={firstHeld || undefined}
                  style={
                    tag || firstHeld
                      ? ({
                          ...(tag && { '--kd-tag': tag }),
                          ...(firstHeld && { '--kd-writer': JSON.stringify(writing!.tag) }),
                        } as CSSProperties)
                      : undefined
                  }
                  contentEditable={typing && mode === 'edit' ? 'plaintext-only' : undefined}
                  suppressContentEditableWarning
                  spellCheck={typing ? false : undefined}
                >
                  {held && <span aria-hidden className="kd-writing" />}
                  {typing ? (
                    <Block source={editing.source} />
                  ) : words !== null ? (
                    <ChangedWords kind={part.kind} before={words} after={part.raw} />
                  ) : (
                    <Block source={part.source} />
                  )}
                </div>,
              ]
            })}
            {removedBlocks(text.length)}
          </>
        )}
      </article>
    </main>
  )
}
