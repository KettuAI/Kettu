import { useEffect, useRef, useState } from 'react'
import {
  AlignBottomIcon,
  AlignHorizontalCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  AlignTopIcon,
  AlignVerticalCenterIcon,
  ArrowDown01Icon,
  Cancel01Icon,
  Copy01Icon,
  Delete02Icon,
  DistributeHorizontalCenterIcon,
  DistributeVerticalCenterIcon,
  PencilEdit02Icon,
  PlusSignIcon,
  SquareLock01Icon,
  SquareUnlock01Icon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { paramsRange, parseParams, type PageParam, type ParamValue } from '@shared/artifact-params'
import {
  canvasId,
  NOTE_COLORS,
  type Box,
  type CanvasDoc,
  type CanvasOp,
  type CanvasPage,
  type NoteColor,
} from '@shared/canvas-doc'
import { Dropdown } from '@renderer/components/affect/app-shell'
import { Switch } from '@renderer/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { errorCode, host } from '@renderer/lib/host'
import { toast } from '@renderer/components/ui/toast'
import { cn } from '@renderer/lib/utils'
import {
  LAYERS_ICON,
  MARKER_ICON,
  NOTE_COLOR_VAR,
  SHAPE_ICONS,
  TOOL_ICONS,
  type PenStyle,
  type ShapeKind,
  type Tool,
} from './canvas-tools'
import type { DocLayout } from './canvas-model'
import type { EditorFrame } from './editor'

const SIZES = {
  desktop: { width: 1440, height: 900 },
  laptop: { width: 1280, height: 800 },
  tablet: { width: 834, height: 1194 },
  phone: { width: 390, height: 844 },
} as const
const WIDTHS = [2, 3, 6] as const
/** A tweak is written once the user stops changing it this long. */
const PARAMS_SAVE_MS = 1000

function ToolButton({
  label,
  shortcut,
  icon,
  pressed,
  toggle,
  onClick,
  children,
}: {
  label: string
  shortcut?: string
  icon: IconSvgElement
  pressed?: boolean
  /** A panel's switch rather than a tool, shown on in a quieter way. */
  toggle?: boolean
  onClick: () => void
  children?: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={pressed}
            className={cn('k-ce-tool', toggle && 'k-ce-tool--toggle')}
            onClick={onClick}
          />
        }
      >
        <HugeiconsIcon icon={icon} size={16} strokeWidth={1.9} />
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && <span className="ml-2 opacity-60">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  )
}

