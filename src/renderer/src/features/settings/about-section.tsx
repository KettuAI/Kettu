import { useState, type ReactNode } from 'react'
import { GithubIcon, NewTwitterIcon, Tick02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { AppInfo } from '@shared/ipc'
import type { SettingsFile } from '@shared/settings'
import { releaseUrl, type UpdateStatus } from '@shared/updates'
import { Icon } from '@renderer/components/affect/app-shell'
import { BrandIcon } from '@renderer/components/brand'
import { useRefresh } from '@renderer/components/refresh'
import { mediumAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useHostContext } from '@renderer/lib/host-features'
import { useNow } from '@renderer/lib/use-now'
import { useSettingsStore } from '@renderer/stores/settings'
import { checkForUpdates, restartToUpdate, useUpdatesStore } from '@renderer/stores/updates'
import { AboutStarButton } from '@renderer/features/github-star/star-prompts'
import {
  ControlError,
  CopyAction,
  LinkButton,
  SetButton,
  SettingSelect,
  Skel,
  Spin,
} from './controls'
import { FlashMark, PageHeader, RowText } from './rows'
import { useApply } from './use-apply'
import { useCloudOffHere } from './use-cloud-off-here'
import { useGitHubOnly } from './use-github-only'

const SOURCE_URL = 'https://github.com/KettuAI/Kettu'
const NEW_ISSUE_URL = `${SOURCE_URL}/issues/new/choose`
const CONTACT_EMAIL = 'hello@kettu.sh'
const X_URL = 'https://x.com/KettuAI'

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
      <div className="k-about">
        <BrandIcon size={48} />
        <span className="ui-sg-label">
          <b>Kettu</b>
          <small>{t('about.version.description')}</small>
          {info ? (
            <small data-selectable="" className="k-num">
              {t('about.version.line', { version: info.version, system: info.system })}
            </small>
          ) : (
            <Skel width={176} className="k-about__skel" />
          )}
        </span>
        <span data-setting-row="github" className="k-row">
          <FlashMark id="github" />
          <LinkButton href={SOURCE_URL} icon={<Icon icon={GithubIcon} size={14} />}>
            {t('about.github.name')}
          </LinkButton>
          <AboutStarButton />
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
  const cloudOff = useCloudOffHere()
  const githubOnly = useGitHubOnly()
  const [error, setError] = useState<string | null>(null)
  const run = (action: () => Promise<unknown>) => {
    setError(null)
    action().catch((e: unknown) => setError(errorMessage(e)))
  }
  if (!status) {
    return (
      <div className="k-line">
        <RowText name={t('about.updates.name')} />
        <Spin />
      </div>
    )
  }
  const { state } = status
  const whatsNew = (version: string) => (
    <LinkButton href={releaseUrl(version)}>{t('about.updates.whatsNew')}</LinkButton>
  )
  // While a check runs the button stays, busy, so the row does not change shape.
  const check = (
    <SetButton
      loading={refresh.phase === 'turning'}
      onClick={() => {
        setError(null)
        void refresh.run(checkForUpdates).catch((e: unknown) => setError(errorMessage(e)))
      }}
    >
      {t('about.updates.check')}
    </SetButton>
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
              <span className="k-ok">
                <Icon icon={Tick02Icon} size={14} />
              </span>
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
        <span className="k-meter">
          <span
            role="progressbar"
            aria-label={t('about.updates.downloadProgress')}
            aria-valuenow={Math.round(state.percent)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="k-meter__bar k-meter__bar--long"
          >
            <span style={{ width: `${state.percent}%` }} />
          </span>
          <span className="k-num">{Math.round(state.percent)}%</span>
        </span>
      )
      break
    case 'ready': {
      const waiting = status.restartWhenIdle?.sessions ?? null
      title = t('about.updates.ready', { version: state.version })
      detail =
        waiting === null
          ? t('about.updates.readyDetail')
          : waiting > 0
            ? t('about.updates.readyWaiting', { count: waiting })
            : t('about.updates.readyWaitingSoon')
      action = (
        <>
          {whatsNew(state.version)}
          <SetButton variant="primary" onClick={restartToUpdate}>
            {t('about.updates.restart')}
          </SetButton>
        </>
      )
      break
    }
    case 'available':
      title = t('about.updates.available', { version: state.version })
      if (state.mode === 'install' && status.readOnly) detail = t('about.updates.movesFirst')
      if (state.mode === 'link') detail = t('about.updates.downloadDetail')
      action = (
        <>
          {whatsNew(state.version)}
          <SetButton variant="primary" onClick={() => run(window.kettu.updates.download)}>
            {state.mode === 'link' ? t('about.updates.download') : t('about.updates.update')}
          </SetButton>
        </>
      )
      break
    case 'moving':
      title = t('about.updates.moving')
      break
    case 'error': {
      // Only while updates still come from GitHub alone; changing the source checks again.
      const github = !!state.githubUnreachable && githubOnly
      title = state.move
        ? t('about.updates.moveFailed')
        : github
          ? t('about.updates.githubUnreachable')
          : t('about.updates.failed')
      // Local mode leaves no other source to suggest.
      detail = github ? (
        cloudOff ? (
          t('about.updates.githubUnreachableLocal')
        ) : (
          t('about.updates.githubUnreachableDetail')
        )
      ) : (
        <span data-selectable="">{state.message}</span>
      )
      action = (
        <SetButton onClick={() => run(checkForUpdates)}>{t('about.updates.tryAgain')}</SetButton>
      )
      break
    }
    case 'off':
      title =
        state.reason === 'development'
          ? t('about.updates.offDevelopment')
          : t('about.updates.offPackageManager')
  }
  // What the updater is doing is the row's name, as it is the news; the group says it is updates.
  return (
    <div className="k-line">
      <span className="ui-sg-label">
        <b className="k-row-title">{title}</b>
        {detail && <small>{detail}</small>}
      </span>
      <ControlError error={error} />
      {action && <span className="ui-sg-control">{action}</span>}
    </div>
  )
}

