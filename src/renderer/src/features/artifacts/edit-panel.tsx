import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight01Icon,
  Comment01Icon,
  MinusSignIcon,
  PencilEdit02Icon,
  PlusSignIcon,
  TextAlignCenterIcon,
  TextAlignLeftIcon,
  TextAlignRightIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import {
  isEditableValue,
  type EditableProperty,
  type PreviewStyle,
} from '@shared/artifact-runtime/page-messages'
import { decodeText, startTagAt, textContentRange } from '@shared/artifact-source'
import { Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { SegmentedControl } from '@renderer/components/affect/segmented-control'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Select, SettingsStyles } from '@renderer/features/routines/kit'
import { errorCode, errorMessage, host } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'
import { cn } from '@renderer/lib/utils'
import { dropUnsaved, keepUnsaved, unsavedAt, unsavedSlot } from '@renderer/stores/artifact-unsaved'
import type { ArtifactEditor, Picked } from './editor'
import { CardHead, KeptNote, Notice, SaveChip, UndoButton } from './tool-parts'
import { useEditRun } from './use-edit-run'

const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const
/** How long the fields rest before what changed is written. */
const AUTOSAVE_MS = 900
const ALIGNS = [
  { value: 'left', icon: TextAlignLeftIcon },
  { value: 'center', icon: TextAlignCenterIcon },
  { value: 'right', icon: TextAlignRightIcon },
] as const
/** Tags whose box the card offers besides their text. */
const BOXED = new Set(['button', 'a', 'label', 'td', 'th', 'li'])
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const NAMED = new Set([
  'p',
  'button',
  'a',
  'img',
  'ul',
  'ol',
  'li',
  'section',
  'header',
  'footer',
  'nav',
  'main',
  'article',
  'aside',
  'div',
  'span',
  'table',
  'form',
  'input',
  'label',
  'svg',
])

/** An element's name as the card's title and path say it: "Heading", "Button", "List". */
function elementName(tag: string): string {
  if (HEADINGS.has(tag)) return i18n.t('artifacts:edit.tags.heading')
  if (NAMED.has(tag)) return i18n.t(`artifacts:edit.tags.${tag as 'p'}`)
  return tag
}

/** The fields as the user types them, each its CSS value once checked. */
interface Fields {
  text: string | null
  color: string
  background: string
  size: string
  weight: string
  align: string
  padding: string
  radius: string
}

function trimmed(value: number): string {
  return String(Math.round(value * 100) / 100)
}

/** "0 · 14" for a padding the same top and bottom, left and right; else all four. */
function paddingText(padding: [number, number, number, number] | null): string {
  if (!padding) return ''
  const [top, right, bottom, left] = padding.map(trimmed)
  if (top === bottom && left === right) return top === right ? top! : `${top} · ${right}`
  return `${top} · ${right} · ${bottom} · ${left}`
}

/** The fields' CSS values, each one the user may have typed in its own way; null when invalid. */
function cssOf(field: keyof Fields, value: string): string | null {
  const text = value.trim().toLowerCase()
  if (text === '') return null
  switch (field) {
    case 'color':
    case 'background': {
      const hex = text.startsWith('#') ? text : `#${text}`
      const full = /^#[0-9a-f]{3}$/.test(hex)
        ? `#${[...hex.slice(1)].map((c) => c + c).join('')}`
        : hex
      return isEditableValue('color', full) ? full : null
    }
    case 'size':
    case 'radius': {
      const px = `${text.replace(/px$/, '').trim()}px`
      return isEditableValue(field === 'size' ? 'font-size' : 'border-radius', px) ? px : null
    }
    case 'padding': {
      const parts = text
        .split(/[\s·,]+/)
        .filter(Boolean)
        .map((part) => `${part.replace(/px$/, '')}px`)
      const css = parts.join(' ')
      return isEditableValue('padding', css) ? css : null
    }
    case 'weight':
    case 'align':
      return text
    default:
      return null
  }
}

const PROPERTY: Record<Exclude<keyof Fields, 'text'>, EditableProperty> = {
  color: 'color',
  background: 'background-color',
  size: 'font-size',
  weight: 'font-weight',
  align: 'text-align',
  padding: 'padding',
  radius: 'border-radius',
}

function sameFields(a: Fields, b: Fields): boolean {
  return (Object.keys(a) as (keyof Fields)[]).every((field) => a[field] === b[field])
}

