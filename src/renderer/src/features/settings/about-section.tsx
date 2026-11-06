import { useState, type ReactNode } from 'react'
import { CheckIcon, ExternalLinkIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AppInfo } from '@shared/ipc'
import type { SettingsFile } from '@shared/settings'
import { releaseUrl, type UpdateStatus } from '@shared/updates'
import { BrandIcon } from '@renderer/components/brand'
import { useRefresh } from '@renderer/components/refresh'
import { RefreshIcon } from '@renderer/components/refresh-icon'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { Progress } from '@renderer/components/ui/progress'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { mediumAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useHostContext } from '@renderer/lib/host-features'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useSettingsStore } from '@renderer/stores/settings'
import { checkForUpdates, useUpdatesStore } from '@renderer/stores/updates'
import { ControlError, GROUP_ACTION, ROW_BUTTON, SettingSelect } from './controls'
import { FlashMark, PageHeader } from './rows'
import { useApply } from './use-apply'

const SOURCE_URL = 'https://github.com/KettuAI/Kettu'

// GitHub mark: Octicons mark-github, https://github.com/primer/octicons (MIT), Copyright (c) GitHub Inc.
const GITHUB_MARK =
  'M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656'

/**
 * The top of the About page: its title, then a card with Kettu's icon, name, line, version and
 * system, which a bug report asks for, and the way to the repository.
 */
export function AboutHero({ info }: { info: AppInfo | null }) {
  const { t } = useTranslation('settings')
  return (
    <>
      <PageHeader id="settings-about" title={t('sections.about')}>
        {t('pages.about')}
      </PageHeader>
      <div className="mt-3.5 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-card bg-subtle px-4.5 py-4">
        <BrandIcon size={52} />
        <div className="flex min-w-0 flex-[1_1_240px] flex-col">
          <span className="font-display text-app-name font-bold">Kettu</span>
          <p className="mt-0.5 text-group text-pretty text-secondary">
            {t('about.version.description')}
          </p>
          {info ? (
            <p data-selectable="" className="mt-1.5 text-group text-tertiary tabular">
              {t('about.version.line', { version: info.version, system: info.system })}
            </p>
          ) : (
            <Skeleton className="mt-2 h-3.5 w-44" />
          )}
        </div>
        <span data-setting-row="github" className="relative">
          <FlashMark id="github" />
          <a
            href={SOURCE_URL}
            target="_blank"
            rel="noreferrer"
            className={cn(buttonVariants({ variant: 'outline' }), ROW_BUTTON, 'relative')}
          >
            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden data-icon="inline-start">
              <path d={GITHUB_MARK} />
            </svg>
            {t('about.github.name')}
            <ExternalLinkIcon data-icon="inline-end" />
          </a>
        </span>
      </div>
    </>
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
      <div className="flex items-center gap-4">
        <span className="min-w-0 flex-1 text-label leading-[normal]">
          {t('about.updates.name')}
        </span>
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
      className={cn(buttonVariants({ variant: 'ghost' }), GROUP_ACTION)}
    >
      {t('about.updates.whatsNew')}
    </a>
  )
  // While a check runs the button stays, busy, so the row does not change shape.
  const check = (
    <Button
      className={ROW_BUTTON}
      variant="outline"

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
          detail = t('about.updates.checkedAgo', { ago: mediumAgo(state.checkedAt, now) })
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
      detail = t('about.updates.readyDetail')
      action = (
        <>
          {whatsNew(state.version)}
          <Button className={ROW_BUTTON} onClick={() => run(window.kettu.updates.restart)}>
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
            <Button className={ROW_BUTTON} onClick={() => run(window.kettu.updates.download)}>
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
        <Button className={ROW_BUTTON} variant="outline" onClick={() => run(checkForUpdates)}>
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
    <div className="flex items-center gap-x-7 gap-y-3">
      <div className="flex min-w-0 flex-[1_1_280px] flex-col">
        <span className="flex items-center gap-1.75 text-label leading-[normal]">{title}</span>
        {detail && (
          <span className="mt-0.75 text-group leading-normal text-tertiary">{detail}</span>
        )}
      </div>
      <ControlError error={error} />
      {action && <span className="flex shrink-0 items-center gap-2">{action}</span>}
    </div>
  )
}

/** The updates row on a host whose Kettu is not updated from Settings, as the daemon's. */
export function NoUpdates() {
  const { t } = useTranslation('settings')
  const onHost = useHostContext()
  return (
    <div className="flex flex-col">
      <span className="text-label leading-[normal]">{t('about.updates.none', onHost)}</span>
      <span className="mt-0.75 text-group leading-normal text-tertiary">
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
        className="w-57.5"
      />
    </>
  )
}
