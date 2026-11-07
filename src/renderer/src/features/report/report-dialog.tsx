import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft01Icon,
  Copy01Icon,
  FileViewIcon,
  GithubIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { ReportPrepareResult } from '@shared/ipc'
import type { HostAdminResult } from '@shared/remote/host-admin'
import {
  REPORT_EXTRAS,
  reportIssueUrl,
  reportSubmitResult,
  type PreparedReport,
  type ReportExtra,
  type ReportFileView,
  type ReportRange,
  type ReportRequest,
  type ReportSubmitFailure,
  type ReportSubmitResult,
} from '@shared/report'
import { SegmentedControl } from '@renderer/components/segmented-control'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { Spinner } from '@renderer/components/ui/spinner'
import { Textarea } from '@renderer/components/ui/textarea'
import { toast } from '@renderer/components/ui/toast'
import { recordAction } from '@renderer/lib/action-log'
import { errorMessage } from '@renderer/lib/host'
import { isWeb } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { signIn, useAccountStore } from '@renderer/stores/account'
import { useOtherHost } from '@renderer/stores/hosts'
import { closeReport, useReportStore, type ReportDialog as Opened } from '@renderer/stores/report'

const SENSITIVE: ReadonlySet<ReportExtra> = new Set(['messages', 'verbose', 'dumps'])

/** What the dialog says when a report was not submitted. */
const NOT_SUBMITTED = {
  too_large: 'notSubmitted.tooLarge',
  rate_limited: 'notSubmitted.rateLimited',
  unauthorized: 'notSubmitted.unauthorized',
  signed_out: 'notSubmitted.signedOut',
  network: 'notSubmitted.network',
  failed: 'notSubmitted.failed',
} as const satisfies Record<ReportSubmitFailure, string>

type Prepared = { key: string; report: PreparedReport; ref: string | null }

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

/**
 * A bundle for another host comes over its channel, and this computer's main keeps it the same;
 * `ref` is the bundle as that host keeps it, to submit with its sign-in.
 */
async function prepare(
  hostId: string | null,
  request: ReportRequest,
): Promise<{ result: ReportPrepareResult; ref: string | null }> {
  if (hostId === null) return { result: await window.kettu.report.prepare(request), ref: null }
  const answer = (await window.kettu.hosts.request(hostId, 'host.report', {
    request,
  })) as HostAdminResult<'host.report'>
  if (!answer.ok) return { result: { ok: false, reason: answer.reason }, ref: null }
  return { result: await window.kettu.report.adopt(answer.zip), ref: answer.ref }
}

/** Submits what was reviewed, with the sign-in of the host that built it. */
async function submit(hostId: string | null, prepared: Prepared): Promise<ReportSubmitResult> {
  if (hostId === null) return window.kettu.report.submit(prepared.report.id)
  if (prepared.ref === null) return { ok: false, reason: 'failed' }
  return reportSubmitResult(
    await window.kettu.hosts.request(hostId, 'host.submitReport', { ref: prepared.ref }),
  )
}

function ReportForm({ dialog }: { dialog: Opened }) {
  const { t } = useTranslation(['report', 'common'])
  const other = useOtherHost(dialog.hostId)
  const [description, setDescription] = useState('')
  const [range, setRange] = useState<ReportRange>(dialog.range)
  const [extras, setExtras] = useState<ReadonlySet<ReportExtra>>(() => new Set(dialog.extras))
  const [prepared, setPrepared] = useState<Prepared | null>(null)
  const [viewing, setViewing] = useState(false)
  const [busy, setBusy] = useState<'view' | 'save' | 'submit' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState<Extract<ReportSubmitResult, { ok: true }> | null>(null)
  // This computer's sign-in is known here; another host answers for its own.
  const local = dialog.hostId === null && !isWeb
  const signedIn = useAccountStore((s) => s.status?.state === 'signed-in')
  const signingIn = useAccountStore((s) => s.status?.state === 'signing-in')
  const mustSignIn = local && !signedIn
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

  const bundle = async (): Promise<Prepared | null> => {
    if (prepared?.key === key) return prepared
    if (prepared) void window.kettu.report.discard(prepared.report.id)
    setPrepared(null)
    const { result, ref } = await prepare(dialog.hostId, request)
    if (!result.ok) {
      setError(t(result.reason === 'too_large' ? 'tooLarge' : 'failed'))
      return null
    }
    const next = { key, report: result.report, ref }
    setPrepared(next)
    return next
  }

  const run = async (what: 'view' | 'save' | 'submit'): Promise<void> => {
    if (!ready || busy) return
    setBusy(what)
    setError(null)
    try {
      const made = await bundle()
      if (!made) return
      const report = made.report
      if (what === 'view') {
        setViewing(true)
        return
      }
      if (what === 'submit') {
        recordAction('report.submit', { files: report.files.length })
        const result = await submit(dialog.hostId, made)
        if (result.ok) setSubmitted(result)
        else setError(t(NOT_SUBMITTED[result.reason]))
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

  if (submitted) return <Submitted report={submitted} />
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
        {mustSignIn && (
          <p className="flex items-center gap-1.5 text-hint text-tertiary">
            {t('signInToSubmit')}
            <Button
              type="button"
              variant="link"
              size="xs"
              className="px-0"
              disabled={signingIn}
              onClick={() => void signIn()}
            >
              {t('signIn')}
            </Button>
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
        <Button
          type="button"
          variant="outline"
          size="compact"
          disabled={!ready || busy !== null || mustSignIn}
          onClick={() => void run('submit')}
        >
          {busy === 'submit' && <Spinner data-icon="inline-start" />}
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

/** The id the report was given, to copy, and the way to an issue that names it. */
function Submitted({ report }: { report: Extract<ReportSubmitResult, { ok: true }> }) {
  const { t } = useTranslation(['report', 'common'])
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard.writeText(report.id).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div className="flex flex-col">
      <DialogHeader className="px-5.5 pt-5">
        <DialogTitle>{t('submitted.title')}</DialogTitle>
      </DialogHeader>
      <div className="flex flex-col gap-3 px-5.5 pt-3">
        <p className="text-control text-secondary">{t('submitted.body')}</p>
        <div className="flex items-center gap-2 rounded-lg bg-muted py-1.5 pr-1.5 pl-3">
          <span data-selectable="" className="flex-1 font-mono text-code text-primary">
            {report.id}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={copy}>
            <HugeiconsIcon
              icon={copied ? Tick02Icon : Copy01Icon}
              strokeWidth={1.9}
              data-icon="inline-start"
            />
            {copied ? t('submitted.copied') : t('submitted.copy')}
          </Button>
        </div>
      </div>
      <div className="flex items-center gap-2 px-5.5 py-4.5 *:h-7.5">
        <span className="flex-1" />
        <a
          href={reportIssueUrl(report)}
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ variant: 'outline', size: 'compact' })}
        >
          <HugeiconsIcon icon={GithubIcon} strokeWidth={1.9} data-icon="inline-start" />
          {t('submitted.openIssue')}
        </a>
        <Button type="button" size="compact" onClick={() => closeReport()}>
          {t('common:actions.done')}
        </Button>
      </div>
    </div>
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