/** What differs from where the fields started: the style to write, and the text if changed. */
function changes(start: Fields, now: Fields): { style: PreviewStyle; text: string | null } {
  const style: PreviewStyle = {}
  for (const field of Object.keys(PROPERTY) as Exclude<keyof Fields, 'text'>[]) {
    if (now[field] === start[field]) continue
    const css = cssOf(field, now[field])
    if (css !== null) style[PROPERTY[field]] = css
  }
  return { style, text: now.text !== null && now.text !== start.text ? now.text : null }
}

/** The fields of `now` that differ from `from`, as typed. */
function typedFields(from: Fields, now: Fields): Partial<Fields> {
  const typed: Partial<Fields> = {}
  for (const field of Object.keys(now) as (keyof Fields)[]) {
    if (now[field] !== from[field]) typed[field] = now[field] as never
  }
  return typed
}

/** The element a write changes: its file, where its start tag is and the version that says so. */
interface Target {
  path: string
  offset: number
  version: number
}

// One write at a time for the whole window, so a write waits for the version the one before makes.
let writing: Promise<void> = Promise.resolve()

/**
 * The source of the picked element's file in the version shown, for its text as written and to
 * check that the page's offset names an element there.
 */
function useSource(
  id: string,
  version: number,
  path: string,
): { text: string | 'failed'; version: number } | null {
  const [source, setSource] = useState<{
    id: string
    path: string
    version: number
    text: string | 'failed'
  } | null>(null)
  useEffect(() => {
    let live = true
    host('artifacts.file', { id, version, path }).then(
      ({ bytes }) => {
        if (live) setSource({ id, path, version, text: new TextDecoder().decode(bytes) })
      },
      () => {
        if (live) setSource({ id, path, version, text: 'failed' })
      },
    )
    return () => {
      live = false
    }
  }, [id, version, path])
  // A new version of the same file keeps the last one shown until it arrives, so the fields stay.
  return source?.id === id && source.path === path ? source : null
}

/** The agent whose running turn wrote the piece the element is in, which takes no edit until then. */
const HELD_TITLE = {
  page: 'edit.heldTitlePage',
  frame: 'edit.heldTitleFrame',
  section: 'edit.heldTitleSection',
  slide: 'edit.heldTitleSlide',
} as const
const HELD_NAME = {
  page: 'edit.heldPage',
  frame: 'edit.heldFrame',
  section: 'edit.heldSection',
  slide: 'edit.heldSlide',
} as const

export interface HeldBy {
  sessionId: string
  /** What the agent's turn holds of the artifact, which the card names. */
  piece: 'page' | 'frame' | 'section' | 'slide'
  /** Null for a session this window does not know, which is named as no particular agent. */
  agent: {
    name: string
    id: Parameters<typeof AgentMark>[0]['agent']
    hostId: string | null
  } | null
}

/**
 * The Properties card once an element is picked in Edit: its name and the path to it, then its
 * text and look, previewed in the page as they change and written as a new version once they rest,
 * with Undo. An element a script drew, or one an agent is writing, says why instead.
 */
