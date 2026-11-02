// Settings › Account: the Kettu account this computer signs in to through the system browser.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { CircleAlertIcon, ExternalLinkIcon, LogOutIcon, UserRoundIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AccountStatus } from '@shared/account'
import { Avatar, AvatarFallback, AvatarImage } from '@renderer/components/ui/avatar'
import { Badge } from '@renderer/components/ui/badge'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { useSettingsStore } from '@renderer/stores/settings'
import {
  cancelSignIn,
  checkAccount,
  signIn,
  signOut,
  useAccountStore,
} from '@renderer/stores/account'
import { Masked, Pill, ROW_BUTTON } from './controls'
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
  if (!status) content = <Skeleton className="my-3 h-9 w-full rounded-lg" />
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
    <div className="flex items-center gap-3.5 py-4.5">
      {tile}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-label leading-tight font-medium">{name}</span>
        <span className="text-group leading-normal text-pretty text-tertiary">{line}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

const ACCOUNT_TILE = (
  <span className="grid size-10 shrink-0 place-items-center rounded-full bg-selected text-secondary">
    <UserRoundIcon className="size-4.5" />
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
      {reason && (
        <Badge variant="warning">
          <LogOutIcon />
          {t('account.signedOut')}
        </Badge>
      )}
      {!reason && failure && (
        <Badge variant="error">
          <CircleAlertIcon />
          {t('account.notSignedIn')}
        </Badge>
      )}
      <Button className={ROW_BUTTON} data-account-action="" onClick={onSignIn}>
        {t('account.signIn')}
      </Button>
    </RowFrame>
  )
}

function SigningInRow({ onCancel }: { onCancel: () => void }) {
  const { t } = useTranslation('settings')
  return (
    <RowFrame tile={ACCOUNT_TILE} name={t('account.name')} line={t('account.waitingHint')}>
      <Badge variant="neutral">
        <Spinner />
        {t('account.waiting')}
      </Badge>
      <Button variant="ghost" className={ROW_BUTTON} data-account-action="" onClick={onCancel}>
        {t('account.cancel')}
      </Button>
    </RowFrame>
  )
}

function SignedInRow({ status, onSignOut }: { status: SignedIn; onSignOut: () => Promise<void> }) {
  const { t } = useTranslation('settings')
  const hidden = useSettingsStore((s) => s.settings.privacy.hideAccount)
  const [busy, setBusy] = useState(false)
  const { account } = status
  const initial = (account.name ?? account.email).trim().charAt(0).toUpperCase()
  const tile = (
    <Avatar aria-hidden className="size-10 after:border-transparent">
      {/* A face or a letter tells who it is, so hiding accounts hides them too. */}
      {account.avatar && !hidden && <AvatarImage src={account.avatar} alt="" />}
      <AvatarFallback className="bg-selected text-subheading font-semibold text-secondary">
        {hidden ? <UserRoundIcon className="size-4.5" /> : initial}
      </AvatarFallback>
    </Avatar>
  )
  return (
    <RowFrame
      tile={tile}
      name={<Masked>{account.name ?? account.email}</Masked>}
      line={account.name ? <Masked>{account.email}</Masked> : t('account.name')}
    >
      <a
        href={status.manageUrl}
        target="_blank"
        rel="noreferrer"
        className={buttonVariants({ variant: 'outline', className: ROW_BUTTON })}
      >
        <ExternalLinkIcon data-icon="inline-start" className="size-3.5" />
        {t('account.manage')}
      </a>
      <Button
        variant="ghost"
        className={ROW_BUTTON}
        data-account-action=""
        disabled={busy}
        onClick={() => {
          setBusy(true)
          void onSignOut().finally(() => setBusy(false))
        }}
      >
        {busy && <Spinner data-icon="inline-start" className="size-3.5" />}
        {t('account.signOut')}
      </Button>
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
  return (
    <p className="mt-7 rounded-2xl bg-subtle px-4 py-3.5 text-group leading-normal text-secondary">
      {t('account.note')}
    </p>
  )
}
