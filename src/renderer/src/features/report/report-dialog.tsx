import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft01Icon, FileViewIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { ReportPrepareResult } from '@shared/ipc'
import type { HostAdminResult } from '@shared/remote/host-admin'
import {
  REPORT_EXTRAS,
  type PreparedReport,
  type ReportExtra,
  type ReportFileView,
  type ReportRange,
  type ReportRequest,
} from '@shared/report'
import { SegmentedControl } from '@renderer/components/segmented-control'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { Spinner } from '@renderer/components/ui/spinner'
import { Textarea } from '@renderer/components/ui/textarea'
import { toast } from '@renderer/components/ui/toast'
import { recordAction } from '@renderer/lib/action-log'
import { errorMessage } from '@renderer/lib/host'
import { isWeb } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { useOtherHost } from '@renderer/stores/hosts'
import { closeReport, useReportStore, type ReportDialog as Opened } from '@renderer/stores/report'

const SENSITIVE: ReadonlySet<ReportExtra> = new Set(['messages', 'verbose', 'dumps'])

/** Report a problem: what happened, the range, the extras, a look at the files, then save. */
export function ReportDialog() {
  const dialog = useReportStore((s) => s.dialog)
  return (
    <Dialog open={dialog !== null} onOpenChange={(open) => !open && closeReport()}>
      <DialogContent showCloseButton={false} className="gap-0 p-0 sm:max-w-130">
        {dialog && <ReportForm key={dialog.key} dialog={dialog} />}
      </DialogContent>
    </Dialog>
  )
}

/** A bundle for another host comes over its channel; this computer's main keeps it the same. */
async function prepare(
  hostId: string | null,
  request: ReportRequest,
): Promise<ReportPrepareResult> {
  if (hostId === null) return window.kettu.report.prepare(request)
  const answer = (await window.kettu.hosts.request(hostId, 'host.report', {
    request,
  })) as HostAdminResult<'host.report'>
  if (!answer.ok) return { ok: false, reason: answer.reason }
  return window.kettu.report.adopt(answer.zip)
}

