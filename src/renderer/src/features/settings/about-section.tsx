import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CheckIcon, CircleCheckIcon, CopyIcon, ExternalLinkIcon, RefreshCwIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AppInfo } from '@shared/ipc'
import { releaseUrl, type UpdateStatus } from '@shared/updates'
import { BrandLockup } from '@renderer/components/brand'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { Progress } from '@renderer/components/ui/progress'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { longAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import { useSettingsStore } from '@renderer/stores/settings'
import { checkForUpdates, useUpdatesStore } from '@renderer/stores/updates'
import { ControlError, SettingSelect } from './controls'
import { useApply } from './use-apply'

/** The top of the About page, in place of the page title. */
export function AboutHero({ info }: { info: AppInfo | null }) {
  const { t } = useTranslation('settings')
  return (
    <header className="flex flex-col gap-1.5 px-1 pb-7">
      <h2 id="settings-about" className="pb-1">
        <BrandLockup fontSize={22} />
      </h2>
      <p className="text-small text-pretty text-secondary">{t('about.version.description')}</p>
      {info ? (
        <p data-selectable="" className="font-mono text-meta text-tertiary">
          {`${info.version} · ${info.platform} ${info.arch}`}
        </p>
      ) : (
        <Skeleton className="h-4 w-44" />
      )}
    </header>
  )
}

export function UpdateRow({ status, label }: { status: UpdateStatus | null; label: ReactNode }) {
  const { t } = useTranslation('settings')
  const justChecked = useUpdatesStore((s) => s.justChecked)
  const now = useNow()
  const [error, setError] = useState<string | null>(null)
  const run = (action: () => Promise<unknown>) => {
    setError(null)
    action().catch((e: unknown) => setError(errorMessage(e)))
  }
  if (!status) {
    return (
      <div className="flex min-h-7 items-center gap-6">
        <div className="min-w-0 flex-1">{label}</div>
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
      className={buttonVariants({ variant: 'quiet', size: 'compact' })}
    >
      {t('about.updates.whatsNew')}
    </a>
  )
  // While a check runs the button stays, busy, so the row does not change shape.
  const check = (busy: boolean) => (
    <Button variant="outline" size="compact" disabled={busy} onClick={() => run(checkForUpdates)}>
      {busy ? (
        <Spinner data-icon="inline-start" className="size-3.5" />
      ) : (
        <RefreshCwIcon data-icon="inline-start" />
      )}
      {t('about.updates.check')}
    </Button>
  )

  let text: ReactNode
  let action: ReactNode = null
  if (justChecked && state.kind === 'idle') {
    text = (
      <span
        key="checked"
        className="inline-flex animate-in items-center gap-1.5 fade-in animation-duration-(--duration-base)"
      >
        <CircleCheckIcon className="size-3 text-icon" />
        {t('about.updates.upToDateShort')}
      </span>
    )
    action = check(false)
  } else {
    switch (state.kind) {
      case 'idle':
        text = state.checkedAt
          ? t('about.updates.upToDateChecked', { ago: longAgo(state.checkedAt, now) })
          : t('about.updates.upToDate')
        action = check(false)
        break
      case 'checking':
        text = t('about.updates.checking')
        action = check(true)
        break
      case 'downloading':
        text = (
          <span className="flex w-56 flex-col gap-1.5">
            <span className="flex justify-between tabular">
              {t('about.updates.downloading', { version: state.version })}
              <span>{Math.round(state.percent)}%</span>
            </span>
            <Progress value={state.percent} aria-label={t('about.updates.downloadProgress')} />
          </span>
        )
        break
      case 'ready':
        text = t('about.updates.ready', { version: state.version })
        action = (
          <>
            {whatsNew(state.version)}
            <Button size="compact" onClick={() => run(window.overbench.updates.restart)}>
              {t('about.updates.restart')}
            </Button>
          </>
        )
        break
      case 'available':
        text = t('about.updates.available', { version: state.version })
        action = (
          <>
            {whatsNew(state.version)}
            {state.mode === 'link' ? (
              <a
                href={releaseUrl(state.version)}
                target="_blank"
                rel="noreferrer"
                className={buttonVariants({ size: 'compact' })}
              >
                {t('about.updates.download')}
                <ExternalLinkIcon data-icon="inline-end" />
              </a>
            ) : (
              <Button size="compact" onClick={() => run(window.overbench.updates.download)}>
                {t('about.updates.download')}
              </Button>
            )}
          </>
        )
        break
      case 'error':
        text = (
          <span className="flex flex-col">
            <span className="text-danger">{t('about.updates.failed')}</span>
            <span data-selectable="">{state.message}</span>
          </span>
        )
        action = (
          <Button variant="outline" size="compact" onClick={() => run(checkForUpdates)}>
            {t('about.updates.tryAgain')}
          </Button>
        )
        break
      case 'off':
        text = (
          <span>
            {state.reason === 'development'
              ? t('about.updates.offDevelopment')
              : t('about.updates.offPackageManager')}
          </span>
        )
    }
  }
  // The status reads as the row's description, so the action sits beside it like any other row's.
  return (
    <div className="flex min-h-7 items-center gap-6">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {label}
        <span className="text-xs leading-normal text-secondary">{text}</span>
      </div>
      <ControlError error={error} />
      {action && <span className="flex shrink-0 items-center gap-1.5">{action}</span>}
    </div>
  )
}

export function AutomaticUpdates() {
  const { t } = useTranslation('settings')
  const value = useSettingsStore((s) => s.settings.updates.automatic)
  const [apply, error] = useApply()
  return (
    <>
      <ControlError error={error} />
      <SettingSelect
        label={t('about.automatic.name')}
        value={value}
        options={[
          { value: 'download', label: t('about.automatic.download') },
          { value: 'notify', label: t('about.automatic.notify') },
          { value: 'off', label: t('about.automatic.off') },
        ]}
        onChange={(v) => apply({ updates: { automatic: v } })}
      />
    </>
  )
}

const versionsText = (info: AppInfo) =>
  `OverBench ${info.version} (${info.platform} ${info.arch})\nElectron ${info.versions.electron}\nChromium ${info.versions.chrome}\nNode.js ${info.versions.node}`

/** Copies the version block; the icon and label turn into a check for a moment. */
export function CopyVersions({ info }: { info: AppInfo }) {
  const { t } = useTranslation('settings')
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = () => {
    void navigator.clipboard.writeText(versionsText(info)).then(() => {
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <Button variant="quiet" size="xs" onClick={copy} className="-mr-2">
      {copied ? (
        <CheckIcon
          data-icon="inline-start"
          className="animate-in text-icon animation-duration-(--duration-fast) fade-in zoom-in-75"
        />
      ) : (
        <CopyIcon data-icon="inline-start" />
      )}
      {copied ? t('about.runtime.copied') : t('about.runtime.copy')}
    </Button>
  )
}

export function RuntimeFact({ value }: { value: string | undefined }) {
  if (value === undefined) return <Skeleton className="h-4 w-24" />
  return (
    <span data-selectable="" className="font-mono text-meta text-tertiary">
      {value}
    </span>
  )
}

/**
 * A link row: the whole row opens the page, which main sends to the system browser. The line
 * under the name is the address, unless `detail` says something more useful.
 */
export function LinkRow({ name, url, detail }: { name: string; url: string; detail?: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="group -mx-2 flex items-center gap-3 rounded-lg px-3 py-3 outline-none transition-colors duration-(--duration-fast) hover:bg-hover focus-ring"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-ui font-medium">{name}</span>
        <span className="truncate text-xs text-tertiary">
          {detail ?? url.replace(/^https?:\/\//, '')}
        </span>
      </span>
      <ExternalLinkIcon className="size-3.5 shrink-0 text-icon transition-colors duration-(--duration-fast) group-hover:text-primary" />
    </a>
  )
}
