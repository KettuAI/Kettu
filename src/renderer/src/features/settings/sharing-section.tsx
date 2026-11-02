// Settings › Sharing: the Cloudflare account main publishes with, and the pages it has published.

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { CircleAlertIcon, GlobeIcon, LockIcon, ShapesIcon, ShareIcon } from 'lucide-react'
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
import { Button } from '@renderer/components/ui/button'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@renderer/components/ui/empty'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { toast } from '@renderer/components/ui/toast'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { longAgo } from '@renderer/lib/format'
import { useHostContext } from '@renderer/lib/host-features'
import { hostPlatform } from '@renderer/lib/platform'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useHostScope } from '@renderer/stores/host-scope'
import {
  CONFIRM,
  ControlError,
  FIELD_LABEL,
  GROUP_ACTION,
  Masked,
  Pill,
  ROW_BUTTON,
  ROW_FIELD,
} from './controls'
import { DeviceTile } from './remote-parts'
import { ItemLine, RowText } from './rows'

type Failure = Extract<SharingResult, { failed: string }>

const LINK =
  'rounded-sm underline decoration-border-strong underline-offset-2 outline-none hover:decoration-current focus-ring'

/** A token pasted into the empty field connects by itself when it carries Cloudflare's prefix. */
const PASTED_TOKEN = /^cf(?:ut|at)_/

/** In place of the account and the pages, on a host that publishes nothing, as the daemon. */
export function NoSharing() {
  const { t } = useTranslation('settings')
  const host = useHostContext().host ?? ''
  return (
    <Empty className="px-6 py-14">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ShareIcon />
        </EmptyMedia>
        <EmptyTitle>{t('sharing.none.title')}</EmptyTitle>
        <EmptyDescription>{t('sharing.none.body', { host })}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

/** The account's place while the web client has not heard whether its host publishes. */
export function SharingPending() {
  return <Skeleton className="h-15 w-full rounded-xl" />
}

/** The connected account: its ID, its subdomain, and Remove; the form to connect one without it. */
export function SharingAccount() {
  const { sharing, useSettingsStore } = useHostScope()
  const { t } = useTranslation(['settings', 'common', 'artifacts'])
  const account = sharing.useSharingStore((s) => s.status?.cloudflare ?? null)
  const hidden = useSettingsStore((s) => s.settings.privacy.hideAccount)
  const onHost = useHostContext()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  // The Remove button goes with the account, so the form's first field takes the focus.
  const [removed, setRemoved] = useState(false)
  const remove = async (): Promise<void> => {
    setBusy(true)
    setFailure(null)
    const result = await sharing.remove()
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
    <div className="flex items-center gap-3.5 py-4">
      <span
        aria-hidden
        className="grid size-8.5 shrink-0 place-items-center rounded-segments bg-(--brand-cloudflare) text-(--on-fill)"
      >
        <GlobeIcon className="size-4.25" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2 text-label leading-[normal]">
          <span
            dir="ltr"
            className="truncate font-mono text-[length:inherit]"
            title={hidden ? undefined : account.accountId}
          >
            {account.subdomain}.workers.dev
          </span>
          <Pill tone="success">{t('sharing.account.connected')}</Pill>
        </span>
        <ItemLine>
          {account.plainText
            ? t('sharing.account.plainText')
            : t('sharing.account.keptConnected', onHost)}
        </ItemLine>
      </div>
      {failure && (
        <ControlError
          error={t(`artifacts:share.failures.${failure.failed}`, {
            count: CLOUDFLARE_FREE_WORKERS,
          })}
        />
      )}
      <Button
        variant="ghost"
        className={GROUP_ACTION}
        disabled={busy}
        onClick={() => setAsking(true)}
      >
        {busy && <Spinner data-icon="inline-start" className="size-3.5" />}
        {t('sharing.account.remove')}
      </Button>
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
  const { sharing, useSettingsStore } = useHostScope()
  const { t } = useTranslation(['settings', 'artifacts'])
  const onHost = useHostContext()
  // The token is kept on the host, encrypted where its system has a keyring.
  const keyring = ['darwin', 'win32'].includes(hostPlatform())
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
    const result = await sharing.connect(value, accountId)
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
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        void connect(chosen)
      }}
    >
      <div className="flex flex-col gap-3 pt-3.75 pb-3">
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
            className={cn(ROW_FIELD, 'md:text-lede')}
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
          className={cn('self-start text-hint text-secondary', LINK)}
        >
          {t('sharing.account.createToken')}
        </a>
        {accounts && (
          <div className="flex flex-col gap-1.5">
            <span className="text-control font-medium text-primary">
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
            <span className="text-hint text-tertiary">{t('sharing.account.chooseHint')}</span>
          </div>
        )}
        {failure && <FailureBox failure={failure} />}
      </div>
      <div className="flex items-center gap-4 pb-3.75">
        {keyring && (
          <span className="flex min-w-0 items-center gap-1.5 text-hint text-tertiary">
            <LockIcon className="size-3.5 shrink-0" />
            {t('sharing.account.kept', onHost)}
          </span>
        )}
        <Button
          type="submit"

          disabled={!secret || checking || (accounts !== null && chosen === null)}
          className={cn(ROW_BUTTON, 'ml-auto')}
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
      className="flex items-start gap-2 rounded-segments bg-danger-tint px-3 py-2.5 text-hint text-danger"
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
  const { sharing } = useHostScope()
  const { t } = useTranslation(['settings', 'artifacts', 'common'])
  const now = useNow()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const unpublish = async (): Promise<void> => {
    setBusy(true)
    setFailure(null)
    const result = await sharing.unpublish(page.id)
    setBusy(false)
    if ('failed' in result) setFailure(result)
    else toast(t('sharing.published.unpublished'))
  }
  const copy = (): void => {
    void navigator.clipboard.writeText(page.url).then(() => toast(t('sharing.published.copied')))
  }
  const button = (
    <Button
      variant="ghost"
      className={GROUP_ACTION}
      disabled={busy || page.otherAccount}
      onClick={() => setAsking(true)}
    >
      {busy && <Spinner data-icon="inline-start" className="size-3.5" />}
      {t('sharing.published.unpublish')}
    </Button>
  )
  const version = t('sharing.published.version', {
    version: page.version,
    ago: longAgo(page.publishedAt, now),
  })
  return (
    <div className="flex items-center gap-3.5 py-3.25">
      <DeviceTile icon={<ShapesIcon className="size-4.25" />} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-label leading-[normal]">{title ?? page.url}</span>
        <ItemLine>
          <a
            href={page.url}
            target="_blank"
            rel="noreferrer"
            dir="ltr"
            className="rounded-sm font-mono text-code leading-[normal] underline-offset-2 outline-none hover:text-primary hover:underline focus-ring"
          >
            {page.url.replace(/^https:\/\//, '')}
          </a>
          {` · ${version}`}
        </ItemLine>
      </div>
      {failure && (
        <ControlError
          error={t(`artifacts:share.failures.${failure.failed}`, {
            count: CLOUDFLARE_FREE_WORKERS,
          })}
        />
      )}
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="ghost" className={GROUP_ACTION} onClick={copy}>
          {t('sharing.published.copyLink')}
        </Button>
        {page.otherAccount ? (
          <Tooltip>
            {/* A disabled button gets no pointer events, so a wrapper holds the tooltip. */}
            <TooltipTrigger render={<span className="flex" />}>{button}</TooltipTrigger>
            <TooltipContent>{t('sharing.published.otherAccount')}</TooltipContent>
          </Tooltip>
        ) : (
          button
        )}
      </div>
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
