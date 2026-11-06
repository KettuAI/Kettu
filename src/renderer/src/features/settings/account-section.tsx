// Settings › Account: the Kettu account this computer signs in to through the system browser.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUpRight01Icon, UserIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { AccountStatus } from '@shared/account'
import { Icon } from '@renderer/components/affect/app-shell'
import { useSettingsStore } from '@renderer/stores/settings'
import {
  cancelSignIn,
  checkAccount,
  signIn,
  signOut,
  useAccountStore,
} from '@renderer/stores/account'
import { LinkButton, Masked, Pill, SetButton, Skel, Spin } from './controls'
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
    </RowFrame>
  )
}

/** The subscription's status in words; one this version does not know shows as the service names it. */
export function SubscriptionState({ status }: { status: string }) {
  const { t } = useTranslation('settings')
  const label = subscriptionLabel(status)
  return <Pill>{label ? t(label) : status}</Pill>
}

/** Under the account: what works without one. */
export function AccountNote() {
  const { t } = useTranslation('settings')
  return <p className="ui-sg-hint">{t('account.note')}</p>
}