/** The floating toolbar: the canvases of the artifact, then the tools. */
export function CanvasToolbar({
  doc,
  canvasKey,
  onCanvas,
  apply,
  tool,
  onTool,
  shape,
  onShape,
  pen,
  onPen,
  layersOpen,
  onLayers,
  comment,
}: {
  doc: CanvasDoc | null
  canvasKey: string
  onCanvas: (id: string) => void
  apply: (ops: CanvasOp[]) => void
  tool: Tool
  onTool: (tool: Tool) => void
  shape: ShapeKind
  onShape: (shape: ShapeKind) => void
  pen: PenStyle
  onPen: (pen: PenStyle) => void
  layersOpen: boolean
  onLayers: () => void
  comment: boolean
}) {
  const { t } = useTranslation('artifacts')
  const [renaming, setRenaming] = useState(false)
  const current = doc?.canvases.find((c) => c.id === canvasKey)
  const pagesOn = (id: string) => doc?.pages.filter((p) => p.canvas === id).length ?? 0
  const tools: Array<[Tool, string]> = [
    ['move', 'V'],
    ['hand', 'H'],
    ['page', 'F'],
    ['section', ''],
    ['text', 'T'],
    ['sticky', 'S'],
    ['pen', 'P'],
    ['shape', 'R'],
    ...(comment ? ([['comment', 'C']] as Array<[Tool, string]>) : []),
  ]
  const addCanvas = (copyOf: string | null) => {
    if (!doc) return
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
      const sections = new Map<string, string>()
      for (const s of doc.sections.filter((x) => x.canvas === copyOf)) {
        const sid = canvasId('s')
        sections.set(s.id, sid)
        ops.push({ op: 'add', object: { type: 'section', ...s, id: sid, canvas: id } })
      }
      for (const p of doc.pages.filter((x) => x.canvas === copyOf)) {
        ops.push({
          op: 'add',
          object: {
            type: 'page',
            ...p,
            id: canvasId('p'),
            canvas: id,
            section: p.section ? (sections.get(p.section) ?? null) : null,
          },
        })
      }
    }
    apply(ops)
    onCanvas(id)
  }
  return (
    <>
      <div className="k-ce-tools k-ce-float" role="toolbar" aria-label={t('board.tools.toolbar')}>
        {renaming && current ? (
          <input
            autoFocus
            defaultValue={current.name}
            aria-label={t('board.canvases.rename')}
            className="k-ce-tool k-ce-tool__canvas w-32 bg-subtle outline-none"
            onBlur={(event) => {
              const name = event.target.value.trim()
              if (name && name !== current.name)
                apply([{ op: 'set', id: current.id, key: 'name', value: name }])
              setRenaming(false)
            }}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Enter' || event.key === 'Escape')
                (event.target as HTMLInputElement).blur()
            }}
          />
        ) : (
          <Dropdown
            className="k-ce-canvas-menu"
            title={t('board.canvases.menu')}
            items={[
              ...(doc?.canvases ?? []).map((c) => ({
                label: c.name,
                // The count sits at the row's end, where the menu draws a shortcut.
                shortcut: t('board.canvases.pages', { count: pagesOn(c.id) }),
                checked: c.id === canvasKey,
                onSelect: () => onCanvas(c.id),
              })),
              {
                label: t('board.canvases.new'),
                icon: PlusSignIcon,
                divider: true,
                onSelect: () => addCanvas(null),
              },
              {
                label: t('board.canvases.rename'),
                icon: PencilEdit02Icon,
                onSelect: () => setRenaming(true),
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
                // The last canvas stays: a canvas artifact keeps at least one.
                disabled: (doc?.canvases.length ?? 0) < 2,
                onSelect: () => {
                  const next = doc!.canvases.find((c) => c.id !== canvasKey)
                  apply([{ op: 'remove', id: canvasKey }])
                  if (next) onCanvas(next.id)
                },
              },
            ]}
            trigger={({ open, toggle }) => (
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={toggle}
                className="k-ce-tool k-ce-tool__canvas"
              >
                {current?.name ?? ''}
                <HugeiconsIcon icon={ArrowDown01Icon} size={12} strokeWidth={1.9} />
              </button>
            )}
          />
        )}
        <span className="k-ce-tools__sep" />
        {tools.map(([name, key]) => (
          <ToolButton
            key={name}
            label={t(`board.tools.${name}`)}
            shortcut={key}
            icon={
              name === 'shape'
                ? SHAPE_ICONS[shape]
                : name === 'pen' && pen.marker
                  ? MARKER_ICON
                  : TOOL_ICONS[name]
            }
            pressed={tool === name}
            onClick={() => onTool(name)}
          />
        ))}
        <span className="k-ce-tools__sep" />
        <ToolButton
          label={t('board.layers.open')}
          icon={LAYERS_ICON}
          pressed={layersOpen}
          toggle
          onClick={onLayers}
        />
      </div>
      {(tool === 'pen' || tool === 'shape') && (
        <div
          className="k-ce-panel k-ce-float"
          style={{ top: 58, left: 12, width: 248, padding: 10 }}
        >
          {tool === 'pen' ? (
            <div className="mb-2.5 flex gap-1">
              {[false, true].map((marker) => (
                <button
                  key={String(marker)}
                  type="button"
                  aria-pressed={pen.marker === marker}
                  className={cn('k-ce-tool flex-1 gap-1.5', pen.marker === marker && 'bg-selected')}
                  onClick={() => onPen({ ...pen, marker })}
                >
                  <HugeiconsIcon
                    icon={marker ? MARKER_ICON : TOOL_ICONS.pen}
                    size={14}
                    strokeWidth={1.9}
                  />
                  <span className="text-ui">
                    {t(marker ? 'board.tools.marker' : 'board.tools.pen')}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="mb-2.5 flex gap-1">
              {(['rect', 'ellipse', 'line', 'arrow'] as const).map((kind) => (
                <ToolButton
                  key={kind}
                  label={t(`board.tools.${kind}`)}
                  icon={SHAPE_ICONS[kind]}
                  pressed={shape === kind}
                  onClick={() => onShape(kind)}
                />
              ))}
            </div>
          )}
          <ColorRow value={pen.color} onChange={(color) => onPen({ ...pen, color })} />
          <div className="mt-2.5 flex items-center gap-2">
            <span className="text-xs text-tertiary">{t('board.tools.thickness')}</span>
            {WIDTHS.map((w) => (
              <button
                key={w}
                type="button"
                aria-label={`${w}`}
                aria-pressed={pen.width === w}
                className={cn('k-ce-tool flex-1', pen.width === w && 'bg-selected')}
                onClick={() => onPen({ ...pen, width: w })}
              >
                <span className="block w-4 rounded-full bg-current" style={{ height: w }} />
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

function ColorRow({ value, onChange }: { value: NoteColor; onChange: (color: NoteColor) => void }) {
  const { t } = useTranslation('artifacts')
  return (
    <div className="k-ce-swatches" role="radiogroup" aria-label={t('board.props.color')}>
      {NOTE_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          aria-pressed={value === color}
          aria-label={t(`board.tools.colors.${color}`)}
          data-round=""
          className="k-ce-swatch"
          style={{ background: NOTE_COLOR_VAR[color] }}
          onClick={() => onChange(color)}
        />
      ))}
    </div>
  )
}

/** The sections, pages and notes of the canvas, to find, select and rename. */
export function CanvasLayers({
  layout,
  selection,
  onSelect,
  apply,
  onClose,
}: {
  layout: DocLayout
  selection: readonly string[]
  onSelect: (ids: string[], reveal: boolean) => void
  apply: (ops: CanvasOp[]) => void
  onClose: () => void
}) {
  const { t } = useTranslation('artifacts')
  const [renaming, setRenaming] = useState<string | null>(null)
  const row = (id: string, name: string, depth: number, icon: IconSvgElement, meta?: string) => (
    <div
      key={id}
      role="treeitem"
      aria-selected={selection.includes(id)}
      data-depth={depth}
      className="k-ce-row"
    >
      <HugeiconsIcon icon={icon} size={14} strokeWidth={1.9} className="k-ce-row__icon" />
      {renaming === id ? (
        <input
          autoFocus
          defaultValue={name}
          className="k-ce-row__name rounded bg-surface px-1 outline-none"
          onBlur={(event) => {
            const value = event.target.value.trim()
            const key = layout.sections.some((s) => s.id === id) ? 'title' : 'name'
            if (value && value !== name) apply([{ op: 'set', id, key, value }])
            setRenaming(null)
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
          onClick={(event) =>
            onSelect(event.shiftKey ? [...selection.filter((s) => s !== id), id] : [id], true)
          }
          onDoubleClick={() => setRenaming(id)}
        >
          {name}
        </button>
      )}
      {meta && <span className="k-ce-row__meta">{meta}</span>}
    </div>
  )
  const loose = layout.pages.filter(
    (p) => !p.section || !layout.sections.some((s) => s.id === p.section),
  )
  return (
    <div
      className="k-ce-panel k-ce-layers k-ce-float"
      role="tree"
      aria-label={t('board.layers.title')}
    >
      <div className="k-ce-panel__head">
        {t('board.layers.title')}
        <button
          type="button"
          aria-label={t('board.layers.close')}
          className="k-ce-tool"
          onClick={onClose}
        >
          <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.9} />
        </button>
      </div>
      {layout.sections.map((s) => {
        const inside = layout.pages.filter((p) => p.section === s.id)
        return (
          <div key={s.id} role="group">
            {row(
              s.id,
              s.title,
              0,
              TOOL_ICONS.section,
              t('board.section.pages', { count: inside.length }),
            )}
            {inside.map((p) => row(p.id, p.name, 1, TOOL_ICONS.page))}
          </div>
        )
      })}
      {loose.map((p) => row(p.id, p.name, 0, TOOL_ICONS.page))}
      {layout.notes.map((n) =>
        row(
          n.id,
          n.kind === 'text' || n.kind === 'sticky'
            ? n.text || t(`board.layers.notes.${n.kind}`)
            : t(`board.layers.notes.${n.kind}`),
          0,
          n.kind === 'text' || n.kind === 'sticky' || n.kind === 'pen'
            ? TOOL_ICONS[n.kind]
            : SHAPE_ICONS[n.kind],
        ),
      )}
    </div>
  )
}

function NumberField({
  label,
  value,
  onCommit,
}: {
  label: string
  value: number
  onCommit: (n: number) => void
}) {
  const [text, setText] = useState(String(value))
  const [was, setWas] = useState(value)
  if (was !== value) {
    setWas(value)
    setText(String(value))
  }
  return (
    <label className="k-ce-field">
      <span>{label}</span>
      <input
        inputMode="numeric"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          const n = Number(text)
          if (Number.isFinite(n) && n !== value) onCommit(n)
          else setText(String(value))
        }}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
        }}
      />
    </label>
  )
}

function TextField({
  label,
  value,
  onCommit,
}: {
  label: string
  value: string
  onCommit: (v: string) => void
}) {
  const [text, setText] = useState(value)
  const [was, setWas] = useState(value)
  if (was !== value) {
    setWas(value)
    setText(value)
  }
  return (
    <label className="k-ce-field">
      <span>{label}</span>
      <input
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          const v = text.trim()
          if (v && v !== value) onCommit(v)
          else setText(value)
        }}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
        }}
      />
    </label>
  )
}

