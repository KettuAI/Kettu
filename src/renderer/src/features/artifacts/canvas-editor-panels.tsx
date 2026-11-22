import { useEffect, useRef, useState } from 'react'
import { Tick02Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { paramsRange, parseParams, type PageParam, type ParamValue } from '@shared/artifact-params'
import type { CanvasPage } from '@shared/canvas-doc'
import { Switch } from '@renderer/components/ui/switch'
import { errorCode, host } from '@renderer/lib/host'
import { toast } from '@renderer/components/ui/toast'
import { FRAME_ICON } from './canvas-tools'
import type { DocLayout } from './canvas-model'
import type { EditorFrame } from './editor'

/** A tweak is written once the user stops changing it this long. */
const PARAMS_SAVE_MS = 1000

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
