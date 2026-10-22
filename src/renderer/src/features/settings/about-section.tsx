import { useEffect, useState, type ReactNode } from 'react'
import { CircleCheckIcon, ExternalLinkIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AppInfo } from '@shared/ipc'
import { releaseUrl, type UpdateStatus } from '@shared/updates'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { Progress } from '@renderer/components/ui/progress'
import { Spinner } from '@renderer/components/ui/spinner'
import { CopyButton } from '@renderer/features/git/branch-popover'
import { longAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import { useSettingsStore } from '@renderer/stores/settings'
import { checkForUpdates, useUpdatesStore } from '@renderer/stores/updates'
import { ControlError, SettingSelect } from './controls'
import { useApply } from './use-apply'

function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    void window.overbench.app.getInfo().then(setInfo)
  }, [])
  return info
}

export function Version() {
  const { t } = useTranslation('settings')
  const info = useAppInfo()
  if (!info) return <Spinner className="size-3.5 text-muted-foreground" />
  const text = `OverBench ${info.version} (${info.platform} ${info.arch})\nElectron ${info.versions.electron}\nChromium ${info.versions.chrome}\nNode.js ${info.versions.node}`
  return (
    <div className="flex items-start gap-2">
      <dl
        className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-right text-xs tabular"
        data-selectable=""
      >
        <dt className="text-muted-foreground">Electron</dt>
        <dd className="font-mono text-[11.5px]">{info.versions.electron}</dd>
        <dt className="text-muted-foreground">Chromium</dt>
        <dd className="font-mono text-[11.5px]">{info.versions.chrome}</dd>
        <dt className="text-muted-foreground">Node.js</dt>
        <dd className="font-mono text-[11.5px]">{info.versions.node}</dd>
      </dl>
      <CopyButton text={text} label={t('about.version.copy')} />
    </div>
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
      <div className="flex min-h-[28px] items-center gap-6">
        <div className="min-w-0 flex-1">{label}</div>
        <Spinner className="size-3.5 text-muted-foreground" />
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

  let text: ReactNode
  let action: ReactNode = null
  if (justChecked && state.kind === 'idle') {
    text = (
      <span
        key="checked"
        className="inline-flex animate-in items-center gap-1.5 fade-in animation-duration-(--duration-base)"
      >
        <CircleCheckIcon className="size-3.5 text-success" />
        {t('about.updates.upToDateShort')}
      </span>
    )
  } else {
    switch (state.kind) {
      case 'idle':
        text = state.checkedAt
          ? t('about.updates.upToDateChecked', { ago: longAgo(state.checkedAt, now) })
          : t('about.updates.upToDate')
        action = (
          <Button variant="outline" size="compact" onClick={() => run(checkForUpdates)}>
            {t('about.updates.check')}
          </Button>
        )
        break
      case 'checking':
        text = (
          <span className="inline-flex items-center gap-1.5">
            <Spinner className="size-3" />
            {t('about.updates.checking')}
          </span>
        )
        break
      case 'downloading':
        text = (
          <span className="flex w-56 flex-col gap-1.5">
            <span className="flex justify-between tabular">
              {t('about.updates.downloading', { version: state.version })}
              <span className="text-muted-foreground">{Math.round(state.percent)}%</span>
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
            <span className="text-destructive">{t('about.updates.failed')}</span>
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
    <div className="flex min-h-[28px] items-center gap-6">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {label}
        <span className="text-xs leading-normal text-muted-foreground">{text}</span>
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
