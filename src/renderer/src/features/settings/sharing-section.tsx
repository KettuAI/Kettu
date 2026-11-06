// Settings › Sharing: the Cloudflare account main publishes with, and the pages it has published.

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { CloudIcon, LockIcon, Share08Icon, ShapesIcon } from '@hugeicons/core-free-icons'
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
import { Icon } from '@renderer/components/affect/app-shell'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { toast } from '@renderer/components/ui/toast'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { mediumAgo } from '@renderer/lib/format'
import { useHostContext } from '@renderer/lib/host-features'
import { hostPlatform } from '@renderer/lib/platform'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useHostScope } from '@renderer/stores/host-scope'
import { CONFIRM, ControlError, Masked, Pill, SetButton, SetInput, Skel } from './controls'
import { BlockLine, ItemLine, Notice, RowText, Thing } from './rows'

type Failure = Extract<SharingResult, { failed: string }>

/** A token pasted into the empty field connects by itself when it carries Cloudflare's prefix. */
const PASTED_TOKEN = /^cf(?:ut|at)_/

/** In place of the account and the pages, on a host that publishes nothing, as the daemon. */
export function NoSharing() {
  const { t } = useTranslation('settings')
  const host = useHostContext().host ?? ''
  return (
    <div className="ui-as-empty">
      <span className="ui-as-empty__icon">
        <Icon icon={Share08Icon} size={18} />
      </span>
      <b className="ui-as-empty__title">{t('sharing.none.title')}</b>
      <p className="ui-as-empty__text">{t('sharing.none.body', { host })}</p>
    </div>
  )
}

/** The account's place while the web client has not heard whether its host publishes. */
export function SharingPending() {
  return (
    <div className="ui-sg-card k-pending">
      <div className="ui-sg-row">
        <Thing mark={<Skel width={24} className="k-skel--mark" />} name={<Skel width={160} />}>
          <Skel width={220} />
        </Thing>
      </div>
    </div>
  )
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
    <div className="ui-sg-row">
      <Thing
        mark={<Icon icon={CloudIcon} size={20} />}
        name={
          <>
            <span dir="ltr" className="k-name" title={hidden ? undefined : account.accountId}>
              {account.subdomain}.workers.dev
            </span>
            <Pill tone="success">{t('sharing.account.connected')}</Pill>
          </>
        }
      >
        <ItemLine>
          {account.plainText
            ? t('sharing.account.plainText')
            : t('sharing.account.keptConnected', onHost)}
        </ItemLine>
      </Thing>
      <span className="ui-sg-control">
        {failure && (
          <ControlError
            error={t(`artifacts:share.failures.${failure.failed}`, {
              count: CLOUDFLARE_FREE_WORKERS,
            })}
          />
        )}
        <SetButton variant="ghost" loading={busy} onClick={() => setAsking(true)}>
          {t('sharing.account.remove')}
        </SetButton>
      </span>
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
      <div className="k-block">
        <BlockLine
          text={
            <RowText
              name={t('sharing.account.name')}
              description={t('sharing.account.description')}
            />
          }
        >
          <SetInput
            ref={tokenField}
            type="password"
            value={token}
            aria-label={t('sharing.account.token')}
            placeholder={t('sharing.account.tokenPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            disabled={checking}
            aria-invalid={refused || undefined}
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
          <SetButton
            type="submit"
            variant="primary"
            loading={checking}
            disabled={!secret || (accounts !== null && chosen === null)}
          >
            {t(checking ? 'sharing.account.checking' : 'sharing.account.connect')}
          </SetButton>
        </BlockLine>
        {accounts && (
          <div className="k-field">
            <span>{t('sharing.account.account')}</span>
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
                className="ui-ss-select k-select k-select--full"
              >
                <SelectValue placeholder={t('sharing.account.choose')}>
                  {(current: string | null) => {
                    const picked = accounts.find((account) => account.id === current)
                    if (!picked) return t('sharing.account.choose')
                    return (
                      <>
                        <Masked revealable={false}>{picked.name}</Masked>
                        <span className={cn('k-muted', picked.subdomain !== null && 'k-mono')}>
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
            <span className="k-block-note">{t('sharing.account.chooseHint')}</span>
          </div>
        )}
        {failure && <FailureBox failure={failure} />}
        <div className="k-block-foot">
          <a href={CLOUDFLARE_TOKENS_URL} target="_blank" rel="noreferrer" className="k-link">
            {t('sharing.account.createToken')}
          </a>
          {keyring && (
            <span className="k-block-note k-with-icon">
              <Icon icon={LockIcon} size={13} />
              {t('sharing.account.kept', onHost)}
            </span>
          )}
        </div>
      </div>
    </form>
  )
}

/** What a failed connect says, and where to fix it. */
function FailureBox({ failure }: { failure: Failure }) {
  const { t } = useTranslation(['settings', 'artifacts'])
  return (
    <Notice
      variant="error"
      title={
        failure.failed === 'invalid_token'
          ? t('sharing.account.refused')
          : t(`artifacts:share.failures.${failure.failed}`, { count: CLOUDFLARE_FREE_WORKERS })
      }
    >
      {failure.failed === 'no_subdomain' && (
        <a href={CLOUDFLARE_DASHBOARD_URL} target="_blank" rel="noreferrer" className="k-link">
          {t('sharing.account.dashboard')}
        </a>
      )}
    </Notice>
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
    <SetButton
      variant="ghost"
      loading={busy}
      disabled={page.otherAccount}
      onClick={() => setAsking(true)}
    >
      {t('sharing.published.unpublish')}
    </SetButton>
  )
  const version = t('sharing.published.version', {
    version: page.version,
    ago: mediumAgo(page.publishedAt, now),
  })
  return (
    <div className="ui-sg-row">
      <Thing
        mark={<Icon icon={ShapesIcon} size={20} />}
        name={<span className="k-name">{title ?? page.url}</span>}
      >
        <ItemLine>
          <a href={page.url} target="_blank" rel="noreferrer" dir="ltr" className="k-link k-mono">
            {page.url.replace(/^https:\/\//, '')}
          </a>
          {` · ${version}`}
        </ItemLine>
      </Thing>
      <span className="ui-sg-control">
        {failure && (
          <ControlError
            error={t(`artifacts:share.failures.${failure.failed}`, {
              count: CLOUDFLARE_FREE_WORKERS,
            })}
          />
        )}
        <SetButton variant="ghost" onClick={copy}>
          {t('sharing.published.copyLink')}
        </SetButton>
        {page.otherAccount ? (
          <Tooltip>
            {/* A disabled button gets no pointer events, so a wrapper holds the tooltip. */}
            <TooltipTrigger render={<span className="flex" />}>{button}</TooltipTrigger>
            <TooltipContent>{t('sharing.published.otherAccount')}</TooltipContent>
          </Tooltip>
        ) : (
          button
        )}
      </span>
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