/** The parameters a page declares, with controls that preview at once and write a moment later. */
function PageParams({
  artifactId,
  version,
  page,
  frame,
}: {
  artifactId: string
  version: number
  page: CanvasPage
  frame: EditorFrame | null
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
      <div className="k-ce-psec">
        <h5>
          {t('board.props.params')}
          <span>{t('board.props.paramsHint')}</span>
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

/** What the selection is and how to change it. */
export function CanvasProps({
  layout,
  selection,
  apply,
  remove,
  duplicate,
  editorFrame,
  artifactId,
  version,
}: {
  layout: DocLayout
  selection: readonly string[]
  apply: (ops: CanvasOp[]) => void
  remove: () => void
  duplicate: () => void
  editorFrame: (page: string) => EditorFrame | null
  artifactId: string
  version: number
}) {
  const { t } = useTranslation('artifacts')
  const one = selection.length === 1 ? selection[0]! : null
  const page = one ? layout.pages.find((p) => p.id === one) : undefined
  const section = one ? layout.sections.find((s) => s.id === one) : undefined
  const note = one ? layout.notes.find((n) => n.id === one) : undefined
  const set = (id: string, key: string, value: unknown) => apply([{ op: 'set', id, key, value }])

  const boxes = selection
    .map((id) => layout.pages.find((p) => p.id === id) ?? null)
    .filter((p): p is CanvasPage => p !== null)
  const align = (how: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') => {
    if (boxes.length < 2) return
    const left = Math.min(...boxes.map((b) => b.x))
    const right = Math.max(...boxes.map((b) => b.x + b.width))
    const top = Math.min(...boxes.map((b) => b.y))
    const bottom = Math.max(...boxes.map((b) => b.y + b.height))
    apply(
      boxes.map((b): CanvasOp => {
        switch (how) {
          case 'left':
            return { op: 'set', id: b.id, key: 'x', value: left }
          case 'center':
            return {
              op: 'set',
              id: b.id,
              key: 'x',
              value: Math.round((left + right) / 2 - b.width / 2),
            }
          case 'right':
            return { op: 'set', id: b.id, key: 'x', value: right - b.width }
          case 'top':
            return { op: 'set', id: b.id, key: 'y', value: top }
          case 'middle':
            return {
              op: 'set',
              id: b.id,
              key: 'y',
              value: Math.round((top + bottom) / 2 - b.height / 2),
            }
          default:
            return { op: 'set', id: b.id, key: 'y', value: bottom - b.height }
        }
      }),
    )
  }
  const distribute = (axis: 'x' | 'y') => {
    if (boxes.length < 3) return
    const size = (b: Box) => (axis === 'x' ? b.width : b.height)
    const start = (b: Box) => (axis === 'x' ? b.x : b.y)
    const sorted = [...boxes].sort((a, b) => start(a) - start(b))
    const first = sorted[0]!
    const last = sorted.at(-1)!
    const space = start(last) + size(last) - start(first) - sorted.reduce((s, b) => s + size(b), 0)
    const gap = space / (sorted.length - 1)
    let at = start(first)
    apply(
      sorted.map((b): CanvasOp => {
        const op: CanvasOp = { op: 'set', id: b.id, key: axis, value: Math.round(at) }
        at += size(b) + gap
        return op
      }),
    )
  }
  const locked = page?.locked ?? note?.locked ?? false

  return (
    <div className="k-ce-panel k-ce-props k-ce-float" aria-label={t('board.props.title')}>
      {page && (
        <div className="k-ce-psec">
          <h5>
            {t('board.props.page')}
            <span className="truncate">{page.name}</span>
          </h5>
          <div className="flex flex-col gap-2">
            <TextField
              label={t('board.props.name')}
              value={page.name}
              onCommit={(v) => set(page.id, 'name', v)}
            />
            <label className="k-ce-field">
              <span>{t('board.props.size')}</span>
              <select
                value={
                  (Object.keys(SIZES) as Array<keyof typeof SIZES>).find(
                    (k) => SIZES[k].width === page.width && SIZES[k].height === page.height,
                  ) ?? 'custom'
                }
                onChange={(event) => {
                  const size = SIZES[event.target.value as keyof typeof SIZES]
                  if (size) {
                    apply([
                      { op: 'set', id: page.id, key: 'width', value: size.width },
                      { op: 'set', id: page.id, key: 'height', value: size.height },
                    ])
                  }
                }}
              >
                {(Object.keys(SIZES) as Array<keyof typeof SIZES>).map((k) => (
                  <option key={k} value={k}>
                    {`${t(`board.props.presets.${k}`)}  ${SIZES[k].width} × ${SIZES[k].height}`}
                  </option>
                ))}
                <option value="custom">{t('board.props.presets.custom')}</option>
              </select>
            </label>
            <div className="k-ce-grid2">
              <NumberField
                label={t('board.props.width')}
                value={page.width}
                onCommit={(n) => set(page.id, 'width', Math.round(n))}
              />
              <NumberField
                label={t('board.props.height')}
                value={page.height}
                onCommit={(n) => set(page.id, 'height', Math.round(n))}
              />
              <NumberField
                label={t('board.props.x')}
                value={page.x}
                onCommit={(n) => set(page.id, 'x', Math.round(n))}
              />
              <NumberField
                label={t('board.props.y')}
                value={page.y}
                onCommit={(n) => set(page.id, 'y', Math.round(n))}
              />
            </div>
          </div>
        </div>
      )}
      {page && (
        <PageParams
          key={page.id}
          artifactId={artifactId}
          version={version}
          page={page}
          frame={editorFrame(page.id)}
        />
      )}
      {section && (
        <div className="k-ce-psec">
          <h5>{t('board.props.section')}</h5>
          <TextField
            label={t('board.props.title')}
            value={section.title}
            onCommit={(v) => set(section.id, 'title', v)}
          />
        </div>
      )}
      {note && (
        <div className="k-ce-psec">
          <h5>{t('board.props.note')}</h5>
          <div className="k-ce-prow">
            <span>{t('board.props.color')}</span>
            <ColorRow value={note.color} onChange={(color) => set(note.id, 'color', color)} />
          </div>
          {(note.kind === 'pen' ||
            note.kind === 'rect' ||
            note.kind === 'ellipse' ||
            note.kind === 'line' ||
            note.kind === 'arrow') && (
            <div className="k-ce-prow">
              <span>{t('board.props.strokeWidth')}</span>
              <span className="flex gap-1">
                {WIDTHS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    aria-label={`${w}`}
                    aria-pressed={note.width === w}
                    className={cn('k-ce-tool', note.width === w && 'bg-selected')}
                    onClick={() => set(note.id, 'width', w)}
                  >
                    <span className="block w-4 rounded-full bg-current" style={{ height: w }} />
                  </button>
                ))}
              </span>
            </div>
          )}
          {note.kind === 'text' && (
            <div className="k-ce-prow">
              <span>{t('board.props.fontSize')}</span>
              <span className="w-20">
                <NumberField
                  label=""
                  value={note.size}
                  onCommit={(n) => set(note.id, 'size', Math.round(n))}
                />
              </span>
            </div>
          )}
          {note.kind === 'sticky' && (
            <div className="k-ce-prow">
              <span>{t('board.props.done')}</span>
              <Switch
                checked={note.done}
                onCheckedChange={(on) => set(note.id, 'done', on)}
                aria-label={t('board.props.done')}
              />
            </div>
          )}
        </div>
      )}
      <div className="k-ce-psec">
        <h5>
          {t('board.props.arrange')}
          {selection.length > 1 && (
            <span>{t('board.props.selected', { count: selection.length })}</span>
          )}
        </h5>
        <div className="k-ce-aligns">
          {boxes.length >= 2 && (
            <>
              <IconAct
                label={t('board.props.alignLeft')}
                icon={AlignLeftIcon}
                onClick={() => align('left')}
              />
              <IconAct
                label={t('board.props.alignCenter')}
                icon={AlignHorizontalCenterIcon}
                onClick={() => align('center')}
              />
              <IconAct
                label={t('board.props.alignRight')}
                icon={AlignRightIcon}
                onClick={() => align('right')}
              />
              <IconAct
                label={t('board.props.alignTop')}
                icon={AlignTopIcon}
                onClick={() => align('top')}
              />
              <IconAct
                label={t('board.props.alignMiddle')}
                icon={AlignVerticalCenterIcon}
                onClick={() => align('middle')}
              />
              <IconAct
                label={t('board.props.alignBottom')}
                icon={AlignBottomIcon}
                onClick={() => align('bottom')}
              />
            </>
          )}
          {boxes.length >= 3 && (
            <>
              <IconAct
                label={t('board.props.distributeH')}
                icon={DistributeHorizontalCenterIcon}
                onClick={() => distribute('x')}
              />
              <IconAct
                label={t('board.props.distributeV')}
                icon={DistributeVerticalCenterIcon}
                onClick={() => distribute('y')}
              />
            </>
          )}
          <IconAct label={t('board.props.duplicate')} icon={Copy01Icon} onClick={duplicate} />
          {(page || note) && (
            <IconAct
              label={t(locked ? 'board.props.unlock' : 'board.props.lock')}
              icon={locked ? SquareUnlock01Icon : SquareLock01Icon}
              onClick={() => set((page ?? note)!.id, 'locked', !locked)}
            />
          )}
          <IconAct label={t('board.props.delete')} icon={Delete02Icon} onClick={remove} />
        </div>
      </div>
    </div>
  )
}

function IconAct({
  label,
  icon,
  onClick,
}: {
  label: string
  icon: IconSvgElement
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<button type="button" aria-label={label} className="k-ce-tool" onClick={onClick} />}
      >
        <HugeiconsIcon icon={icon} size={15} strokeWidth={1.9} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
