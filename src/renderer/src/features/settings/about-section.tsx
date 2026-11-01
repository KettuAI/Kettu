import { useState, type ReactNode } from 'react'
import { ArrowUpRightIcon, CheckIcon, ExternalLinkIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AppInfo } from '@shared/ipc'
import type { SettingsFile } from '@shared/settings'
import { releaseUrl, type UpdateStatus } from '@shared/updates'
import { BrandLockup } from '@renderer/components/brand'
import { useRefresh } from '@renderer/components/refresh'
import { RefreshIcon } from '@renderer/components/refresh-icon'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { Progress } from '@renderer/components/ui/progress'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { longAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useHostContext } from '@renderer/lib/host-features'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useSettingsStore } from '@renderer/stores/settings'
import { checkForUpdates, useUpdatesStore } from '@renderer/stores/updates'
import { ControlError, SettingSelect } from './controls'
import { useApply } from './use-apply'

/** The top of the About page, in place of the page title. */
export function AboutHero({ info }: { info: AppInfo | null }) {
  const { t } = useTranslation('settings')
  return (
    <header className="flex flex-col gap-1.5 pb-7">
      <h2 id="settings-about" className="pb-1">
        <BrandLockup fontSize={22} />
      </h2>
      <p className="text-small text-pretty text-secondary">{t('about.version.description')}</p>
      {info ? (
        <p data-selectable="" className="font-mono text-code text-tertiary">
          {`${info.version} · ${info.system}`}
        </p>
      ) : (
        <Skeleton className="h-4 w-44" />
      )}
    </header>
  )
}

export function UpdateRow({ status }: { status: UpdateStatus | null }) {
  const { t } = useTranslation('settings')
  const justChecked = useUpdatesStore((s) => s.justChecked)
  const now = useNow()
  const refresh = useRefresh({ busy: status?.state.kind === 'checking' })
  const [error, setError] = useState<string | null>(null)
  const run = (action: () => Promise<unknown>) => {
    setError(null)
    action().catch((e: unknown) => setError(errorMessage(e)))
  }
  if (!status) {
    return (
      <div className="flex min-h-10 items-center gap-4">
        <span className="min-w-0 flex-1 text-ui font-medium">{t('about.updates.name')}</span>
        <Spinner className="size-3.5 text-tertiary" />
      </div>
    )
  }
  const { state } = status
  const whatsNew = (version: string) => (
    <a
      href={releaseUrl(version)}
      target="_blank"
      rel="noreferrer"
      className={cn(buttonVariants({ variant: 'quiet', size: 'sm' }), 'text-secondary')}
    >
      {t('about.updates.whatsNew')}
      <ArrowUpRightIcon data-icon="inline-end" className="size-3.5 text-icon" />
    </a>
  )
  // While a check runs the button stays, busy, so the row does not change shape.
  const check = (
    <Button
      variant="outline"
      size="sm"
      aria-busy={refresh.phase === 'turning'}
      disabled={refresh.phase === 'turning'}
      onClick={() => {
        setError(null)
        void refresh.run(checkForUpdates).catch((e: unknown) => setError(errorMessage(e)))
      }}
    >
      <RefreshIcon phase={refresh.phase} data-icon="inline-start" />
      {t('about.updates.check')}
    </Button>
  )

  let title: ReactNode
  let detail: ReactNode = null
  let action: ReactNode = null
  switch (state.kind) {
    case 'idle':
      if (justChecked || state.checkedAt) {
        title = (
          <>
            {justChecked && (
              <CheckIcon className="size-3.5 shrink-0 animate-in text-success fade-in animation-duration-(--duration-base)" />
            )}
            {t('about.updates.upToDate')}
          </>
        )
        if (state.checkedAt) {
          detail = t('about.updates.checkedAgo', { ago: longAgo(state.checkedAt, now) })
        }
      } else title = t('about.updates.notChecked')
      action = check
      break
    case 'checking':
      title = t('about.updates.checking')
      action = check
      break
    case 'downloading':
      title = t('about.updates.downloading', { version: state.version })
      detail = (
        <span className="mt-1 flex items-center gap-2.5 text-tertiary">
          <Progress
            value={state.percent}
            aria-label={t('about.updates.downloadProgress')}
            className="max-w-65 flex-1"
          />
          <span className="tabular">{Math.round(state.percent)}%</span>
        </span>
      )
      break
    case 'ready':
      title = t('about.updates.ready', { version: state.version })
      action = (
        <>
          {whatsNew(state.version)}
          <Button size="sm" onClick={() => run(window.kettu.updates.restart)}>
            {t('about.updates.restart')}
          </Button>
        </>
      )
      break
    case 'available':
      title = t('about.updates.available', { version: state.version })
      if (state.mode === 'install' && status.readOnly) detail = t('about.updates.movesFirst')
      action = (
        <>
          {whatsNew(state.version)}
          {state.mode === 'link' ? (
            <a
              href={state.downloadUrl ?? releaseUrl(state.version)}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ size: 'sm' })}
            >
              {t('about.updates.download')}
              <ExternalLinkIcon data-icon="inline-end" />
            </a>
          ) : (
            <Button size="sm" onClick={() => run(window.kettu.updates.download)}>
              {t('about.updates.update')}
            </Button>
          )}
        </>
      )
      break
    case 'moving':
      title = t('about.updates.moving')
      break
    case 'error':
      title = state.move ? t('about.updates.moveFailed') : t('about.updates.failed')
      detail = <span data-selectable="">{state.message}</span>
      action = (
        <Button variant="outline" size="sm" onClick={() => run(checkForUpdates)}>
          {t('about.updates.tryAgain')}
        </Button>
      )
      break
    case 'off':
      title =
        state.reason === 'development'
          ? t('about.updates.offDevelopment')
          : t('about.updates.offPackageManager')
  }
  // What the updater is doing is the row's name, as it is the news; the group says it is updates.
  return (
    <div className="flex min-h-10 items-center gap-4">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.75 text-ui font-medium">{title}</span>
        {detail && <span className="mt-0.5 text-xs leading-4 text-secondary">{detail}</span>}
      </div>
      <ControlError error={error} />
      {action && <span className="flex shrink-0 items-center gap-1.5">{action}</span>}
    </div>
  )
}

