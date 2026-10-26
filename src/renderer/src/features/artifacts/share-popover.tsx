// The viewer's Share button and popover: publish the version on screen, copy the URL, update it or
// take it down. Main holds the account and makes every request.

import { useRef, useState } from 'react'
import {
  CheckIcon,
  CloudIcon,
  CopyIcon,
  ExternalLinkIcon,
  GlobeIcon,
  ShareIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CLOUDFLARE_FREE_WORKERS, type SharingResult } from '@shared/sharing'
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
  title,
  shown,
  head,
}: {
  id: string
  /** The artifact's title, which Unpublish asks about. */
  title: string
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
  const [unpublishing, setUnpublishing] = useState(false)
  const [unpublishFailure, setUnpublishFailure] = useState<Failure | null>(null)
  const [copied, setCopied] = useState(false)
  const [noticeSeen, setNoticeSeen] = useState(() => readJson<boolean>(NOTICE_KEY, false) === true)
  const retry = useRef<(() => void) | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)

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

  // The question takes the popover's place, so the popover closes as it opens.
  const askUnpublish = (): void => {
    setOpen(false)
    setFailure(null)
    setUnpublishFailure(null)
    setConfirming(true)
  }

  const unpublish = (): void => {
    setUnpublishing(true)
    setUnpublishFailure(null)
    void unpublishArtifact(id).then((result) => {
      setUnpublishing(false)
      if ('failed' in result) setUnpublishFailure(result)
      else setConfirming(false)
    })
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
        <h2 className="flex items-center gap-2 font-heading text-subheading font-semibold">
          <GlobeIcon className="size-3.5 text-success" />
          {t('share.publishedTitle')}
        </h2>
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
            variant="outline"
            size="sm"
            aria-label={copied ? t('share.copied') : t('share.copy')}
            onClick={copy}
          >
            {copied ? (
              <CheckIcon data-icon="inline-start" className="animate-in fade-in zoom-in-75" />
            ) : (
              <CopyIcon data-icon="inline-start" />
            )}
            {t('share.copyButton')}
          </Button>
        </div>
        <p className="text-xs text-tertiary">
          {t('share.published', {
            version: published.version,
            ago: longAgo(published.publishedAt, now),
          })}
        </p>
        {!account && (
          <div className="flex flex-col items-start gap-1.5">
            <p className="text-xs text-secondary">{t('share.noAccountPublished')}</p>
            <Button variant="outline" size="sm" onClick={toSettings}>
              {t('share.openSettings')}
            </Button>
          </div>
        )}
        {published.otherAccount && account && (
          <p className="text-xs text-secondary">{t('share.otherAccount')}</p>
        )}
        {canManage && head > published.version && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            className="w-full"
            onClick={() => run(() => updateSharedArtifact(id, head))}
          >
            {busy && <Spinner data-icon="inline-start" />}
            {t('share.update', { version: head })}
          </Button>
        )}
        <div className="-mx-1.5 mt-0.5 -mb-1.5 flex items-center gap-1.5 pt-2 shadow-[inset_0_var(--hairline)_0_var(--border-subtle)]">
          <a
            href={published.url}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: 'quiet', size: 'sm' })}
          >
            <ExternalLinkIcon data-icon="inline-start" />
            {t('share.openLink')}
          </a>
          {canManage && (
            <Button variant="quiet" size="sm" className="ml-auto" onClick={askUnpublish}>
              {t('share.unpublishAsk')}
            </Button>
          )}
        </div>
      </>
    )
  } else if (!account) {
    body = (
      <>
        <p className="text-sm text-secondary">{t('share.needAccount')}</p>
        <Button variant="outline" size="sm" className="self-start" onClick={toSettings}>
          {t('share.openSettings')}
        </Button>
      </>
    )
  } else {
    body = (
      <>
        <p className="text-ui text-primary">{t('share.unpublished')}</p>
        <div className="flex h-9 min-w-0 items-center gap-2 rounded-lg bg-subtle px-2.5 text-small">
          <CloudIcon className="size-4 shrink-0 text-secondary" />
          {t('share.target')}
          <span className="ml-auto min-w-0 truncate font-mono text-xs text-tertiary" dir="ltr">
            {`${account.subdomain}.workers.dev`}
          </span>
        </div>
        {!noticeSeen && <p className="text-xs text-secondary">{t('share.disclosure')}</p>}
        <Button disabled={busy} aria-busy={busy} className="w-full" onClick={publish}>
          {busy && <Spinner data-icon="inline-start" />}
          {busy ? t('share.publishing') : t('share.publish')}
        </Button>
      </>
    )
  }

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setFailure(null)
        }}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <Button
                    ref={trigger}
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
                className="absolute top-1.75 right-1.75 size-1.5 rounded-full bg-success ring-2 ring-app"
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
                <Button variant="outline" size="sm" onClick={() => retry.current?.()}>
                  {t('share.tryAgain')}
                </Button>
              )}
              {failure?.failed === 'invalid_token' && (
                <Button variant="outline" size="sm" onClick={toSettings}>
                  {t('share.openSettings')}
                </Button>
              )}
            </div>
          )}
        </PopoverContent>
      </Popover>
      <AlertDialog open={confirming} onOpenChange={(next) => !next && setConfirming(false)}>
        <AlertDialogContent finalFocus={trigger}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('share.unpublishTitle', { title })}</AlertDialogTitle>
            <AlertDialogDescription>{t('share.unpublishDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          {unpublishFailure && (
            <p role="alert" className="text-xs text-danger">
              {t(`share.failures.${unpublishFailure.failed}`, { count: CLOUDFLARE_FREE_WORKERS })}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('share.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={unpublishing} onClick={unpublish}>
              {unpublishing && <Spinner data-icon="inline-start" />}
              {t('share.unpublish')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
