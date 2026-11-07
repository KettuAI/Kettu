// Settings › Account: the Kettu account this computer signs in to through the system browser, or
// the hosted web client in this browser.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUpRight01Icon, UserIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { AccountPlan, AccountStatus, AccountUsage } from '@shared/account'
import { Icon } from '@renderer/components/affect/app-shell'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { Spinner } from '@renderer/components/ui/spinner'
import { errorMessage } from '@renderer/lib/host'
import { currentLocale } from '@renderer/lib/i18n'
import { limitLevel } from '@renderer/lib/plan-limit'
import { useSettingsStore } from '@renderer/stores/settings'
import {
  cancelSignIn,
  checkAccount,
  signIn,
  signOut,
  useAccountStore,
} from '@renderer/stores/account'
import {
  CONFIRM,
  ControlError,
  DangerButton,
  LinkButton,
  Masked,
  Meter,
  Pill,
  SetButton,
  Skel,
  Spin,
} from './controls'
import { subscriptionLabel } from './subscription-label'

type SignedIn = Extract<AccountStatus, { state: 'signed-in' }>

/** The account row; it reads the account again when it shows and when the window comes back. */
export function AccountRow() {
  const status = useAccountStore((s) => s.status)
  const row = useRef<HTMLDivElement>(null)
  // A click that swaps the row's buttons hands the focus to the next one.
  const moveFocus = useRef(false)
  const state = status?.state ?? null

  useEffect(() => {
    void checkAccount()
    const onFocus = (): void => void checkAccount()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  useLayoutEffect(() => {
    if (!moveFocus.current) return
    moveFocus.current = false
    row.current?.querySelector<HTMLElement>('[data-account-action]')?.focus()
  }, [state])

  const act = (action: () => Promise<void>) => () => {
    moveFocus.current = true
    return action()
  }

  let content: ReactNode
  if (!status)
    content = (
      <div className="ui-sg-row">
        <Skel width="60%" />
      </div>
    )
  else if (status.state === 'signed-in') {
    content = <SignedInRow status={status} onSignOut={act(signOut)} />
  } else if (status.state === 'signing-in') {
    content = <SigningInRow onCancel={act(cancelSignIn)} />
  } else content = <SignedOutRow status={status} onSignIn={act(signIn)} />
  return <div ref={row}>{content}</div>
}

function RowFrame({
  tile,
  name,
  line,
  children,
}: {
  tile: ReactNode
  name: ReactNode
  line: ReactNode
  children: ReactNode
}) {
  return (
    <div className="ui-sg-row k-account">
      <span className="k-thing">
        {tile}
        <span className="ui-sg-label">
          <b>{name}</b>
          <small>{line}</small>
        </span>
      </span>
      <span className="ui-sg-control">{children}</span>
    </div>
  )
}

const ACCOUNT_TILE = (
  <span className="k-avatar" aria-hidden>
    <Icon icon={UserIcon} size={16} />
  </span>
)

function SignedOutRow({
  status,
  onSignIn,
}: {
  status: Extract<AccountStatus, { state: 'signed-out' }>
  onSignIn: () => void
}) {
  const { t } = useTranslation('settings')
  const { reason, failure } = status
  const line = reason
    ? t(`account.reasons.${reason}`)
    : failure
      ? t(`account.failures.${failure}`)
      : t('account.description')
  return (
    <RowFrame tile={ACCOUNT_TILE} name={t('account.name')} line={line}>
      {reason && <Pill tone="warning">{t('account.signedOut')}</Pill>}
      {!reason && failure && <Pill tone="warning">{t('account.notSignedIn')}</Pill>}
      {status.devicesUrl && (
        <LinkButton href={status.devicesUrl} icon={<Icon icon={ArrowUpRight01Icon} size={14} />}>
          {t('account.devices.manage')}
        </LinkButton>
      )}
      <SetButton variant="primary" data-account-action="" onClick={onSignIn}>
        {t('account.signIn')}
      </SetButton>
    </RowFrame>
  )
}

function SigningInRow({ onCancel }: { onCancel: () => void }) {
  const { t } = useTranslation('settings')
  return (
    <RowFrame tile={ACCOUNT_TILE} name={t('account.name')} line={t('account.waitingHint')}>
      <span className="k-end k-muted">
        <Spin />
        {t('account.waiting')}
      </span>
      <SetButton variant="ghost" data-account-action="" onClick={onCancel}>
        {t('account.cancel')}
      </SetButton>
    </RowFrame>
  )
}

function SignedInRow({ status, onSignOut }: { status: SignedIn; onSignOut: () => Promise<void> }) {
  const { t } = useTranslation('settings')
  const hidden = useSettingsStore((s) => s.settings.privacy.hideAccount)
  const [busy, setBusy] = useState(false)
  const { account } = status
  const initial = (account.name ?? account.email).trim().charAt(0).toUpperCase()
  // A face or a letter tells who it is, so hiding accounts hides them too.
  const tile = (
    <span className="k-avatar" aria-hidden>
      {hidden ? <Icon icon={UserIcon} size={16} /> : initial}
      {account.avatar && !hidden && <img src={account.avatar} alt="" />}
    </span>
  )
  return (
    <RowFrame
      tile={tile}
      name={<Masked>{account.name ?? account.email}</Masked>}
      line={account.name ? <Masked>{account.email}</Masked> : t('account.name')}
    >
      <LinkButton href={status.manageUrl} icon={<Icon icon={ArrowUpRight01Icon} size={14} />}>
        {t('account.manage')}
      </LinkButton>
      <SetButton
        data-account-action=""
        loading={busy}
        onClick={() => {
          setBusy(true)
          void onSignOut().finally(() => setBusy(false))
        }}
      >
        {t('account.signOut')}
      </SetButton>
      {window.kettu.account.signOutAndClear && <SignOutAndClear />}
    </RowFrame>
  )
}

/** The hosted web client's way out on a shared computer, after a confirm saying what goes. */
function SignOutAndClear() {
  const { t } = useTranslation(['settings', 'common'])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.kettu.account.signOutAndClear?.()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <>
      <ControlError error={open ? null : error} />
      <DangerButton onClick={() => setOpen(true)}>{t('account.clear.button')}</DangerButton>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent className={CONFIRM}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('account.clear.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('account.clear.body')}</AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p className="text-xs text-danger">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void run()}>
              {busy && <Spinner data-icon="inline-start" />}
              {t('account.clear.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** The subscription's status in words; one this version does not know shows as the service names it. */
export function SubscriptionState({ status }: { status: string }) {
  const { t } = useTranslation('settings')
  const label = subscriptionLabel(status)
  return <Pill>{label ? t(label) : status}</Pill>
}

/** The plan's name, as the service names it in the app's language. */
export function PlanName({ plan }: { plan: AccountPlan }) {
  return <Pill>{plan.name}</Pill>
}

// 1024-based, so a plan's 1 GiB reads 1 GB, as it is sold.
const STORAGE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

function storageSize(n: number): string {
  let value = n
  let unit = 0
  while (value >= 1024 && unit < STORAGE_UNITS.length - 1) {
    value /= 1024
    unit++
  }
  const number = new Intl.NumberFormat(currentLocale(), {
    maximumFractionDigits: unit === 0 ? 0 : 1,
  })
  return `${number.format(value)} ${STORAGE_UNITS[unit]}`
}

function UsageMeter({
  used,
  limit,
  text,
  label,
}: {
  used: number
  limit: number
  text: string
  label: string
}) {
  const share = limit > 0 ? (used / limit) * 100 : used > 0 ? 100 : 0
  const level = limitLevel({
    usedPercent: share,
    state: used >= limit && limit > 0 ? 'reached' : 'ok',
  })
  return <Meter value={share} level={level} text={text} label={label} />
}

/** The signed-in clients against the plan's limit; more than it after a downgrade. */
export function DeviceUsage({ plan, usage }: { plan: AccountPlan; usage: AccountUsage }) {
  const { t } = useTranslation('settings')
  const text = t('account.devices.used', { used: usage.devices, limit: plan.maxDevices })
  return (
    <UsageMeter
      used={usage.devices}
      limit={plan.maxDevices}
      text={text}
      label={t('account.devices.name')}
    />
  )
}

export function StorageUsage({ plan, usage }: { plan: AccountPlan; usage: AccountUsage }) {
  const { t } = useTranslation('settings')
  const text = t('account.storage.used', {
    used: storageSize(usage.storageBytes),
    limit: storageSize(plan.storageBytes),
  })
  return (
    <UsageMeter
      used={usage.storageBytes}
      limit={plan.storageBytes}
      text={text}
      label={t('account.storage.name')}
    />
  )
}

/** Under the account: what works without one. */
export function AccountNote() {
  const { t } = useTranslation('settings')
  return <p className="ui-sg-hint">{t('account.note')}</p>
}
