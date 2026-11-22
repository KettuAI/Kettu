import { useEffect, useRef, useState } from 'react'
import {
  Copy01Icon,
  Delete02Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  PlusSignIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { paramsRange, parseParams, type PageParam, type ParamValue } from '@shared/artifact-params'
import { canvasId, type CanvasDoc, type CanvasOp, type CanvasPage } from '@shared/canvas-doc'
import { Dropdown } from '@renderer/components/affect/app-shell'
import { Switch } from '@renderer/components/ui/switch'
import { errorCode, host } from '@renderer/lib/host'
import { toast } from '@renderer/components/ui/toast'
import { FRAME_ICON, NOTE_ICONS } from './canvas-tools'
import { ViewerSlot } from './viewer-shell'
import type { DocLayout } from './canvas-model'
import type { EditorFrame } from './editor'

/** A tweak is written once the user stops changing it this long. */
const PARAMS_SAVE_MS = 1000

/** A row of the left card: its icon and name, renamed in place by a double click where it can be. */
function NavRow({
  icon,
  name,
  meta,
  selected,
  renaming,
  onRename,
  onRenamed,
  onClick,
}: {
  icon: IconSvgElement
  name: string
  meta?: string
  selected: boolean
  renaming: boolean
  onRename: (() => void) | null
  onRenamed: (name: string | null) => void
  onClick: (event: React.MouseEvent) => void
}) {
  return (
    <div role="treeitem" aria-selected={selected} className="k-ce-row">
      <HugeiconsIcon icon={icon} size={14} strokeWidth={1.9} className="k-ce-row__icon" />
      {renaming ? (
        <input
          autoFocus
          defaultValue={name}
          className="k-ce-row__name rounded bg-surface px-1 outline-none"
          onBlur={(event) => {
            const value = event.target.value.trim()
            onRenamed(value && value !== name ? value : null)
          }}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Enter' || event.key === 'Escape')
              (event.target as HTMLInputElement).blur()
          }}
        />
      ) : (
        <button
          type="button"
          className="k-ce-row__name text-start"
          onClick={onClick}
          onDoubleClick={onRename ?? undefined}
        >
          {name}
        </button>
      )}
      {meta && <span className="k-ce-row__meta">{meta}</span>}
    </div>
  )
}

/**
 * The left card of a canvas: its pages, to switch between and manage, then what the page on screen
 * holds, to find, select and rename.
 */
