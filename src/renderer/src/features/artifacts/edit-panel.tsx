import { useEffect, useMemo, useState } from 'react'
import { AlignCenterIcon, AlignLeftIcon, AlignRightIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  isEditableValue,
  type EditableProperty,
  type PreviewStyle,
} from '@shared/artifact-runtime/page-messages'
import { decodeText, startTagAt, textContentRange } from '@shared/artifact-source'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Textarea } from '@renderer/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@renderer/components/ui/toggle-group'
import { errorCode, errorMessage, host } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import type { ArtifactEditor, Picked } from './editor'

const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const
const ALIGNS = [
  { value: 'left', Icon: AlignLeftIcon },
  { value: 'center', Icon: AlignCenterIcon },
  { value: 'right', Icon: AlignRightIcon },
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

/**
 * The source of the picked element's file in the version shown, for its text as written and to
 * check that the page's offset names an element there.
 */
function useSource(id: string, version: number, path: string): string | null | 'failed' {
  const [source, setSource] = useState<{ key: string; text: string | 'failed' } | null>(null)
  const key = `${id}:${version}:${path}`
  useEffect(() => {
    let live = true
    host('artifacts.file', { id, version, path }).then(
      ({ bytes }) => {
        if (live) setSource({ key, text: new TextDecoder().decode(bytes) })
      },
      () => {
        if (live) setSource({ key, text: 'failed' })
      },
    )
    return () => {
      live = false
    }
  }, [id, version, path, key])
  return source?.key === key ? source.text : null
}

/**
 * The right column in select mode once an element is picked: its text, when it holds text alone,
 * and its look, previewed in the page as they change and written as a new version on Save.
 */
export function EditPanel({
  id,
  version,
  head,
  editable,
  picked,
  editor,
}: {
  id: string
  /** The version shown, where the element was picked. */
  version: number
  head: number
  /** Why it cannot be edited: an earlier version, or one in Recently deleted. */
  editable: 'yes' | 'earlier' | 'deleted'
  picked: Picked
  editor: ArtifactEditor
}) {
  const { t } = useTranslation('artifacts')
  const { selection } = picked
  const source = useSource(id, version, selection.path)
  const tag =
    source && source !== 'failed' && selection.src !== null
      ? startTagAt(source, selection.src)
      : null
  const element = tag && tag.name === selection.tag ? tag : null

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
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // A new pick starts the fields over.
  const [shownStart, setShownStart] = useState(start)
  if (shownStart !== start) {
    setShownStart(start)
    setFields(start)
    setNotice(null)
  }
  const diff = changes(start, fields)
  const changed = Object.keys(diff.style).length > 0 || diff.text !== null

  useEffect(() => {
    if (changed) editor.preview(diff.style, diff.text)
    else editor.resetPreview()
    // The preview follows the fields' values, not each new object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, JSON.stringify(diff), changed])

  const set = (patch: Partial<Fields>) => setFields((now) => ({ ...now, ...patch }))

  const save = () => {
    if (!changed || busy || !element) return
    setBusy(true)
    host('artifacts.editElement', {
      id,
      baseVersion: head,
      path: selection.path,
      offset: element.start,
      style: Object.keys(diff.style).length > 0 ? diff.style : null,
      text: diff.text,
    })
      .then(
        () => editor.clearPick(),
        (reason: unknown) => {
          if (errorCode(reason) === 'conflict') {
            setNotice(t('edit.conflict'))
            editor.clearPick()
          } else setNotice(errorMessage(reason))
        },
      )
      .finally(() => setBusy(false))
  }

  let body: React.ReactNode
  if (editable !== 'yes') {
    body = <Note>{t(editable === 'earlier' ? 'edit.earlier' : 'edit.deleted')}</Note>
  } else if (source === null) {
    body = (
      <div aria-busy className="flex flex-col gap-3">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    )
  } else if (!element) {
    body = <Note>{t('edit.scripted')}</Note>
  } else {
    body = (
      <>
        <Note>{t('edit.previewing')}</Note>
        {fields.text !== null && (
          <Field label={t('edit.text')}>
            <Textarea
              value={fields.text}
              rows={1}
              maxLength={10_000}
              onChange={(event) => set({ text: event.target.value })}
              className="min-h-9 resize-none"
            />
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('edit.color')}>
            <ColorInput value={fields.color} onChange={(color) => set({ color })} />
          </Field>
          <Field label={t('edit.background')}>
            <ColorInput value={fields.background} onChange={(background) => set({ background })} />
          </Field>
          <Field label={t('edit.size')}>
            <PxInput
              value={fields.size}
              invalid={!!fields.size && !cssOf('size', fields.size)}
              onChange={(size) => set({ size })}
            />
          </Field>
          <Field label={t('edit.weight')}>
            <Select
              value={fields.weight || null}
              items={WEIGHTS.map((weight) => ({
                value: String(weight),
                label: t(`edit.weights.${weight}`),
              }))}
              onValueChange={(next) => {
                if (typeof next === 'string') set({ weight: next })
              }}
            >
              <SelectTrigger
                aria-label={t('edit.weight')}
                className="h-8 w-full gap-2 rounded-lg pr-2 pl-2.5 text-control"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {WEIGHTS.map((weight) => (
                    <SelectItem key={weight} value={String(weight)}>
                      {t(`edit.weights.${weight}`)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Field label={t('edit.align')}>
          <ToggleGroup
            value={fields.align ? [fields.align] : []}
            onValueChange={(next: unknown[]) => {
              const value = next[0]
              if (typeof value === 'string') set({ align: value })
            }}
            variant="outline"
            size="sm"
            className="self-start"
          >
            {ALIGNS.map(({ value, Icon }) => (
              <ToggleGroupItem key={value} value={value} aria-label={t(`edit.aligns.${value}`)}>
                <Icon />
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('edit.padding')}>
            <PxInput
              value={fields.padding}
              invalid={!!fields.padding && !cssOf('padding', fields.padding)}
              onChange={(padding) => set({ padding })}
            />
          </Field>
          <Field label={t('edit.radius')}>
            <PxInput
              value={fields.radius}
              invalid={!!fields.radius && !cssOf('radius', fields.radius)}
              onChange={(radius) => set({ radius })}
            />
          </Field>
        </div>
      </>
    )
  }

  return (
    <aside
      aria-label={t('edit.title')}
      className="flex w-70 shrink-0 animate-in flex-col bg-app shadow-[inset_1px_0_0_var(--border-subtle)] fade-in duration-(--duration-fast)"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 px-4">
        <h2 className="flex-1 text-lede font-semibold">{t('edit.title')}</h2>
        <code className="truncate font-mono text-xs text-tertiary">{selection.tag}</code>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-4 pb-4">
        {body}
        {notice && (
          <p role="alert" className="text-xs text-danger">
            {notice}
          </p>
        )}
      </div>
      {element && editable === 'yes' && (
        <div className="flex shrink-0 justify-end gap-2 px-4 py-3 shadow-[inset_0_var(--hairline)_0_var(--border-subtle)]">
          <Button
            variant="quiet"
            size="sm"
            disabled={!changed || busy}
            onClick={() => {
              setFields(start)
              editor.resetPreview()
            }}
          >
            {t('edit.discard')}
          </Button>
          <Button size="sm" disabled={!changed || busy} onClick={save}>
            {t('edit.save', { version: head + 1 })}
          </Button>
        </div>
      )}
    </aside>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl bg-subtle px-3 py-2.5 text-small text-secondary">{children}</p>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // A label around its control names it, as the field rows elsewhere do.
    <label className="flex min-w-0 flex-col gap-1.5 text-small text-secondary">
      {label}
      {children}
    </label>
  )
}

function PxInput({
  value,
  invalid,
  onChange,
}: {
  value: string
  invalid: boolean
  onChange: (value: string) => void
}) {
  return (
    <span className="relative flex">
      <Input
        value={value}
        inputMode="decimal"
        aria-invalid={invalid}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 pr-8 text-control tabular-nums"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-tertiary"
      >
        px
      </span>
    </span>
  )
}

function ColorInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const css = cssOf('color', value)
  return (
    <span className="relative flex">
      <input
        type="color"
        tabIndex={-1}
        aria-hidden
        value={css ? css.slice(0, 7).toLowerCase() : ''}
        onChange={(event) => onChange(event.target.value.toUpperCase())}
        className={cn(
          'absolute top-1/2 left-2 size-4.5 -translate-y-1/2 cursor-pointer rounded-sm border-0 bg-transparent p-0',
          '[&::-webkit-color-swatch]:rounded-sm [&::-webkit-color-swatch]:border-(--border-default) [&::-webkit-color-swatch-wrapper]:p-0',
        )}
      />
      <Input
        value={value}
        spellCheck={false}
        aria-invalid={!!value && !css}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 pl-8.5 font-mono text-control uppercase"
      />
    </span>
  )
}