/** The updates row on a host whose Kettu is not updated from Settings, as the daemon's. */
export function NoUpdates() {
  const { t } = useTranslation('settings')
  const onHost = useHostContext()
  return (
    <div className="flex min-h-10 flex-col justify-center">
      <span className="text-ui font-medium">{t('about.updates.none', onHost)}</span>
      <span className="mt-0.5 text-xs leading-4 text-secondary">
        {t('about.updates.noneDetail', onHost)}
      </span>
    </div>
  )
}

type AutomaticChoice = SettingsFile['updates']['automatic']

export function AutomaticUpdates() {
  const { t } = useTranslation('settings')
  const mode = useUpdatesStore((s) => s.status?.mode ?? 'install')
  const stored = useSettingsStore((s) => s.settings.updates.automatic)
  // Link mode cannot install, so a stored choice to download counts as notify there.
  const value: AutomaticChoice =
    mode === 'link' && (stored === 'download' || stored === 'restart') ? 'notify' : stored
  const [apply, error] = useApply()
  const options: { value: AutomaticChoice; label: string }[] =
    mode === 'link'
      ? [
          { value: 'notify', label: t('about.automatic.linkNotify') },
          { value: 'off', label: t('about.automatic.linkOff') },
        ]
      : [
          { value: 'download', label: t('about.automatic.download') },
          { value: 'restart', label: t('about.automatic.restart') },
          { value: 'notify', label: t('about.automatic.notify') },
          { value: 'off', label: t('about.automatic.off') },
        ]
  return (
    <>
      <ControlError error={error} />
      <SettingSelect
        label={t('about.automatic.name')}
        value={value}
        options={options}
        onChange={(v) => apply({ updates: { automatic: v } })}
      />
    </>
  )
}

/**
 * A link row: the whole row opens the page, which main sends to the system browser, or, with
 * `onOpen` in place of `url`, whatever that opens, showing its error in place of the detail. The
 * line under the name is the address, unless `detail` says something more useful.
 */
export function LinkRow({
  name,
  detail,
  ...target
}: { name: string; detail?: string } & (
  { url: string; onOpen?: never } | { onOpen: () => Promise<void>; url?: never }
)) {
  const [error, setError] = useState<string | null>(null)
  // The whole row is the link, so it fills the row to the card's edges and corners.
  const className =
    'group -mx-3 flex min-h-15 w-[calc(100%+--spacing(6))] items-center gap-4 rounded-[inherit] py-2.5 pr-3 pl-4 text-left outline-none transition-colors duration-(--duration-fast) hover:bg-hover focus-visible:shadow-[inset_0_0_0_2px_var(--focus)]'
  const body = (
    <>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-ui font-medium">{name}</span>
        {error ? (
          <span className="mt-0.5 truncate text-xs leading-4 text-danger" title={error}>
            {error}
          </span>
        ) : (
          <span className="mt-0.5 truncate text-xs leading-4 text-secondary">
            {detail ?? target.url?.replace(/^https?:\/\//, '')}
          </span>
        )}
      </span>
      <ExternalLinkIcon className="size-3.5 shrink-0 text-icon transition-colors duration-(--duration-fast) group-hover:text-primary" />
    </>
  )
  if (target.url !== undefined) {
    return (
      <a href={target.url} target="_blank" rel="noreferrer" className={className}>
        {body}
      </a>
    )
  }
  const { onOpen } = target
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        setError(null)
        onOpen().catch((e: unknown) => setError(errorMessage(e)))
      }}
    >
      {body}
    </button>
  )
}