export function CanvasNavigator({
  doc,
  canvasKey,
  onCanvas,
  layout,
  selection,
  onSelect,
  apply,
  readOnly,
}: {
  doc: CanvasDoc
  canvasKey: string
  onCanvas: (id: string) => void
  layout: DocLayout
  selection: readonly string[]
  onSelect: (ids: string[], reveal: boolean) => void
  apply: (ops: CanvasOp[]) => void
  readOnly: boolean
}) {
  const { t } = useTranslation('artifacts')
  const [renaming, setRenaming] = useState<string | null>(null)
  const current = doc.canvases.find((c) => c.id === canvasKey)
  const pagesOn = (id: string) => doc.pages.filter((p) => p.canvas === id).length
  const renamed = (id: string) => (name: string | null) => {
    if (name) apply([{ op: 'set', id, key: 'name', value: name }])
    setRenaming(null)
  }
  const pick = (id: string) => (event: React.MouseEvent) =>
    onSelect(event.shiftKey ? [...selection.filter((s) => s !== id), id] : [id], true)
  const addCanvas = (copyOf: string | null) => {
    const id = canvasId('c')
    const ops: CanvasOp[] = [
      {
        op: 'add',
        object: {
          type: 'canvas',
          id,
          name: copyOf
            ? `${current?.name ?? ''} 2`
            : t('board.canvases.newName', { number: doc.canvases.length + 1 }),
        },
      },
    ]
    if (copyOf) {
      for (const p of doc.pages.filter((x) => x.canvas === copyOf)) {
        ops.push({ op: 'add', object: { type: 'page', ...p, id: canvasId('p'), canvas: id } })
      }
    }
    apply(ops)
    onCanvas(id)
  }
  return (
    <div className="k-ce-nav">
      {!readOnly && (
        <ViewerSlot slot="leftHead">
          <Dropdown
            align="end"
            items={[
              {
                label: t('board.canvases.new'),
                icon: PlusSignIcon,
                onSelect: () => addCanvas(null),
              },
              {
                label: t('board.canvases.rename'),
                icon: PencilEdit02Icon,
                onSelect: () => setRenaming(canvasKey),
              },
              {
                label: t('board.canvases.duplicate'),
                icon: Copy01Icon,
                onSelect: () => addCanvas(canvasKey),
              },
              {
                label: t('board.canvases.delete'),
                icon: Delete02Icon,
                danger: true,
                // The last page stays: a canvas artifact keeps at least one.
                disabled: doc.canvases.length < 2,
                onSelect: () => {
                  const next = doc.canvases.find((c) => c.id !== canvasKey)
                  apply([{ op: 'remove', id: canvasKey }])
                  if (next) onCanvas(next.id)
                },
              },
            ]}
            trigger={({ open, toggle }) => (
              <button
                type="button"
                aria-label={t('board.canvases.actions')}
                title={t('board.canvases.actions')}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={toggle}
                className="k-ce-tool"
              >
                <HugeiconsIcon icon={MoreHorizontalIcon} size={14} strokeWidth={1.9} />
              </button>
            )}
          />
        </ViewerSlot>
      )}
      <div role="tree" aria-label={t('board.canvases.menu')}>
        {doc.canvases.map((c) => (
          <NavRow
            key={c.id}
            icon={NOTE_ICONS.canvas}
            name={c.name}
            meta={String(pagesOn(c.id))}
            selected={c.id === canvasKey}
            renaming={renaming === c.id}
            onRename={readOnly ? null : () => setRenaming(c.id)}
            onRenamed={renamed(c.id)}
            onClick={() => onCanvas(c.id)}
          />
        ))}
      </div>
      <div className="k-ce-nav__head">
        <span>{t('board.layers.title')}</span>
      </div>
      <div role="tree" aria-label={t('board.layers.title')}>
        {layout.pages.map((p) => (
          <NavRow
            key={p.id}
            icon={FRAME_ICON}
            name={p.name}
            selected={selection.includes(p.id)}
            renaming={renaming === p.id}
            onRename={readOnly ? null : () => setRenaming(p.id)}
            onRenamed={renamed(p.id)}
            onClick={pick(p.id)}
          />
        ))}
        {layout.notes.map((n) => (
          <NavRow
            key={n.id}
            icon={NOTE_ICONS[n.kind]}
            name={
              n.kind === 'text' || n.kind === 'sticky'
                ? n.text || t(`board.layers.notes.${n.kind}`)
                : t(`board.layers.notes.${n.kind}`)
            }
            selected={selection.includes(n.id)}
            renaming={false}
            onRename={null}
            onRenamed={() => {}}
            onClick={pick(n.id)}
          />
        ))}
        {layout.pages.length === 0 && layout.notes.length === 0 && (
          <p className="k-ce-nav__empty">{t('board.layers.empty')}</p>
        )}
      </div>
    </div>
  )
}

