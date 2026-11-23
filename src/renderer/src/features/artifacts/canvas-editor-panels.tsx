import { useEffect, useRef, useState } from 'react'
import { SlidersHorizontalIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { PageParam, ParamValue } from '@shared/artifact-params'
import type { CanvasPage } from '@shared/canvas-doc'
import { Button } from '@renderer/components/affect/button'
import { SegmentedControl } from '@renderer/components/affect/segmented-control'
import { Switch } from '@renderer/components/ui/switch'
import { errorCode, errorMessage, host } from '@renderer/lib/host'
import { dropUnsaved, keepUnsaved, unsavedAt, unsavedSlot } from '@renderer/stores/artifact-unsaved'
import { ColorInput } from './edit-panel'
import type { EditorFrame } from './editor'
import { CardHead, KeptNote, Notice, SaveChip, UndoButton } from './tool-parts'
import { useEditRun } from './use-edit-run'

/** A tweak is written once the user stops changing it this long. */
const PARAMS_SAVE_MS = 1000

type Values = Record<string, ParamValue>

const valuesOf = (params: readonly PageParam[]): Values =>
  Object.fromEntries(params.map((p) => [p.name, p.value]))

/**
 * The Tweak card for one frame: a row for each setting it declares, a control by the setting's
 * type, changed rows marked with a dot that puts them back, and Reset all. A change shows at once
 * and is written as the user's version a moment after they stop.
 */
export function TweakCard({
  artifactId,
  version,
  page,
  params,
  frameOf,
  readOnly,
}: {
  artifactId: string
  version: number
  /** The frame's link, read when a change is shown on it. */
  page: CanvasPage | null
  params: readonly PageParam[] | null
  frameOf: () => EditorFrame | null
  readOnly: boolean
}) {
  const { t } = useTranslation('artifacts')
  return (
    <aside aria-label={t('tweak.title')} className="k-av-side k-vt-card">
      {page && params ? (
        <TweakBody
          key={`${artifactId}:${page.id}`}
          artifactId={artifactId}
          version={version}
          page={page}
          params={params}
          frameOf={frameOf}
          readOnly={readOnly}
        />
      ) : (
        <>
          <CardHead icon={SlidersHorizontalIcon} title={t('tweak.title')} />
          <div className="k-vt-body">
            <Notice>{t('tweak.none')}</Notice>
          </div>
        </>
      )}
    </aside>
  )
}

function TweakBody({
  artifactId,
  version,
  page,
  params,
  frameOf,
  readOnly,
}: {
  artifactId: string
  version: number
  page: CanvasPage
  params: readonly PageParam[]
  frameOf: () => EditorFrame | null
  readOnly: boolean
}) {
  const { t } = useTranslation('artifacts')
  // What the frame held when the card opened, which a row's dot and Reset all put back.
  const [baseline] = useState<Values>(() => valuesOf(params))
  // Tweaks of this frame that did not save before the viewer was left, shown again.
  const slot = unsavedSlot({ kind: 'params', frame: page.id })
  const [kept] = useState(() => {
    const change = unsavedAt(artifactId, slot)
    return change?.kind === 'params' ? change : null
  })
  const [values, setValues] = useState<Values>(() => ({ ...baseline, ...kept?.values }))
  const run = useEditRun(artifactId, kept ? { state: 'failed', error: kept.error } : null)
  const pending = useRef<Values>({ ...kept?.values })
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const wrote = useRef(0)
  // The version kept tweaks were made on, so a newer one is a conflict before it is written over.
  const keptBase = useRef(kept?.version ?? null)
  // The frame shows the kept tweaks again, on the page it loads too, until they change or save.
  useEffect(() => {
    if (!kept) return
    let tries = 0
    const show = (): boolean => {
      const frame = frameOf()
      frame?.params(kept.values, true)
      return !!frame
    }
    if (show()) return
    const poll = setInterval(() => {
      if (show() || ++tries > 40) clearInterval(poll)
    }, 100)
    return () => clearInterval(poll)
    // Once, for the frame the card opened on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const versionRef = useRef(version)
  useEffect(() => {
    versionRef.current = version
  })
  useEffect(() => () => clearTimeout(timer.current), [])

  const write = () => {
    const send = pending.current
    if (Object.keys(send).length === 0) return
    const base = keptBase.current ?? Math.max(versionRef.current, wrote.current)
    host('artifacts.setParams', {
      id: artifactId,
      baseVersion: base,
      path: page.file,
      values: send,
    })
      .then(({ version: made }) => {
        wrote.current = made
        keptBase.current = null
        // Only what was sent is written; a change typed since waits for its own turn.
        for (const name of Object.keys(send)) {
          if (pending.current[name] === send[name]) delete pending.current[name]
        }
        dropUnsaved(artifactId, slot)
        run.wrote(made, base)
      })
      // Nothing changed is lost: the values stay on screen and the chip offers to try again.
      .catch((reason: unknown) => {
        // The next try is made on the version shown by then.
        if (errorCode(reason) === 'conflict') keptBase.current = null
        // Kept beyond this card, which may be gone by now, until it saves or is discarded.
        keepUnsaved(artifactId, {
          kind: 'params',
          frame: page.id,
          values: { ...pending.current },
          version: base,
          error: errorMessage(reason),
        })
        run.failed(reason)
      })
  }

  const change = (next: Values) => {
    if (readOnly) return
    setValues((was) => ({ ...was, ...next }))
    frameOf()?.params(next)
    pending.current = { ...pending.current, ...next }
    run.pending()
    clearTimeout(timer.current)
    timer.current = setTimeout(write, PARAMS_SAVE_MS)
  }

  const changed = params.filter((p) => values[p.name] !== baseline[p.name])
  const reset = (names: readonly string[]) =>
    change(Object.fromEntries(names.map((name) => [name, baseline[name]!])))

  const undo = run.undo
    ? () => {
        clearTimeout(timer.current)
        pending.current = {}
        dropUnsaved(artifactId, slot)
        void run.undo?.().then(
          (made) => {
            if (made === null) return
            wrote.current = made
            setValues(baseline)
            frameOf()?.params(baseline)
          },
          (reason: unknown) => run.failed(reason),
        )
      }
    : null

  return (
    <>
      <CardHead
        icon={SlidersHorizontalIcon}
        title={t('tweak.title')}
        sub={page.name}
        status={<SaveChip save={run.save} onRetry={write} />}
      >
        <UndoButton onUndo={undo} />
      </CardHead>
      <div className="k-vt-body">
        <KeptNote save={run.save} />
        <div className="k-vt-fields">
          {params.map((p) => {
            const value = values[p.name]
            const dirty = value !== baseline[p.name]
            return (
              <div key={p.name} className="k-vt-field-row" data-changed={dirty || undefined}>
                <span className="k-vt-field-row__label">
                  {dirty && (
                    <button
                      type="button"
                      className="k-vt-dot"
                      aria-label={t('tweak.resetOne', { name: p.label })}
                      title={t('tweak.resetOne', { name: p.label })}
                      onClick={() => reset([p.name])}
                    />
                  )}
                  <span aria-hidden>{p.label}</span>
                </span>
                <span className="k-vt-field-row__ctl">
                  <Control param={p} value={value} onChange={(v) => change({ [p.name]: v })} />
                </span>
              </div>
            )
          })}
        </div>
      </div>
      <div className="k-vt-foot">
        <span>
          <Button
            variant="ghost"
            size="sm"
            disabled={changed.length === 0 || readOnly}
            onClick={() => reset(changed.map((p) => p.name))}
          >
            {t('tweak.resetAll')}
          </Button>
        </span>
        <p className="k-vt-foot__note">{t('tweak.note')}</p>
      </div>
    </>
  )
}

function Control({
  param,
  value,
  onChange,
}: {
  param: PageParam
  value: ParamValue | undefined
  onChange: (value: ParamValue) => void
}) {
  switch (param.type) {
    case 'color':
      return <ParamColor label={param.label} value={String(value ?? '')} onChange={onChange} />
    case 'boolean':
      return (
        <Switch
          checked={Boolean(value)}
          onCheckedChange={(on) => onChange(on)}
          aria-label={param.label}
        />
      )
    case 'choice':
      return param.options.length <= 3 ? (
        <SegmentedControl<string>
          aria-label={param.label}
          variant="tray"
          size="sm"
          fullWidth
          value={String(value)}
          onChange={onChange}
          options={param.options.map((o) => ({ value: o, label: o }))}
        />
      ) : (
        <select
          aria-label={param.label}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
          className="k-vt-select"
        >
          {param.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      )
    case 'number':
      return (
        <span className="k-vt-num">
          <input
            type="number"
            aria-label={param.label}
            min={param.min}
            max={param.max}
            step={param.step}
            value={Number(value)}
            onChange={(event) => {
              const n = Number(event.target.value)
              if (Number.isFinite(n)) onChange(Math.min(param.max, Math.max(param.min, n)))
            }}
          />
          {param.unit && <span className="k-vt-num__unit">{param.unit}</span>}
        </span>
      )
    case 'text':
      return (
        <input
          aria-label={param.label}
          value={String(value ?? '')}
          onChange={(event) => onChange(event.target.value)}
          className="k-vt-input"
        />
      )
  }
}

/** A color setting: what is typed stays until it is a color, which is then set. */
function ParamColor({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  const [typed, setTyped] = useState(value.toUpperCase())
  const [shown, setShown] = useState(value)
  if (shown !== value) {
    setShown(value)
    setTyped(value.toUpperCase())
  }
  return (
    <ColorInput
      label={label}
      value={typed}
      onChange={(next) => {
        setTyped(next)
        if (/^#[0-9a-f]{6}$/i.test(next)) onChange(next.toLowerCase())
      }}
    />
  )
}
