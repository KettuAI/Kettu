// Settings › Sharing: the Cloudflare account main publishes with, and the pages it has published.

import { useState, type FormEvent } from 'react'
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
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Spinner } from '@renderer/components/ui/spinner'
import { longAgo } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/use-now'
import {
  connectSharing,
  removeSharing,
  unpublishArtifact,
  useSharingStore,
} from '@renderer/stores/sharing'
import { ControlError } from './controls'
import { RowLine, RowText } from './rows'

type Failure = Extract<SharingResult, { failed: string }>

/** The connected account: what Cloudflare called it, its subdomain, and Remove. */
export function SharingAccount() {
  const { t } = useTranslation('settings')
  const account = useSharingStore((s) => s.status?.cloudflare ?? null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const remove = async (): Promise<void> => {
    setBusy(true)
    setFailure(null)
    const result = await removeSharing()
    setBusy(false)
    if ('failed' in result) setFailure(result)
  }
  if (!account) return <ConnectForm />
  return (
    <div className="flex flex-col gap-2 py-3">
      <RowLine
        text={
          <RowText
            name={t('sharing.account.name')}
            description={
              <>
                <span className="font-mono text-meta">{account.accountId}</span>
                {` · ${account.subdomain}.workers.dev`}
              </>
            }
          />
        }
      >
        <Badge variant="success">{t('sharing.account.connected')}</Badge>
        <Button variant="outline" size="compact" disabled={busy} onClick={() => void remove()}>
          {busy && <Spinner data-icon="inline-start" className="size-3.5" />}
          {t('sharing.account.remove')}
        </Button>
      </RowLine>
      {failure && <FailureText failure={failure} />}
      {account.plainText && (
        <p className="text-xs text-secondary">{t('sharing.account.plainText')}</p>
      )}
    </div>
  )
}

/** The account ID and token, checked with Cloudflare before they are kept. */
function ConnectForm() {
  const { t } = useTranslation(['settings', 'artifacts'])
  const [accountId, setAccountId] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const id = accountId.trim().toLowerCase()
  const secret = token.trim()
  const valid = CLOUDFLARE_ACCOUNT_ID.test(id) && CLOUDFLARE_TOKEN.test(secret)

  const connect = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    setFailure(null)
    const result = await connectSharing(id, secret)
    setBusy(false)
    if ('failed' in result) setFailure(result)
  }

  return (
    <form className="flex flex-col gap-3 py-3" onSubmit={(event) => void connect(event)}>
      <p className="text-xs text-secondary">{t('sharing.account.description')}</p>
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
        <label htmlFor="sharing-account" className="text-xs text-tertiary">
          {t('sharing.account.id')}
        </label>
        <Input
          id="sharing-account"
          value={accountId}
          placeholder={t('sharing.account.idPlaceholder')}
          autoComplete="off"
          spellCheck={false}
          className="h-control font-mono text-xs"
          onChange={(event) => {
            setAccountId(event.target.value)
            setFailure(null)
          }}
        />
        <label htmlFor="sharing-token" className="text-xs text-tertiary">
          {t('sharing.account.token')}
        </label>
        <Input
          id="sharing-token"
          type="password"
          value={token}
          autoComplete="off"
          spellCheck={false}
          className="h-control font-mono text-xs"
          onChange={(event) => {
            setToken(event.target.value)
            setFailure(null)
          }}
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <a
          href={CLOUDFLARE_TOKENS_URL}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-link hover:text-link-hover"
        >
          {t('sharing.account.createToken')}
        </a>
        <Button type="submit" size="compact" disabled={!valid || busy}>
          {busy && <Spinner data-icon="inline-start" className="size-3.5" />}
          {t('sharing.account.connect')}
        </Button>
      </div>
      {failure && <FailureText failure={failure} />}
    </form>
  )
}

/** What a failed connect says, and where to fix it. */
function FailureText({ failure }: { failure: Failure }) {
  const { t } = useTranslation('settings')
  const { t: ta } = useTranslation('artifacts')
  return (
    <div className="flex flex-col items-start gap-1.5" role="alert">
      <p className="text-xs text-danger">
        {ta(`share.failures.${failure.failed}`, { count: CLOUDFLARE_FREE_WORKERS })}
      </p>
      {failure.failed === 'no_subdomain' && (
        <a
          href={CLOUDFLARE_DASHBOARD_URL}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-link hover:text-link-hover"
        >
          {t('sharing.account.dashboard')}
        </a>
      )}
      {failure.failed === 'invalid_token' && (
        <a
          href={CLOUDFLARE_TOKENS_URL}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-link hover:text-link-hover"
        >
          {t('sharing.account.createToken')}
        </a>
      )}
    </div>
  )
}

/** One published page: its URL, the version it shows, and Unpublish. */
export function PublishedRow({ page }: { page: PublishedArtifact }) {
  const { t } = useTranslation('settings')
  const { t: ta } = useTranslation('artifacts')
  const now = useNow()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const unpublish = async (): Promise<void> => {
    setBusy(true)
    setFailure(null)
    const result = await unpublishArtifact(page.id)
    setBusy(false)
    if ('failed' in result) setFailure(result)
  }
  return (
    <div className="flex flex-col gap-1.5 py-3">
      <RowLine
        text={
          <RowText
            name={
              <span dir="ltr" className="block truncate font-mono text-xs">
                {page.url}
              </span>
            }
            description={t('sharing.published.version', {
              version: page.version,
              ago: longAgo(page.publishedAt, now),
            })}
          />
        }
      >
        {failure && (
          <ControlError
            error={ta(`share.failures.${failure.failed}`, { count: CLOUDFLARE_FREE_WORKERS })}
          />
        )}
        <Button variant="outline" size="compact" disabled={busy} onClick={() => void unpublish()}>
          {busy && <Spinner data-icon="inline-start" className="size-3.5" />}
          {t('sharing.published.unpublish')}
        </Button>
      </RowLine>
      {page.otherAccount && (
        <p className="text-xs text-secondary">{t('sharing.published.otherAccount')}</p>
      )}
    </div>
  )
}
