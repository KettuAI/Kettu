// The viewer's Share button and popover: publish the version on screen, copy the URL, update it or
// take it down. Main holds the account and makes every request.

import { useRef, useState } from 'react'
import {
  CloudIcon,
  Copy01Icon,
  Globe02Icon,
  LinkSquare02Icon,
  Share08Icon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { CLOUDFLARE_FREE_WORKERS, type SharingResult } from '@shared/sharing'
import { Icon, Popover } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
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
import './viewer.css'

/** The warning shown before the first publish, once per device. */
const NOTICE_KEY = 'sharing.firstPublishSeen'

type Failure = Extract<SharingResult, { failed: string }>

export function ShareButton({
  id,
  title,
  shown,
  head,
  iconOnly = false,
}: {
  id: string
  /** The artifact's title, which Unpublish asks about. */
  title: string
  /** The version the viewer shows, which Publish takes. */
  shown: number
  /** The latest version, which Update offers when it is newer than the published one. */
  head: number
  /** A quiet icon button with no label, as on a reply's artifact card. */
  iconOnly?: boolean
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

  const close = (): void => {
    setOpen(false)
    setFailure(null)
  }

  let body: React.ReactNode
  if (!loaded) {
    body = (
      <p className="k-share__wait">
        <Spinner className="size-3.5" />
        {t('share.loading')}
      </p>
    )
  } else if (published) {
    body = (
      <>
        <h2 className="k-share__title">
          <Icon icon={Globe02Icon} size={15} />
          {t('share.publishedTitle')}
        </h2>
        <div className="k-share__url">
          <input
            readOnly
            dir="ltr"
            value={published.url}
            aria-label={t('share.url')}
            onFocus={(event) => event.currentTarget.select()}
            className="ui-sg-input k-av-input"
          />
          <Button
            variant="secondary"
            size="sm"
            aria-label={copied ? t('share.copied') : t('share.copy')}
            icon={<Icon icon={copied ? Tick02Icon : Copy01Icon} size={14} />}
            onClick={copy}
          >
            {t('share.copyButton')}
          </Button>
        </div>
        <p className="k-share__meta">
          {t('share.published', {
            version: published.version,
            ago: longAgo(published.publishedAt, now),
          })}
        </p>
        {!account && (
          <div className="k-share__note">
            <p>{t('share.noAccountPublished')}</p>
            <Button variant="secondary" size="sm" onClick={toSettings}>
              {t('share.openSettings')}
            </Button>
          </div>
        )}
        {published.otherAccount && account && (
          <p className="k-share__meta">{t('share.otherAccount')}</p>
        )}
        {canManage && head > published.version && (
          <Button
            variant="secondary"
            size="sm"
            loading={busy}
            className="k-share__wide"
            onClick={() => run(() => updateSharedArtifact(id, head))}
          >
            {t('share.update', { version: head })}
          </Button>
        )}
        <div className="k-share__foot">
          <a href={published.url} target="_blank" rel="noreferrer" className="k-av-link">
            <Icon icon={LinkSquare02Icon} size={14} />
            {t('share.openLink')}
          </a>
          {canManage && (
            <Button variant="ghost" size="sm" onClick={askUnpublish}>
              {t('share.unpublishAsk')}
            </Button>
          )}
        </div>
      </>
    )
  } else if (!account) {
    body = (
      <>
        <p className="k-share__lead">{t('share.needAccount')}</p>
        <Button variant="secondary" size="sm" onClick={toSettings}>
          {t('share.openSettings')}
        </Button>
      </>
    )
  } else {
    body = (
      <>
        <p className="k-share__lead">{t('share.unpublished')}</p>
        <div className="k-share__target">
          <Icon icon={CloudIcon} size={15} />
          {t('share.target')}
          <span dir="ltr">{`${account.subdomain}.workers.dev`}</span>
        </div>
        {!noticeSeen && <p className="k-share__meta">{t('share.disclosure')}</p>}
        <Button loading={busy} className="k-share__wide" onClick={publish}>
          {busy ? t('share.publishing') : t('share.publish')}
        </Button>
      </>
    )
  }

  return (
    <>
      <span className="ui-as-anchor k-share">
        <Tooltip>
          <TooltipTrigger
            render={
              iconOnly ? (
                <button
                  ref={trigger}
                  type="button"
                  aria-label={t('share.open')}
                  aria-expanded={open}
                  onClick={() => (open ? close() : setOpen(true))}
                  className="ui-as-icon-btn k-av-btn"
                />
              ) : (
                <Button
                  ref={trigger}
                  variant="secondary"
                  size="sm"
                  aria-label={t('share.open')}
                  aria-expanded={open}
                  icon={<Icon icon={Share08Icon} size={14} />}
                  onClick={() => (open ? close() : setOpen(true))}
                />
              )
            }
          >
            {iconOnly ? (
              <Icon icon={Share08Icon} size={15} />
            ) : published ? (
              t('share.buttonShared')
            ) : (
              t('share.button')
            )}
          </TooltipTrigger>
          <TooltipContent>{t('share.open')}</TooltipContent>
        </Tooltip>
        {published && <span aria-hidden className="k-share__dot" />}
        <Popover open={open} onClose={close} align="end" className="ui-as-menu k-share__pop">
          {body}
          {reason && (
            <div role="alert" className="k-share__note">
              <p className="k-av-error">{reason}</p>
              {failure?.failed === 'network' && (
                <Button variant="secondary" size="sm" onClick={() => retry.current?.()}>
                  {t('share.tryAgain')}
                </Button>
              )}
              {failure?.failed === 'invalid_token' && (
                <Button variant="secondary" size="sm" onClick={toSettings}>
                  {t('share.openSettings')}
                </Button>
              )}
            </div>
          )}
        </Popover>
      </span>
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