function ReportForm({ dialog }: { dialog: Opened }) {
  const { t } = useTranslation(['report', 'common'])
  const other = useOtherHost(dialog.hostId)
  const [description, setDescription] = useState('')
  const [range, setRange] = useState<ReportRange>(dialog.range)
  const [extras, setExtras] = useState<ReadonlySet<ReportExtra>>(() => new Set(dialog.extras))
  const [prepared, setPrepared] = useState<{ key: string; report: PreparedReport } | null>(null)
  const [viewing, setViewing] = useState(false)
  const [busy, setBusy] = useState<'view' | 'save' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef<PreparedReport | null>(null)
  useEffect(() => {
    latest.current = prepared?.report ?? null
  }, [prepared])
  // Dropped when the dialog closes; a new one replaces it when the choices change.
  useEffect(() => () => void (latest.current && window.kettu.report.discard(latest.current.id)), [])

  // A screenshot is of this window, and only main can take it.
  const offered = REPORT_EXTRAS.filter(
    (extra) => extra !== 'screenshot' || (dialog.hostId === null && !isWeb),
  )
  const request: ReportRequest = useMemo(
    () => ({
      description,
      range,
      extras: offered.filter((extra) => extras.has(extra)),
      context: dialog.context,
    }),
    // `offered` follows from the dialog alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [description, range, extras, dialog.context],
  )
  const key = JSON.stringify(request)
  const ready = description.trim() !== ''

  const bundle = async (): Promise<PreparedReport | null> => {
    if (prepared?.key === key) return prepared.report
    if (prepared) void window.kettu.report.discard(prepared.report.id)
    setPrepared(null)
    const result = await prepare(dialog.hostId, request)
    if (!result.ok) {
      setError(t(result.reason === 'too_large' ? 'tooLarge' : 'failed'))
      return null
    }
    setPrepared({ key, report: result.report })
    return result.report
  }

  const run = async (what: 'view' | 'save'): Promise<void> => {
    if (!ready || busy) return
    setBusy(what)
    setError(null)
    try {
      const report = await bundle()
      if (!report) return
      if (what === 'view') {
        setViewing(true)
        return
      }
      recordAction('report.save', { files: report.files.length })
      const path = await window.kettu.report.save(report.id)
      if (path === null) return
      closeReport()
      toast(
        t('saved'),
        isWeb
          ? undefined
          : {
              label: t('showFile'),
              onClick: () => void window.kettu.shell.showItem(path).catch(() => {}),
            },
        { tone: 'success' },
      )
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  if (viewing && prepared) {
    return <Contents report={prepared.report} onBack={() => setViewing(false)} />
  }

  const ranges = [
    ...(dialog.range.kind === 'span' ? [{ value: 'span', label: t('ranges.span') }] : []),
    { value: 'hour', label: t('ranges.hour') },
    { value: 'today', label: t('ranges.today') },
    { value: 'twoDays', label: t('ranges.twoDays') },
  ]
  const warn = [...extras].some((extra) => SENSITIVE.has(extra))
  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault()
        void run('save')
      }}
    >
      <DialogHeader className="px-5.5 pt-5">
        <DialogTitle className="truncate">
          {other ? t('titleOnHost', { name: other.name }) : t('title')}
        </DialogTitle>
      </DialogHeader>
      <div className="flex min-h-0 flex-col gap-4 px-5.5 pt-3.5">
        <Field label={t('what')} htmlFor="report-what">
          <Textarea
            id="report-what"
            value={description}
            autoFocus
            rows={3}
            maxLength={10_000}
            placeholder={t('whatPlaceholder')}
            className="max-h-50 min-h-20 resize-none text-control leading-[1.55]"
            onChange={(e) => setDescription(e.target.value)}
          />
          {dialog.context && <p className="text-hint text-tertiary">{t('context')}</p>}
        </Field>
        <Field label={t('range')}>
          <SegmentedControl
            aria-label={t('range')}
            value={range.kind}
            segments={ranges}
            onChange={(value) =>
              setRange(
                value === 'span'
                  ? dialog.range
                  : ({ kind: value as ReportRange['kind'] } as ReportRange),
              )
            }
          />
        </Field>
        <Field label={t('extras.label')}>
          <div className="flex flex-col gap-2">
            {offered.map((extra) => (
              <label key={extra} className="flex items-center gap-2.25 text-control text-primary">
                <Checkbox
                  checked={extras.has(extra)}
                  onCheckedChange={(on) => {
                    const next = new Set(extras)
                    if (on) next.add(extra)
                    else next.delete(extra)
                    setExtras(next)
                  }}
                />
                {t(`extras.${extra}`)}
              </label>
            ))}
          </div>
          <p className={cn('text-hint', warn ? 'text-warning' : 'text-tertiary')}>
            {warn ? t('sensitive') : t('always')}
          </p>
        </Field>
        {error !== null && (
          <p role="alert" className="text-hint text-danger">
            {error}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 px-5.5 py-4.5 *:data-[slot=button]:h-7.5">
        <Button
          type="button"
          variant="ghost"
          size="compact"
          disabled={!ready || busy !== null}
          onClick={() => void run('view')}
        >
          {busy === 'view' ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <HugeiconsIcon icon={FileViewIcon} strokeWidth={1.9} data-icon="inline-start" />
          )}
          {t('viewContents')}
        </Button>
        <span className="flex-1" />
        <Button type="button" variant="outline" size="compact" disabled>
          {t('submit')}
        </Button>
        <Button type="submit" size="compact" disabled={!ready || busy !== null}>
          {busy === 'save' && <Spinner data-icon="inline-start" />}
          {t('save')}
        </Button>
      </div>
    </form>
  )
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-hint font-medium text-secondary">
        {label}
      </label>
      {children}
    </div>
  )
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Every file of the bundle, each opened as it will be handed over. */
function Contents({ report, onBack }: { report: PreparedReport; onBack: () => void }) {
  const { t } = useTranslation('report')
  const [shown, setShown] = useState(report.files[0]?.path ?? null)
  // Kept with the file it shows, so another file shows nothing until its own comes.
  const [opened, setOpened] = useState<{
    path: string
    view: ReportFileView | { error: string }
  } | null>(null)
  const view = opened?.path === shown ? opened.view : null
  useEffect(() => {
    if (shown === null) return
    let live = true
    window.kettu.report.view(report.id, shown).then(
      (next) => live && setOpened({ path: shown, view: next }),
      (e: unknown) => live && setOpened({ path: shown, view: { error: errorMessage(e) } }),
    )
    return () => {
      live = false
    }
  }, [report.id, shown])
  return (
    <div className="flex flex-col">
      <DialogHeader className="flex-row items-center gap-1.5 px-4 pt-4">
        <Button variant="ghost" size="icon-sm" aria-label={t('back')} onClick={onBack}>
          <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={1.9} />
        </Button>
        <DialogTitle className="truncate">{t('viewContents')}</DialogTitle>
        <span className="ml-auto text-hint text-tertiary tabular">
          {t('files', { count: report.files.length })} · {size(report.size)}
        </span>
      </DialogHeader>
      <div className="mt-3 grid h-100 grid-cols-[minmax(0,13rem)_minmax(0,1fr)] border-t border-subtle">
        <ul
          className="overflow-y-auto border-r border-subtle py-1.5"
          aria-label={t('viewContents')}
        >
          {report.files.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                aria-current={file.path === shown}
                onClick={() => setShown(file.path)}
                className={cn(
                  'flex w-full items-baseline gap-2 px-3 py-1 text-left text-control hover:bg-subtle',
                  file.path === shown && 'bg-selected',
                )}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-code">{file.path}</span>
                <span className="shrink-0 text-hint text-tertiary tabular">{size(file.size)}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="min-w-0 overflow-auto">
          {view === null ? (
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          ) : 'error' in view ? (
            <p role="alert" className="p-3 text-hint text-danger">
              {view.error}
            </p>
          ) : view.kind === 'text' ? (
            <>
              {view.truncated && (
                <p className="px-3 pt-2 text-hint text-tertiary">{t('truncated')}</p>
              )}
              <pre
                data-selectable=""
                className="p-3 font-mono text-meta leading-relaxed whitespace-pre-wrap text-secondary"
              >
                {view.text}
              </pre>
            </>
          ) : view.kind === 'image' ? (
            <img
              src={view.dataUrl}
              alt={shown ?? ''}
              className="m-3 max-w-[calc(100%-1.5rem)] rounded-lg"
            />
          ) : (
            <p className="p-3 text-hint text-tertiary">{t('binary')}</p>
          )}
        </div>
      </div>
    </div>
  )
}