export function EditPanel({
  id,
  version,
  editable,
  picked,
  editor,
  heldBy,
  askLabel,
  onAsk,
  onComment,
  onOpenSession,
}: {
  id: string
  /** The version shown, where the element was picked. */
  version: number
  /** Why it cannot be edited: an earlier version, or one in Recently deleted. */
  editable: 'yes' | 'earlier' | 'deleted'
  picked: Picked
  editor: ArtifactEditor
  heldBy: HeldBy | null
  /** "Ask Claude Code about this…" */
  askLabel: string
  onAsk: () => void
  onComment: () => void
  onOpenSession: (sessionId: string) => void
}) {
  const { t } = useTranslation('artifacts')
  const { selection } = picked
  const loaded = useSource(id, version, selection.path)
  const source = loaded?.text ?? null
  const element = useMemo(() => {
    if (!source || source === 'failed' || selection.src === null) return null
    const tag = startTagAt(source, selection.src)
    return tag && tag.name === selection.tag ? tag : null
  }, [source, selection.src, selection.tag])

  const start = useMemo<Fields>(() => {
    const range = element && typeof source === 'string' ? textContentRange(source, element) : null
    const { style } = selection
    return {
      text:
        range && typeof source === 'string'
          ? decodeText(source.slice(range.start, range.end))
          : null,
      color: style.color?.slice(0, 7).toUpperCase() ?? '',
      background:
        style.background && !style.background.endsWith('00')
          ? style.background.slice(0, 7).toUpperCase()
          : '',
      size: style.fontSize === null ? '' : trimmed(style.fontSize),
      weight: style.fontWeight === null ? '' : String(Math.round(style.fontWeight / 100) * 100),
      align: style.textAlign ?? '',
      padding: paddingText(style.padding),
      radius: style.radius === null ? '' : trimmed(style.radius),
    }
  }, [element, source, selection])
  // A change to this element that did not save before the viewer was left, shown again.
  const slot = unsavedSlot({
    kind: 'element',
    page: picked.page,
    path: selection.path,
    src: selection.src ?? -1,
  })
  const [kept, setKept] = useState(() => {
    const change = unsavedAt(id, slot)
    return change?.kind === 'element' ? change : null
  })
  const [fields, setFields] = useState<Fields>(() => ({ ...start, ...kept?.fields }))
  // What the latest version holds, as far as this card knows.
  const [written, setWritten] = useState<Fields>(start)
  const [refused, setRefused] = useState<'held' | null>(null)
  const run = useEditRun(id, kept ? { state: 'failed', error: kept.error } : null)
  // The change on screen failed to save and has not changed since: it waits for Retry.
  const resting = useRef(kept !== null)
  // The version a kept change was made on, so a newer one is a conflict before it is written over.
  const keptBase = useRef(kept?.version ?? null)
  // The fields as they were before this card's run of saves, which Undo puts back.
  const runStart = useRef<Fields | null>(null)
  const [ran, setRan] = useState(false)
  // The element's source arrived: untouched fields follow it. Once the card has written, its
  // fields are what the latest version holds, so the pages its writes make change nothing here.
  const [shownStart, setShownStart] = useState(start)
  if (shownStart !== start) {
    setShownStart(start)
    if (kept && !ran) {
      setFields({ ...start, ...kept.fields })
      setWritten(start)
    } else if (!ran && sameFields(fields, written)) {
      setFields(start)
      setWritten(start)
    }
  }
  const diff = changes(start, fields)
  const changed = Object.keys(diff.style).length > 0 || diff.text !== null

  useEffect(() => {
    if (changed) editor.preview(diff.style, diff.text)
    else editor.resetPreview()
    // The preview follows the fields' values, not each new object, and comes back on a new page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, JSON.stringify(diff), changed, selection])

  // What is typed in place goes into the Text field, which saves as the other fields do.
  useEffect(
    () =>
      editor.onTyped((text) => {
        resting.current = false
        setKept(null)
        setFields((now) => (now.text === null ? now : { ...now, text }))
      }),
    [editor],
  )

  const set = (patch: Partial<Fields>) => {
    resting.current = false
    setKept(null)
    setFields((now) => ({ ...now, ...patch }))
  }

  const target: Target | null =
    element && loaded && editable === 'yes' && !heldBy
      ? { path: selection.path, offset: element.start, version: loaded.version }
      : null
  const live = useRef(true)
  // The last version this card wrote: its own writes keep the element where it starts.
  const wrote = useRef(0)
  const queued = useRef(start)
  const now = useRef({ fields, written, target })
  useEffect(() => {
    now.current = { fields, written, target }
  })

  /** Writes what changed from `from` to `snapshot`, after any write already on its way. */
  const save = (snapshot: Fields, from: Fields, to: Target) => {
    if (sameFields(snapshot, queued.current)) return
    queued.current = snapshot
    const change = changes(from, snapshot)
    if (Object.keys(change.style).length === 0 && change.text === null) {
      run.settle()
      return
    }
    run.pending()
    runStart.current ??= from
    setRan(true)
    resting.current = false
    writing = writing.then(async () => {
      const base = keptBase.current ?? Math.max(to.version, wrote.current)
      try {
        const { version: made } = await host('artifacts.editElement', {
          id,
          // A version anyone else wrote may have moved the element, so it is a conflict.
          baseVersion: base,
          path: to.path,
          offset: to.offset,
          style: Object.keys(change.style).length > 0 ? change.style : null,
          text: change.text,
        })
        wrote.current = made
        keptBase.current = null
        dropUnsaved(id, slot)
        run.wrote(made, base)
        if (live.current) setWritten(snapshot)
      } catch (reason) {
        // Nothing typed is lost: the fields keep it and the chip offers to try again.
        queued.current = from
        // The next try is made on the version shown by then.
        if (errorCode(reason) === 'conflict') keptBase.current = null
        if (errorCode(reason) === 'conflict' && hasHeld(reason)) {
          if (live.current) setRefused('held')
          run.settle()
        } else {
          // Kept beyond this card, which may be gone by now, until it saves or is discarded.
          keepUnsaved(id, {
            kind: 'element',
            page: picked.page,
            path: to.path,
            src: selection.src ?? -1,
            fields: typedFields(from, snapshot),
            version: base,
            error: errorMessage(reason),
          })
          resting.current = sameFields(snapshot, now.current.fields)
          run.failed(reason)
        }
      }
    })
  }

  const dirty = !sameFields(fields, written)
  const fieldsKey = JSON.stringify(fields)
  useEffect(() => {
    if (!dirty || !target || resting.current) return
    run.pending()
    const timer = setTimeout(() => {
      const at = now.current
      if (at.target) save(at.fields, at.written, at.target)
    }, AUTOSAVE_MS)
    return () => clearTimeout(timer)
    // A change of the fields starts the wait over; `save` reads the latest of them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldsKey, dirty, target?.path, target?.offset])

  // Picking another element or leaving Edit writes what has not been yet.
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      const at = now.current
      if (at.target && !resting.current && !sameFields(at.fields, at.written)) {
        save(at.fields, at.written, at.target)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Put back by hand, a change that failed is no longer there to save.
  const failed = run.save?.state === 'failed'
  const dismiss = run.dismiss
  useEffect(() => {
    if (dirty || !failed) return
    resting.current = false
    dropUnsaved(id, slot)
    dismiss()
  }, [dirty, failed, id, slot, dismiss])

  const retry = () => {
    const at = now.current
    queued.current = at.written
    if (at.target) save(at.fields, at.written, at.target)
  }
  const undo = run.undo
    ? () => {
        const back = runStart.current
        void run.undo?.().then(
          (made) => {
            if (made === null || !back) return
            wrote.current = made
            runStart.current = null
            setRan(false)
            queued.current = back
            setFields(back)
            setWritten(back)
          },
          (reason: unknown) => run.failed(reason),
        )
      }
    : null

  // Mod+Z takes the run back while the card shows, outside a text field.
  const undoRef = useRef(undo)
  useEffect(() => {
    undoRef.current = undo
  })
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'z' || event.shiftKey || !(event.metaKey || event.ctrlKey))
        return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable]')) return
      if (!undoRef.current) return
      event.preventDefault()
      undoRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const name = elementName(selection.tag)
  const ancestors = selection.ancestors ?? []
  const path = ancestors.slice(-2)
  const textual = fields.text !== null
  const boxed = !selection.textOnly || BOXED.has(selection.tag)

  let body: React.ReactNode
  if (editable !== 'yes') {
    body = <Notice>{t(editable === 'earlier' ? 'edit.earlier' : 'edit.deleted')}</Notice>
  } else if (heldBy || refused) {
    body = (
      <Notice
        head={
          heldBy ? (
            <>
              {heldBy.agent ? (
                <AgentMark agent={heldBy.agent.id} size={14} hostId={heldBy.agent.hostId} />
              ) : (
                <span aria-hidden className="k-vt-unknown" />
              )}
              <b>
                {heldBy.agent
                  ? t(HELD_TITLE[heldBy.piece], { agent: heldBy.agent.name })
                  : t('edit.heldTitleUnknown')}
              </b>
            </>
          ) : undefined
        }
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={<Icon icon={Comment01Icon} size={14} />}
              onClick={onComment}
            >
              {t('viewer.modes.comment')}
            </Button>
            <Button variant="secondary" size="sm" onClick={onAsk}>
              {t('edit.askShort')}
            </Button>
            {heldBy && (
              <Button variant="ghost" size="sm" onClick={() => onOpenSession(heldBy.sessionId)}>
                {t('ask.openSession')}
              </Button>
            )}
          </>
        }
      >
        {t(heldBy?.piece === 'page' ? 'edit.heldWhole' : 'edit.held')}
      </Notice>
    )
  } else if (source === null) {
    body = (
      <div aria-busy className="k-av-side__wait">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    )
  } else if (!element) {
    body = (
      <Notice
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={<Icon icon={Comment01Icon} size={14} />}
              onClick={onComment}
            >
              {t('viewer.modes.comment')}
            </Button>
            <Button variant="secondary" size="sm" onClick={onAsk}>
              {t('edit.askShort')}
            </Button>
          </>
        }
      >
        {t('edit.scriptedNamed', { name: name.toLowerCase() })}
      </Notice>
    )
  } else {
    const row = (field: keyof Fields, label: string, control: React.ReactNode) => (
      <div className="k-vt-field-row" data-changed={fields[field] !== start[field] || undefined}>
        <span className="k-vt-field-row__label" aria-hidden>
          {label}
        </span>
        <span className="k-vt-field-row__ctl">{control}</span>
      </div>
    )
    body = (
      <div className="k-vt-fields">
        {textual &&
          row(
            'text',
            t('edit.text'),
            <textarea
              value={fields.text ?? ''}
              rows={2}
              maxLength={10_000}
              aria-label={t('edit.text')}
              onChange={(event) => set({ text: event.target.value })}
              className="k-av-text k-vt-field"
            />,
          )}
        {textual && (
          <>
            {row(
              'color',
              t('edit.color'),
              <ColorInput
                label={t('edit.color')}
                value={fields.color}
                onChange={(color) => set({ color })}
              />,
            )}
            {row(
              'size',
              t('edit.size'),
              <PxInput
                label={t('edit.size')}
                value={fields.size}
                invalid={!!fields.size && !cssOf('size', fields.size)}
                onChange={(size) => set({ size })}
                step
              />,
            )}
            {row(
              'weight',
              t('edit.weight'),
              <Select
                label={t('edit.weight')}
                value={fields.weight}
                options={WEIGHTS.map((weight) => ({
                  value: String(weight),
                  label: t('edit.weightValue', {
                    name: t(`edit.weights.${weight}`),
                    weight,
                  }),
                }))}
                onChange={(weight) => set({ weight })}
              />,
            )}
            {row(
              'align',
              t('edit.align'),
              // No option is on while the element's alignment is not one of them.
              <SegmentedControl<string>
                aria-label={t('edit.align')}
                variant="tray"
                size="sm"
                fullWidth
                value={fields.align || 'none'}
                onChange={(align) => set({ align })}
                options={ALIGNS.map(({ value, icon }) => ({
                  value,
                  icon: <Icon icon={icon} size={15} />,
                  ariaLabel: t(`edit.aligns.${value}`),
                }))}
              />,
            )}
          </>
        )}
        {boxed && (
          <>
            {row(
              'background',
              t('edit.background'),
              <ColorInput
                label={t('edit.background')}
                value={fields.background}
                onChange={(background) => set({ background })}
              />,
            )}
            {row(
              'radius',
              t('edit.radius'),
              <PxInput
                label={t('edit.radius')}
                value={fields.radius}
                invalid={!!fields.radius && !cssOf('radius', fields.radius)}
                onChange={(radius) => set({ radius })}
                step
              />,
            )}
            {row(
              'padding',
              t('edit.padding'),
              <PxInput
                label={t('edit.padding')}
                value={fields.padding}
                invalid={!!fields.padding && !cssOf('padding', fields.padding)}
                onChange={(padding) => set({ padding })}
              />,
            )}
          </>
        )}
      </div>
    )
  }

  return (
    <aside aria-label={t('edit.title')} className="k-av-side k-vt-card">
      <SettingsStyles />
      <CardHead
        icon={PencilEdit02Icon}
        title={heldBy ? t(HELD_NAME[heldBy.piece]) : name}
        sub={
          heldBy ? (
            t('edit.heldSub')
          ) : (
            <span className="k-vt-path" aria-label={t('edit.path')}>
              {path.map((tag, i) => (
                <span key={i} className="k-vt-path__step">
                  <button
                    type="button"
                    className="k-vt-path__up"
                    onClick={() => editor.up(path.length - i)}
                  >
                    {elementName(tag)}
                  </button>
                  <Icon icon={ArrowRight01Icon} size={11} />
                </span>
              ))}
              <b className="k-vt-path__tag">{selection.tag}</b>
            </span>
          )
        }
        status={
          <SaveChip
            save={target || run.save?.state === 'undone' ? run.save : null}
            onRetry={retry}
          />
        }
      >
        <UndoButton onUndo={undo} />
      </CardHead>
      <div className="k-vt-body">
        <KeptNote save={run.save} />
        {body}
      </div>
      <div className="k-vt-foot">
        {editable === 'yes' && !heldBy && !refused && element && (
          <button type="button" className="k-vt-askrow" onClick={onAsk}>
            {askLabel}
          </button>
        )}
        {editable === 'yes' && element && !heldBy && (
          <p className="k-vt-foot__note">{t('edit.autosaveShort')}</p>
        )}
      </div>
    </aside>
  )
}

function hasHeld(reason: unknown): boolean {
  const data = (reason as { data?: { held?: unknown[] } } | null)?.data
  return Array.isArray(data?.held) && data.held.length > 0
}

/** A size in pixels, with a step down and up where it is one number. */
function PxInput({
  label,
  value,
  invalid,
  onChange,
  step = false,
}: {
  label: string
  value: string
  invalid: boolean
  onChange: (value: string) => void
  step?: boolean
}) {
  const { t } = useTranslation('artifacts')
  const n = Number(value)
  const nudge = (by: number) => onChange(String(Math.max(0, (Number.isFinite(n) ? n : 0) + by)))
  return (
    <span className="k-vt-num" data-invalid={invalid || undefined}>
      <input
        value={value}
        inputMode="decimal"
        aria-label={label}
        aria-invalid={invalid}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (!step || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
          event.preventDefault()
          nudge((event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 10 : 1))
        }}
      />
      <span aria-hidden className="k-vt-num__unit">
        px
      </span>
      {step && (
        <>
          <button
            type="button"
            aria-label={t('edit.less', { name: label })}
            onClick={() => nudge(-1)}
            className="k-vt-num__step"
          >
            <Icon icon={MinusSignIcon} size={13} />
          </button>
          <button
            type="button"
            aria-label={t('edit.more', { name: label })}
            onClick={() => nudge(1)}
            className="k-vt-num__step"
          >
            <Icon icon={PlusSignIcon} size={13} />
          </button>
        </>
      )}
    </span>
  )
}

