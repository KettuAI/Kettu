// The viewer's Share button and popover: publish the version on screen, copy the URL, update it or
// take it down. Main holds the account and makes every request.

import { useRef, useState } from 'react'
import { CheckIcon, CopyIcon, ExternalLinkIcon, ShareIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CLOUDFLARE_FREE_WORKERS, type SharingResult } from '@shared/sharing'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { longAgo } from '@renderer/lib/format'
import { readJson, writeJson } from '@renderer/lib/storage'
import { useNow } from '@renderer/lib/use-now'
import {
  publishArtifact,
  unpublishArtifact,
  updateSharedArtifact,
  useSharingStore,
} from '@renderer/stores/sharing'
import { openSettings } from '@renderer/stores/view'

/** The warning shown before the first publish, once per device. */
const NOTICE_KEY = 'sharing.firstPublishSeen'

type Failure = Extract<SharingResult, { failed: string }>

export function ShareButton({
  id,
  shown,
  head,
}: {
  id: string
  /** The version the viewer shows, which Publish takes. */
  shown: number
  /** The latest version, which Update offers when it is newer than the published one. */
  head: number
}) {
  const { t } = useTranslation('artifacts')
  const account = useSharingStore((s) => s.status?.cloudflare ?? null)
  const loaded = useSharingStore((s) => s.status !== null)
  const published = useSharingStore(
    (s) => s.status?.published.find((page) => page.id === id) ?? null,
  )
  const now = useNow()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [copied, setCopied] = useState(false)
  const [noticeSeen, setNoticeSeen] = useState(() => readJson<boolean>(NOTICE_KEY, false) === true)
  const retry = useRef<(() => void) | null>(null)

  const run = (action: () => Promise<SharingResult>): void => {
    retry.current = () => run(action)
    setBusy(true)
    setFailure(null)
    void action().then((result) => {
      setBusy(false)
      if ('failed' in result) setFailure(result)
    })
  }

  const publish = (): void => {
    if (!noticeSeen) {
      writeJson(NOTICE_KEY, true)
      setNoticeSeen(true)
    }
    run(() => publishArtifact(id, shown))
  }

  const copy = (): void => {
    if (!published) return
    void navigator.clipboard.writeText(published.url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const toSettings = (): void => {
    setOpen(false)
    openSettings('sharing')
  }

  const canManage = account !== null && published !== null && !published.otherAccount
  const reason = failure
    ? t(`share.failures.${failure.failed}`, { count: CLOUDFLARE_FREE_WORKERS })
    : null

  let body: React.ReactNode
  if (!loaded) {
    body = (
      <p className="flex items-center gap-2 text-xs text-secondary">
        <Spinner className="size-3.5" />
        {t('share.loading')}
      </p>
    )
  } else if (published) {
    body = (
      <>
        <div className="flex items-center gap-1.5">
          <Input
            readOnly
            dir="ltr"
            value={published.url}
            aria-label={t('share.url')}
            onFocus={(event) => event.currentTarget.select()}
            className="h-8 font-mono text-xs"
          />
          <Button
            variant="quiet"
            size="icon-compact"
            aria-label={copied ? t('share.copied') : t('share.copy')}
            onClick={copy}
          >
            {copied ? (
              <CheckIcon className="animate-in text-icon fade-in zoom-in-75" />
            ) : (
              <CopyIcon />
            )}
          </Button>
        </div>
        <p className="text-xs text-secondary">
          {t('share.published', {
            version: published.version,
            ago: longAgo(published.publishedAt, now),
          })}
        </p>
        {!account && (
          <div className="flex flex-col items-start gap-1.5">
            <p className="text-xs text-secondary">{t('share.noAccountPublished')}</p>
            <Button variant="outline" size="compact" onClick={toSettings}>
              {t('share.openSettings')}
            </Button>
          </div>
        )}
        {published.otherAccount && account && (
          <p className="text-xs text-secondary">{t('share.otherAccount')}</p>
        )}
        {canManage && head > published.version && (
          <Button disabled={busy} onClick={() => run(() => updateSharedArtifact(id, head))}>
            {busy && <Spinner data-icon="inline-start" />}
            {t('share.update', { version: head })}
          </Button>
        )}
        <div className="flex items-center justify-between gap-2">
          <a
            href={published.url}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: 'outline', size: 'compact' })}
          >
            <ExternalLinkIcon data-icon="inline-start" />
            {t('share.open')}
          </a>
          {canManage &&
            (confirming ? null : (
              <Button
                variant="quiet"
                size="compact"
                className="text-danger"
                onClick={() => setConfirming(true)}
              >
                {t('share.unpublish')}
              </Button>
            ))}
        </div>
        {canManage && confirming && (
          <div className="flex flex-col gap-2 rounded-xl bg-subtle p-2.5">
            <p className="text-xs text-secondary">{t('share.unpublishConfirm')}</p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="compact" onClick={() => setConfirming(false)}>
                {t('share.cancel')}
              </Button>
              <Button
                variant="destructive-outline"
                size="compact"
                disabled={busy}
                onClick={() => run(() => unpublishArtifact(id))}
              >
                {busy && <Spinner data-icon="inline-start" />}
                {t('share.unpublish')}
              </Button>
            </div>
          </div>
        )}
      </>
    )
  } else if (!account) {
    body = (
      <>
        <p className="text-sm text-secondary">{t('share.needAccount')}</p>
        <Button variant="outline" size="compact" className="self-start" onClick={toSettings}>
          {t('share.openSettings')}
        </Button>
      </>
    )
  } else {
    body = (
      <>
        <p className="text-sm text-secondary">{t('share.unpublished')}</p>
        <p className="text-xs text-tertiary">{t('share.target')}</p>
        {!noticeSeen && <p className="text-xs text-secondary">{t('share.disclosure')}</p>}
        <Button disabled={busy} className="self-start" onClick={publish}>
          {busy && <Spinner data-icon="inline-start" />}
          {t('share.publish')}
        </Button>
      </>
    )
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) return
        setConfirming(false)
        setFailure(null)
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="quiet"
                  size="icon-compact"
                  aria-label={t('share.open')}
                  className="relative text-foreground"
                />
              }
            />
          }
        >
          <ShareIcon />
          {published && (
            <span
              aria-hidden
              className="absolute top-1 right-1 size-1.5 rounded-full bg-success ring-2 ring-app"
            />
          )}
        </TooltipTrigger>
        <TooltipContent>{t('share.open')}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80">
        {body}
        {reason && (
          <div role="alert" className="flex flex-col items-start gap-1.5">
            <p className="text-xs text-danger">{reason}</p>
            {failure?.failed === 'network' && (
              <Button variant="outline" size="compact" onClick={() => retry.current?.()}>
                {t('share.tryAgain')}
              </Button>
            )}
            {failure?.failed === 'invalid_token' && (
              <Button variant="outline" size="compact" onClick={toSettings}>
                {t('share.openSettings')}
              </Button>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
