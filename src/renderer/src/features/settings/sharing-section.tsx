// Settings › Sharing: the Cloudflare account main publishes with, and the pages it has published.

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { CheckIcon, CircleAlertIcon, GlobeIcon, LockIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  CLOUDFLARE_DASHBOARD_URL,
  CLOUDFLARE_FREE_WORKERS,
  CLOUDFLARE_TOKEN,
  CLOUDFLARE_TOKENS_URL,
  type CloudflareAccountChoice,
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
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
import { CONFIRM, ControlError, FIELD_LABEL, Masked } from './controls'
import { RowLine, RowText } from './rows'

type Failure = Extract<SharingResult, { failed: string }>

const LINK =
  'rounded-sm underline decoration-border-strong underline-offset-2 outline-none hover:decoration-current focus-ring'

/** A token pasted into the empty field connects by itself when it carries Cloudflare's prefix. */
const PASTED_TOKEN = /^cf(?:ut|at)_/

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

/** The API token, checked with Cloudflare before the account it reaches is kept. */
function ConnectForm({ focus }: { focus: boolean }) {
  const { t } = useTranslation(['settings', 'artifacts'])
  const hidden = useSettingsStore((s) => s.settings.privacy.hideAccount)
  const [token, setToken] = useState('')
  const [checking, setChecking] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [accounts, setAccounts] = useState<CloudflareAccountChoice[] | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  const tokenField = useRef<HTMLInputElement>(null)
  const accountTrigger = useRef<HTMLButtonElement>(null)
  const secret = token.trim()
  const refused = failure?.failed === 'invalid_token'

  useEffect(() => {
    if (focus) tokenField.current?.focus()
  }, [focus])

  useEffect(() => {
    if (accounts) accountTrigger.current?.focus()
  }, [accounts])

  const connect = async (accountId: string | null): Promise<void> => {
    if (!secret || checking) return
    await tryToken(secret, accountId)
  }

  // A paste connects with the pasted text, since the field's value has not caught up yet.
  const connectWith = (pasted: string): Promise<void> => tryToken(pasted, null)

  const tryToken = async (value: string, accountId: string | null): Promise<void> => {
    // Cloudflare would refuse a token no header can carry, so it is refused here the same way.
    if (!CLOUDFLARE_TOKEN.test(value)) {
      setFailure({ failed: 'invalid_token', message: null })
      return
    }
    setChecking(true)
    setFailure(null)
    const result = await connectSharing(value, accountId)
    setChecking(false)
    if ('failed' in result) {
      setFailure(result)
      return
    }
    if ('accounts' in result) {
      setAccounts(result.accounts)
      setChosen(null)
    }
  }

  const edit = (value: string): void => {
    setToken(value)
    setFailure(null)
    setAccounts(null)
    setChosen(null)
  }

  return (
    <form
      className="pl-1"
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        void connect(chosen)
      }}
    >
      <div className="flex flex-col gap-3 py-2.5">
        <RowText name={t('sharing.account.name')} description={t('sharing.account.description')} />
        <label className={FIELD_LABEL}>
          {t('sharing.account.token')}
          <Input
            ref={tokenField}
            type="password"
            value={token}
            placeholder={t('sharing.account.tokenPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            disabled={checking}
            aria-invalid={refused || undefined}
            className="h-8 text-small md:text-small"
            onChange={(event) => edit(event.target.value)}
            onPaste={(event) => {
              const pasted = event.clipboardData.getData('text').trim()
              // The prefix keeps a password pasted by mistake from being sent to Cloudflare.
              if (token !== '' || !PASTED_TOKEN.test(pasted) || !CLOUDFLARE_TOKEN.test(pasted)) {
                return
              }
              event.preventDefault()
              setToken(pasted)
              void connectWith(pasted)
            }}
          />
        </label>
        <a
          href={CLOUDFLARE_TOKENS_URL}
          target="_blank"
          rel="noreferrer"
          className={cn('self-start text-xs text-secondary', LINK)}
        >
          {t('sharing.account.createToken')}
        </a>
        {accounts && (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-secondary">
              {t('sharing.account.account')}
            </span>
            <Select
              value={chosen}
              items={accounts.map((account) => ({ value: account.id, label: account.name }))}
              disabled={checking}
              onValueChange={(next) => {
                if (next === null || next === chosen) return
                setChosen(next)
                void connect(next)
              }}
            >
              <SelectTrigger
                ref={accountTrigger}
                aria-label={t('sharing.account.account')}
                className="h-8 w-full"
              >
                <SelectValue placeholder={t('sharing.account.choose')}>
                  {(current: string | null) => {
                    const picked = accounts.find((account) => account.id === current)
                    if (!picked) return t('sharing.account.choose')
                    return (
                      <>
                        <Masked revealable={false}>{picked.name}</Masked>
                        <span
                          className={cn(
                            'text-meta text-tertiary',
                            picked.subdomain !== null && 'font-mono',
                          )}
                        >
                          {picked.subdomain === null
                            ? t('sharing.account.noSubdomain')
                            : `${picked.subdomain}.workers.dev`}
                        </span>
                      </>
                    )
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent align="start">
                <SelectGroup>
                  {accounts.map((account) => {
                    const hint =
                      account.subdomain === null
                        ? t('sharing.account.noSubdomain')
                        : `${account.subdomain}.workers.dev`
                    return (
                      <SelectItem
                        key={account.id}
                        value={account.id}
                        aria-label={`${hidden ? t('agents.hidden') : account.name} ${hint}`}
                      >
                        <Masked revealable={false}>{account.name}</Masked>
                        <span
                          className={cn(
                            'text-meta text-tertiary',
                            account.subdomain !== null && 'font-mono',
                          )}
                        >
                          {hint}
                        </span>
                      </SelectItem>
                    )
                  })}
                </SelectGroup>
              </SelectContent>
            </Select>
            <span className="text-xs text-tertiary">{t('sharing.account.chooseHint')}</span>
          </div>
        )}
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
          disabled={!secret || checking || (accounts !== null && chosen === null)}
          className="ml-auto min-w-26"
        >
          {checking && <Spinner data-icon="inline-start" className="size-3.5" />}
          {t(checking ? 'sharing.account.checking' : 'sharing.account.connect')}
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
            <AlertDialogDescription>
              {t('artifacts:share.unpublishDescription')}
            </AlertDialogDescription>
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