export function ColorInput({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  const css = cssOf('color', value)
  return (
    <span className="k-vt-color">
      {/* No color yet: an empty swatch, as the picker itself can only show one. */}
      <span aria-hidden className="k-vt-color__empty" data-shown={css ? undefined : ''} />
      <input
        type="color"
        tabIndex={-1}
        aria-hidden
        value={css ? css.slice(0, 7).toLowerCase() : ''}
        onChange={(event) => onChange(event.target.value.toUpperCase())}
        className={cn('k-vt-color__swatch', !css && 'opacity-0')}
      />
      <input
        value={value}
        spellCheck={false}
        aria-label={label}
        aria-invalid={!!value && !css}
        onChange={(event) => onChange(event.target.value)}
        className="k-vt-color__hex"
      />
    </span>
  )
}

/**
 * Edit's card on a document section or a slide an agent is writing: what it holds, that it is
 * locked until the turn ends while comments stay open, and the way to its session.
 */
export function HeldCard({
  heldBy,
  onOpenSession,
}: {
  heldBy: HeldBy
  onOpenSession: (sessionId: string) => void
}) {
  const { t } = useTranslation('artifacts')
  return (
    <aside aria-label={t('edit.title')} className="k-av-side k-vt-card">
      <CardHead
        icon={PencilEdit02Icon}
        title={t(HELD_NAME[heldBy.piece])}
        sub={t('edit.heldSub')}
      />
      <div className="k-vt-body">
        <Notice
          head={
            <>
              {heldBy.agent ? (
                <AgentMark agent={heldBy.agent.id} size={14} hostId={heldBy.agent.hostId} />
              ) : (
                <span aria-hidden className="k-vt-unknown" />
              )}
              <b>
                {heldBy.agent
                  ? t(HELD_TITLE[heldBy.piece], { agent: heldBy.agent.name })
                  : t('edit.heldTitleUnknown')}
              </b>
            </>
          }
          actions={
            <Button variant="ghost" size="sm" onClick={() => onOpenSession(heldBy.sessionId)}>
              {t('ask.openSession')}
            </Button>
          }
        >
          {t(heldBy.piece === 'page' ? 'edit.heldWhole' : 'edit.held')}
        </Notice>
      </div>
    </aside>
  )
}
