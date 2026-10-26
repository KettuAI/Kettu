// Settings › Sharing: the Cloudflare account main publishes with, and the pages it has published.

import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { CheckIcon, CircleAlertIcon, GlobeIcon, LockIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_DASHBOARD_URL,
  CLOUDFLARE_FREE_WORKERS,
  CLOUDFLARE_TOKEN,
  CLOUDFLARE_TOKENS_URL,
  type PublishedArtifact,
  type SharingResult,
} from '@shared/sharing'
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
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Spinner } from '@renderer/components/ui/spinner'
import { toast } from '@renderer/components/ui/toast'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { longAgo } from '@renderer/lib/format'
import { isMac, isWindows } from '@renderer/lib/platform'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useSettingsStore } from '@renderer/stores/settings'
import {
  connectSharing,
  removeSharing,
  unpublishArtifact,
  useSharingStore,
} from '@renderer/stores/sharing'
import { CONFIRM, ControlError, Masked } from './controls'
import { RowLine, RowText } from './rows'

type Failure = Extract<SharingResult, { failed: string }>

const LINK =
  'rounded-sm underline decoration-border-strong underline-offset-2 outline-none hover:decoration-current focus-ring'

/** The connected account: its ID, its subdomain, and Remove; the form to connect one without it. */
export function SharingAccount() {
  const { t } = useTranslation(['settings', 'common', 'artifacts'])
  const account = useSharingStore((s) => s.status?.cloudflare ?? null)
  const hidden = useSettingsStore((s) => s.settings.privacy.hideAccount)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  // The Remove button goes with the account, so the form's first field takes the focus.
  const [removed, setRemoved] = useState(false)
  const remove = async (): Promise<void> => {
    setBusy(true)
    setFailure(null)
    const result = await removeSharing()
    setBusy(false)
    if ('failed' in result) {
      setFailure(result)
      return
    }
    setRemoved(true)
    toast(t('sharing.account.removed'))
  }
  if (!account) return <ConnectForm focus={removed} />
  return (
    <div className="pl-1">
      <RowLine
        text={
          <RowText
            name={t('sharing.account.name')}
            description={
              <>
                {/* The ID gives way first, so the subdomain stays whole. */}
                <span className="flex min-w-0 whitespace-nowrap">
                  <span className="min-w-0 truncate" title={hidden ? undefined : account.accountId}>
                    <Masked>{account.accountId}</Masked>
                  </span>
                  <span className="whitespace-pre">{' · '}</span>
                  <span dir="ltr" className="shrink-0 font-mono">
                    {account.subdomain}.workers.dev
                  </span>
                </span>
                {account.plainText && (
                  <span className="mt-1 block">{t('sharing.account.plainText')}</span>
                )}
              </>
            }
          />
        }
      >
        {failure && (
          <ControlError
            error={t(`artifacts:share.failures.${failure.failed}`, {
              count: CLOUDFLARE_FREE_WORKERS,
            })}
          />
        )}
        <Badge variant="success">
          <CheckIcon />
          {t('sharing.account.connected')}
        </Badge>
        <Button
          variant="quiet"
          size="sm"
          className="text-secondary"
          disabled={busy}
          onClick={() => setAsking(true)}
        >
          {busy && <Spinner data-icon="inline-start" className="size-3.5" />}
          {t('sharing.account.remove')}
        </Button>
      </RowLine>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent className={CONFIRM}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('sharing.account.removeTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('sharing.account.removeBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setAsking(false)
                void remove()
              }}
            >
              {t('sharing.account.remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** The account ID and token, checked with Cloudflare before they are kept. */
function ConnectForm({ focus }: { focus: boolean }) {
  const { t } = useTranslation(['settings', 'artifacts'])
  const [accountId, setAccountId] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [badId, setBadId] = useState(false)
  const idField = useRef<HTMLInputElement>(null)
  const hintId = useId()
  const id = accountId.trim().toLowerCase()
  const secret = token.trim()
  const refused = failure?.failed === 'invalid_token'

  useEffect(() => {
    if (focus) idField.current?.focus()
  }, [focus])

  const connect = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!id || !secret || busy) return
    if (!CLOUDFLARE_ACCOUNT_ID.test(id)) {
      setBadId(true)
      idField.current?.focus()
      return
    }
    // Cloudflare would refuse a token no header can carry, so it is refused here the same way.
    if (!CLOUDFLARE_TOKEN.test(secret)) {
      setFailure({ failed: 'invalid_token', message: null })
      return
    }
    setBusy(true)
    setFailure(null)
    const result = await connectSharing(id, secret)
    setBusy(false)
    if ('failed' in result) setFailure(result)
  }

  return (
    <form className="pl-1" onSubmit={(event) => void connect(event)}>
      <div className="flex flex-col gap-3 py-2.5">
        <RowText name={t('sharing.account.name')} description={t('sharing.account.description')} />
        <div className="grid grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] gap-x-3 gap-y-1.5">
          <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-secondary">
            {t('sharing.account.id')}
            <Input
              ref={idField}
              value={accountId}
              placeholder={t('sharing.account.idPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              aria-invalid={badId || undefined}
              aria-describedby={hintId}
              className="h-8 font-mono text-code md:text-code"
              onChange={(event) => {
                setAccountId(event.target.value)
                setBadId(false)
                setFailure(null)
              }}
              onBlur={() => setBadId(id !== '' && !CLOUDFLARE_ACCOUNT_ID.test(id))}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-secondary">
            {t('sharing.account.token')}
            <Input
              type="password"
              value={token}
              placeholder={t('sharing.account.tokenPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              aria-invalid={refused || undefined}
              className="h-8 text-small md:text-small"
              onChange={(event) => {
                setToken(event.target.value)
                setFailure(null)
              }}
            />
          </label>
          <span id={hintId} className={cn('text-xs', badId ? 'text-danger' : 'text-tertiary')}>
            {t(badId ? 'sharing.account.idInvalid' : 'sharing.account.idHint')}
          </span>
          <a
            href={CLOUDFLARE_TOKENS_URL}
            target="_blank"
            rel="noreferrer"
            className={cn('justify-self-start text-xs text-secondary', LINK)}
          >
            {t('sharing.account.createToken')}
          </a>
        </div>
        {failure && <FailureBox failure={failure} />}
      </div>
      <div className="relative flex min-h-13 items-center gap-4 before:absolute before:top-0 before:-right-3 before:left-0 before:h-(--hairline) before:bg-border-soft">
        {(isMac || isWindows) && (
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-tertiary">
            <LockIcon className="size-3.5 shrink-0" />
            {t('sharing.account.kept')}
          </span>
        )}
        <Button
          type="submit"
          size="sm"
          disabled={!id || !secret || busy}
          className="ml-auto min-w-26"
        >
          {busy && <Spinner data-icon="inline-start" className="size-3.5" />}
          {t(busy ? 'sharing.account.checking' : 'sharing.account.connect')}
        </Button>
      </div>
    </form>
  )
}

/** What a failed connect says, and where to fix it. */
function FailureBox({ failure }: { failure: Failure }) {
  const { t } = useTranslation(['settings', 'artifacts'])
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-code bg-danger-tint px-3 py-2.5 text-command text-danger"
    >
      <CircleAlertIcon className="mt-0.75 size-3.5 shrink-0" />
      <span className="min-w-0">
        {failure.failed === 'invalid_token'
          ? t('sharing.account.refused')
          : t(`artifacts:share.failures.${failure.failed}`, { count: CLOUDFLARE_FREE_WORKERS })}
        {failure.failed === 'no_subdomain' && (
          <>
            {' '}
            <a href={CLOUDFLARE_DASHBOARD_URL} target="_blank" rel="noreferrer" className={LINK}>
              {t('sharing.account.dashboard')}
            </a>
          </>
        )}
      </span>
    </div>
  )
}

/** One published page: its artifact, its URL, the version it shows, and Unpublish. */
export function PublishedRow({ page, title }: { page: PublishedArtifact; title?: string }) {
  const { t } = useTranslation(['settings', 'artifacts', 'common'])
  const now = useNow()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const unpublish = async (): Promise<void> => {
    setBusy(true)
    setFailure(null)
    const result = await unpublishArtifact(page.id)
    setBusy(false)
    if ('failed' in result) setFailure(result)
    else toast(t('sharing.published.unpublished'))
  }
  const link = (
    <a
      href={page.url}
      target="_blank"
      rel="noreferrer"
      dir="ltr"
      className={cn('block truncate font-mono text-xs text-secondary hover:text-primary', LINK)}
    >
      {page.url}
    </a>
  )
  const button = (
    <Button
      variant="quiet"
      size="sm"
      className="text-secondary"
      disabled={busy || page.otherAccount}
      onClick={() => setAsking(true)}
    >
      {busy && <Spinner data-icon="inline-start" className="size-3.5" />}
      {t('sharing.published.unpublish')}
    </Button>
  )
  return (
    <div className="pl-1">
      <RowLine
        text={
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-subtle text-icon">
              <GlobeIcon className="size-3.5" />
            </span>
            <div className="flex min-w-0 flex-col">
              {title ? (
                <>
                  <span className="truncate text-ui font-medium">{title}</span>
                  <span className="mt-0.5 flex leading-4">{link}</span>
                </>
              ) : (
                <span className="flex">{link}</span>
              )}
              <span className="text-xs leading-4 text-secondary">
                {t('sharing.published.version', {
                  version: page.version,
                  ago: longAgo(page.publishedAt, now),
                })}
              </span>
            </div>
          </div>
        }
      >
        {failure && (
          <ControlError
            error={t(`artifacts:share.failures.${failure.failed}`, {
              count: CLOUDFLARE_FREE_WORKERS,
            })}
          />
        )}
        {page.otherAccount ? (
          <Tooltip>
            {/* A disabled button gets no pointer events, so a wrapper holds the tooltip. */}
            <TooltipTrigger render={<span className="flex" />}>{button}</TooltipTrigger>
            <TooltipContent>{t('sharing.published.otherAccount')}</TooltipContent>
          </Tooltip>
        ) : (
          button
        )}
      </RowLine>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent className={CONFIRM}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('sharing.published.unpublishTitle', { title: title ?? page.url })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('artifacts:share.unpublishConfirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setAsking(false)
                void unpublish()
              }}
            >
              {t('sharing.published.unpublish')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
