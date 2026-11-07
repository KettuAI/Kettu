import { useEffect, useMemo, useRef, useState } from 'react'
import {
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
import { SegmentedControl } from '@renderer/components/affect/segmented-control'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { toast } from '@renderer/components/ui/toast'
import { Select, SettingsStyles } from '@renderer/features/routines/kit'
import { errorCode, errorMessage, host } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import type { ArtifactEditor, Picked } from './editor'

const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const
/** How long the fields rest before what changed is written. */
const AUTOSAVE_MS = 800
const ALIGNS = [
  { value: 'left', icon: TextAlignLeftIcon },
  { value: 'center', icon: TextAlignCenterIcon },
  { value: 'right', icon: TextAlignRightIcon },
] as const

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

/**
 * The right column in select mode once an element is picked: its text, when it holds text alone,
 * and its look, previewed in the page as they change and written as a new version once they rest.
 */
export function EditPanel({
  id,
  version,
  editable,
  picked,
  editor,
}: {
  id: string
  /** The version shown, where the element was picked. */
  version: number
  /** Why it cannot be edited: an earlier version, or one in Recently deleted. */
  editable: 'yes' | 'earlier' | 'deleted'
  picked: Picked
  editor: ArtifactEditor
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
  const [fields, setFields] = useState<Fields>(start)
  // What the latest version holds, as far as this panel knows.
  const [written, setWritten] = useState<Fields>(start)
  const [saving, setSaving] = useState(0)
  const [savedAs, setSavedAs] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // The element's source arrived: untouched fields follow it. Once the panel has written, its
  // fields are what the latest version holds, so the pages its writes make change nothing here.
  const [shownStart, setShownStart] = useState(start)
  if (shownStart !== start) {
    setShownStart(start)
    if (savedAs === null && sameFields(fields, written)) {
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

  const set = (patch: Partial<Fields>) => setFields((now) => ({ ...now, ...patch }))

  const target: Target | null =
    element && loaded && editable === 'yes'
      ? { path: selection.path, offset: element.start, version: loaded.version }
      : null
  const live = useRef(true)
  // The last version this panel wrote: its own writes keep the element where it starts.
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
    if (Object.keys(change.style).length === 0 && change.text === null) return
    setSaving((count) => count + 1)
    writing = writing.then(async () => {
      try {
        const { version } = await host('artifacts.editElement', {
          id,
          // A version anyone else wrote may have moved the element, so it is a conflict.
          baseVersion: Math.max(to.version, wrote.current),
          path: to.path,
          offset: to.offset,
          style: Object.keys(change.style).length > 0 ? change.style : null,
          text: change.text,
        })
        wrote.current = version
        if (!live.current) return
        setWritten(snapshot)
        setSavedAs(version)
        setNotice(null)
      } catch (reason) {
        if (errorCode(reason) === 'conflict') {
          toast(t('edit.conflict'), undefined, { tone: 'warning' })
          if (live.current) editor.clearPick()
        } else if (live.current) setNotice(errorMessage(reason))
        else
          toast(t('edit.failed', { error: errorMessage(reason) }), undefined, { tone: 'warning' })
      } finally {
        if (live.current) setSaving((count) => count - 1)
      }
    })
  }

  const dirty = !sameFields(fields, written)
  const fieldsKey = JSON.stringify(fields)
  useEffect(() => {
    if (!dirty || !target) return
    const timer = setTimeout(() => {
      const at = now.current
      if (at.target) save(at.fields, at.written, at.target)
    }, AUTOSAVE_MS)
    return () => clearTimeout(timer)
    // A change of the fields starts the wait over; `save` reads the latest of them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldsKey, dirty, target?.path, target?.offset])

  // Picking another element or leaving select mode writes what has not been yet.
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      const at = now.current
      if (at.target && !sameFields(at.fields, at.written)) save(at.fields, at.written, at.target)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  let body: React.ReactNode
  if (editable !== 'yes') {
    body = <Note>{t(editable === 'earlier' ? 'edit.earlier' : 'edit.deleted')}</Note>
  } else if (source === null) {
    body = (
      <div aria-busy className="k-av-side__wait">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    )
  } else if (!element) {
    body = <Note>{t('edit.scripted')}</Note>
  } else {
    body = (
      <>
        {fields.text !== null && (
          <div className="ui-sg-card k-av-props">
            <label className="k-av-prop k-av-prop--stack">
              <span className="k-av-prop__name">{t('edit.text')}</span>
              <textarea
                value={fields.text}
                rows={1}
                maxLength={10_000}
                onChange={(event) => set({ text: event.target.value })}
                className="k-av-text k-av-text--grow"
              />
            </label>
          </div>
        )}
        <div className="ui-sg-card k-av-props">
          <Field label={t('edit.color')}>
            <ColorInput
              label={t('edit.color')}
              value={fields.color}
              onChange={(color) => set({ color })}
            />
          </Field>
          <Field label={t('edit.background')}>
            <ColorInput
              label={t('edit.background')}
              value={fields.background}
              onChange={(background) => set({ background })}
            />
          </Field>
          <Field label={t('edit.size')}>
            <PxInput
              label={t('edit.size')}
              value={fields.size}
              invalid={!!fields.size && !cssOf('size', fields.size)}
              onChange={(size) => set({ size })}
            />
          </Field>
          <Field label={t('edit.weight')}>
            <Select
              label={t('edit.weight')}
              value={fields.weight}
              width={CONTROL_WIDTH}
              options={WEIGHTS.map((weight) => ({
                value: String(weight),
                label: t(`edit.weights.${weight}`),
              }))}
              onChange={(weight) => set({ weight })}
            />
          </Field>
          <Field label={t('edit.align')}>
            {/* No option is on while the element's alignment is not one of them. */}
            <SegmentedControl<string>
              aria-label={t('edit.align')}
              variant="tray"
              size="sm"
              value={fields.align || 'none'}
              onChange={(align) => set({ align })}
              options={ALIGNS.map(({ value, icon }) => ({
                value,
                icon: <Icon icon={icon} size={15} />,
                ariaLabel: t(`edit.aligns.${value}`),
              }))}
            />
          </Field>
        </div>
        <div className="ui-sg-card k-av-props">
          <Field label={t('edit.padding')}>
            <PxInput
              label={t('edit.padding')}
              value={fields.padding}
              invalid={!!fields.padding && !cssOf('padding', fields.padding)}
              onChange={(padding) => set({ padding })}
            />
          </Field>
          <Field label={t('edit.radius')}>
            <PxInput
              label={t('edit.radius')}
              value={fields.radius}
              invalid={!!fields.radius && !cssOf('radius', fields.radius)}
              onChange={(radius) => set({ radius })}
            />
          </Field>
        </div>
        <Note>{t('edit.autosave')}</Note>
      </>
    )
  }

  return (
    <aside aria-label={t('edit.title')} className="k-av-side">
      <SettingsStyles />
      <div className="k-av-side__head">
        <h2 className="k-av-side__title">{t('edit.title')}</h2>
        <code className="k-av-side__tag">{selection.tag}</code>
      </div>
      <div className="k-av-side__body">
        {body}
        {notice && (
          <p role="alert" className="k-av-error">
            {notice}
          </p>
        )}
      </div>
      {target && (saving > 0 || savedAs !== null) && (
        <p role="status" className="k-av-side__foot">
          {saving > 0 ? t('edit.saving') : t('edit.saved', { version: savedAs })}
        </p>
      )}
    </aside>
  )
}

/** The width of a property's control, so the names line up in one column. */
const CONTROL_WIDTH = 136

function Note({ children }: { children: React.ReactNode }) {
  return <p className="k-av-note">{children}</p>
}

/** A property's row: its name, then its control, which carries the name for assistive tech. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="k-av-prop">
      <span aria-hidden className="k-av-prop__name">
        {label}
      </span>
      {children}
    </div>
  )
}

function PxInput({
  label,
  value,
  invalid,
  onChange,
}: {
  label: string
  value: string
  invalid: boolean
  onChange: (value: string) => void
}) {
  return (
    <span className="k-av-px" style={{ width: CONTROL_WIDTH }}>
      <input
        value={value}
        inputMode="decimal"
        aria-label={label}
        aria-invalid={invalid}
        onChange={(event) => onChange(event.target.value)}
        className="ui-sg-input k-av-input"
      />
      <span aria-hidden>px</span>
    </span>
  )
}

function ColorInput({
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
    <span className="k-av-color" style={{ width: CONTROL_WIDTH }}>
      {/* No color yet: an empty swatch, as the picker itself can only show one. */}
      <span aria-hidden className="k-av-color__empty" data-shown={css ? undefined : ''} />
      <input
        type="color"
        tabIndex={-1}
        aria-hidden
        value={css ? css.slice(0, 7).toLowerCase() : ''}
        onChange={(event) => onChange(event.target.value.toUpperCase())}
        className={cn('k-av-color__swatch', !css && 'opacity-0')}
      />
      <input
        value={value}
        spellCheck={false}
        aria-label={label}
        aria-invalid={!!value && !css}
        onChange={(event) => onChange(event.target.value)}
        className="ui-sg-input k-av-input k-av-input--hex"
      />
    </span>
  )
}