/** The updates row on a host whose Kettu is not updated from Settings, as the daemon's. */
export function NoUpdates() {
  const { t } = useTranslation('settings')
  const onHost = useHostContext()
  return (
    <div className="k-line">
      <RowText
        name={t('about.updates.none', onHost)}
        description={t('about.updates.noneDetail', onHost)}
      />
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
        className="k-select--wide"
      />
    </>
  )
}

type SourceChoice = SettingsFile['updates']['source']

/**
 * Where updates come from. A list rather than a switch, so more sources can join it; Local mode
 * holds it on GitHub only, since Kettu's services are off.
 */
export function DownloadSource() {
  const { t } = useTranslation('settings')
  const githubOnly = useGitHubOnly()
  const cloudOff = useCloudOffHere()
  const [apply, error] = useApply()
  const options: { value: SourceChoice; label: string }[] = [
    { value: 'auto', label: t('about.source.auto') },
    { value: 'github', label: t('about.source.github') },
  ]
  return (
    <>
      <ControlError error={error} />
      <SettingSelect
        label={t('about.source.name')}
        value={githubOnly ? 'github' : 'auto'}
        options={options}
        disabled={cloudOff}
        onChange={(v) => apply({ updates: { source: v } })}
        className="k-select--wide"
      />
    </>
  )
}

export function NewIssue() {
  const { t } = useTranslation('settings')
  return (
    <LinkButton href={NEW_ISSUE_URL} icon={<Icon icon={GithubIcon} size={14} />}>
      {t('about.issues.open')}
    </LinkButton>
  )
}

/** The address, selectable, since the app opens no mail links. */
export function ContactEmailText() {
  return <span data-selectable="">{CONTACT_EMAIL}</span>
}

export function CopyContactEmail() {
  const { t } = useTranslation('settings')
  return <CopyAction text={CONTACT_EMAIL} label={t('about.email.copy')} />
}

export function FollowOnX() {
  const { t } = useTranslation('settings')
  return (
    <LinkButton href={X_URL} icon={<Icon icon={NewTwitterIcon} size={14} />}>
      {t('about.x.open')}
    </LinkButton>
  )
}