/** The parameters a page declares, with controls that preview at once and write a moment later. */
function PageParams({
  artifactId,
  version,
  page,
  frame,
  selected,
  onSelect,
}: {
  artifactId: string
  version: number
  page: CanvasPage
  frame: EditorFrame | null
  /** The frame is the one selected, which its group shows. */
  selected: boolean
  onSelect: () => void
}) {
  const { t } = useTranslation('artifacts')
  const [params, setParams] = useState<PageParam[] | null>(null)
  const [values, setValues] = useState<Record<string, ParamValue>>({})
  const [saving, setSaving] = useState<'idle' | 'saving' | number>('idle')
  const pending = useRef<Record<string, ParamValue>>({})
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    let live = true
    host('artifacts.file', { id: artifactId, version, path: page.file }).then(
      ({ bytes }) => {
        if (!live) return
        const html = new TextDecoder().decode(bytes)
        const range = paramsRange(html)
        const found = range ? parseParams(html.slice(range.start, range.end)) : []
        setParams(found)
        setValues(Object.fromEntries(found.map((p) => [p.name, p.value])))
      },
      () => {
        if (live) setParams([])
      },
    )
    return () => {
      live = false
    }
  }, [artifactId, version, page.file])

  useEffect(() => () => clearTimeout(timer.current), [])

  if (!params || params.length === 0) return null

  const change = (name: string, value: ParamValue) => {
    setValues((v) => ({ ...v, [name]: value }))
    frame?.params({ [name]: value })
    pending.current = { ...pending.current, [name]: value }
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const send = pending.current
      pending.current = {}
      setSaving('saving')
      host('artifacts.setParams', {
        id: artifactId,
        baseVersion: version,
        path: page.file,
        values: send,
      }).then(
        ({ version: written }) => setSaving(written),
        (reason: unknown) => {
          setSaving('idle')
          toast(t('board.props.paramsFailed', { error: errorCode(reason) ?? '' }), undefined, {
            tone: 'warning',
          })
        },
      )
    }, PARAMS_SAVE_MS)
  }

  return (
    <>
      <div className="k-ce-psec" data-selected={selected ? '' : undefined}>
        <h5>
          <button type="button" className="k-ce-psec__frame" onClick={onSelect}>
            <HugeiconsIcon icon={FRAME_ICON} size={13} strokeWidth={1.9} />
            <span className="truncate">{page.name}</span>
          </button>
        </h5>
        {params.map((p) => (
          <div key={p.name} className="k-ce-prow">
            <span className="truncate">{p.label}</span>
            {p.type === 'color' && (
              <input
                type="color"
                aria-label={p.label}
                value={String(values[p.name])}
                onChange={(event) => change(p.name, event.target.value)}
                className="size-6 cursor-pointer rounded-md border-0 bg-transparent"
              />
            )}
            {p.type === 'boolean' && (
              <Switch
                checked={Boolean(values[p.name])}
                onCheckedChange={(on) => change(p.name, on)}
                aria-label={p.label}
              />
            )}
            {p.type === 'number' && (
              <input
                type="range"
                aria-label={p.label}
                min={p.min}
                max={p.max}
                step={p.step}
                value={Number(values[p.name])}
                onChange={(event) => change(p.name, Number(event.target.value))}
                className="w-28 accent-(--control-on)"
              />
            )}
            {p.type === 'choice' && (
              <label className="k-ce-field w-32">
                <select
                  value={String(values[p.name])}
                  onChange={(event) => change(p.name, event.target.value)}
                >
                  {p.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {p.type === 'text' && (
              <label className="k-ce-field w-32">
                <input
                  value={String(values[p.name])}
                  onChange={(event) => change(p.name, event.target.value)}
                />
              </label>
            )}
          </div>
        ))}
      </div>
      {saving !== 'idle' && (
        <div className="k-ce-savebar">
          {typeof saving === 'number' && (
            <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={1.9} className="text-success" />
          )}
          {saving === 'saving'
            ? t('board.props.saving')
            : t('board.props.saved', { version: saving })}
        </div>
      )}
    </>
  )
}

/**
 * The Tweaks tab: the parameters each frame of the page declares, to change them live; the
 * selected frame's group is marked, and a frame's name selects it.
 */
export function CanvasTweaks({
  layout,
  params,
  selection,
  onSelect,
  editorFrame,
  artifactId,
  version,
}: {
  layout: DocLayout
  params: ReadonlyMap<string, PageParam[]>
  selection: readonly string[]
  onSelect: (id: string) => void
  editorFrame: (page: string) => EditorFrame | null
  artifactId: string
  version: number
}) {
  const { t } = useTranslation('artifacts')
  const frames = layout.pages.filter((p) => params.has(p.id))
  if (frames.length === 0) {
    return (
      <div className="k-ce-side__empty">
        <p>{t('board.tweaks.empty')}</p>
        <p>{t('board.tweaks.hint')}</p>
      </div>
    )
  }
  return (
    <>
      {frames.map((page) => (
        <PageParams
          key={page.id}
          artifactId={artifactId}
          version={version}
          page={page}
          frame={editorFrame(page.id)}
          selected={selection.includes(page.id)}
          onSelect={() => onSelect(page.id)}
        />
      ))}
    </>
  )
}
