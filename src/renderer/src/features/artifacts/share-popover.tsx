// The viewer's Share button and popover: publish the version on screen to Kettu or the connected
// Cloudflare account, choose who can open a Kettu page, copy the URL, update it or take it down.
// Main holds the accounts and makes every request.

import { useEffect, useRef, useState } from 'react'
import {
  CloudIcon,
  Copy01Icon,
  Globe02Icon,
  Key01Icon,
  LinkSquare02Icon,
  SquareLock02Icon,
  Share08Icon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import {
  CLOUDFLARE_FREE_WORKERS,
  DEFAULT_SHARE_ACCESS,
  SHARE_ACCESS,
  type ShareAccess,
  type SharingResult,
  type SharingTarget,
} from '@shared/sharing'
import { Icon, Popover } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { SegmentedControl } from '@renderer/components/affect/segmented-control'
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
import { useCloudOff } from '@renderer/lib/cloud'
import { longAgo, storageBytes } from '@renderer/lib/format'
import { useHostContext } from '@renderer/lib/host-features'
import { isWeb } from '@renderer/lib/platform'
import { readJson, writeJson } from '@renderer/lib/storage'
import { useNow } from '@renderer/lib/use-now'
import { signIn, useAccountStore } from '@renderer/stores/account'
import {
  canChange,
  newSharedCode,
  publishArtifact,
  refreshSharing,
  setSharedAccess,
  sharedPageLink,
  unpublishArtifact,
  updateSharedArtifact,
  useSharingStore,
} from '@renderer/stores/sharing'
import { openSettings } from '@renderer/stores/view'
import './viewer.css'

/** The warning shown before the first publish, once per device. */
const NOTICE_KEY = 'sharing.firstPublishSeen'

type Failure = Extract<SharingResult, { failed: string }>

/** An address as people read it: without `https://` and the trailing slash. */
function shortAddress(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

const ACCESS_ICONS = { private: SquareLock02Icon, code: Key01Icon, public: Globe02Icon } as const

/** Who can open a Kettu page: the three levels, with a line on what the chosen one means. */
function AccessChoice({
  value,
  disabled = false,
  onChange,
}: {
  value: ShareAccess
  disabled?: boolean
  onChange(next: ShareAccess): void
}) {
  const { t } = useTranslation('artifacts')
  return (
    <div className="k-share__choose">
      <span>{t('share.who')}</span>
      <SegmentedControl<ShareAccess>
        aria-label={t('share.who')}
        variant="tray"
        size="sm"
        fullWidth
        value={value}
        disabled={disabled}
        onChange={onChange}
        options={SHARE_ACCESS.map((access) => ({
          value: access,
          label: t(`share.access.${access}`),
        }))}
      />
      <p className="k-share__meta">{t(`share.accessHint.${value}`)}</p>
    </div>
  )
}

/** The used and total storage, as "1.2 MB of 2 GB cloud storage used". */
function StorageLine() {
  const { t } = useTranslation('artifacts')
  const storage = useSharingStore((s) => s.status?.kettu.storage ?? null)
  if (!storage) return null
  return (
    <p className="k-share__meta">
      {t('share.storage', { used: storageBytes(storage.used), limit: storageBytes(storage.limit) })}
    </p>
  )
}

/** Signing in to Kettu, which only the desktop app does for its own host, with its cloud on. */
function SignInButton() {
  const { t } = useTranslation('artifacts')
  const signingIn = useAccountStore((s) => s.status?.state === 'signing-in')
  const cloudOff = useCloudOff()
  if (isWeb || cloudOff) return null
  return (
    <Button variant="secondary" size="sm" loading={signingIn} onClick={() => void signIn()}>
      {t('share.signIn')}
    </Button>
  )
}

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
  const onHost = useHostContext()
  const status = useSharingStore((s) => s.status)
  const account = status?.cloudflare ?? null
  const kettu = status?.kettu.account ?? null
  const loaded = status !== null
  const published = status?.published.find((page) => page.id === id) ?? null
  const autoOn = status?.auto.enabled === true
  const skipped = status?.auto.blocked.find((entry) => entry.id === id)?.reason ?? null
  const now = useNow()
  const [open, setOpen] = useState(false)
  const [chosen, setChosen] = useState<SharingTarget>('kettu')
  const cloudOff = useCloudOff()
  // Without a Cloudflare account there is no choice: pages go to Kettu. Self-hosted, they go only
  // to the own Cloudflare account.
  const target: SharingTarget = cloudOff ? 'cloudflare' : account ? chosen : 'kettu'
  const [access, setAccess] = useState<ShareAccess>(DEFAULT_SHARE_ACCESS)
  const [codeCopied, setCodeCopied] = useState(false)
  // The address field shows the address without its scheme, and the whole URL while focused.
  const [urlFocused, setUrlFocused] = useState(false)
  const urlField = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [unpublishing, setUnpublishing] = useState(false)
  const [unpublishFailure, setUnpublishFailure] = useState<Failure | null>(null)
  const [copied, setCopied] = useState(false)
  const [noticeSeen, setNoticeSeen] = useState(() => readJson<boolean>(NOTICE_KEY, false) === true)
  const retry = useRef<(() => void) | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const signedIn = kettu !== null

  // Selected once the whole URL is in the field, so a copy by hand takes all of it.
  useEffect(() => {
    if (urlFocused) urlField.current?.select()
  }, [urlFocused])

  // The addresses and the storage as the service has them now, each time the panel opens.
  useEffect(() => {
    if (open && signedIn && !cloudOff) void refreshSharing()
  }, [open, signedIn, cloudOff])

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
    // Cloudflare has no levels: whoever has a Worker's address opens it.
    run(() => publishArtifact(id, shown, target, target === 'kettu' ? access : 'public'))
  }

  const copy = (): void => {
    if (!published) return
    // The link, and the access code with it while the page has one.
    const text = published.code
      ? t('share.copyWithCode', { url: published.url, code: published.code })
      : published.url
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const copyCode = (): void => {
    if (!published?.code) return
    void navigator.clipboard.writeText(published.code).then(() => {
      setCodeCopied(true)
      setTimeout(() => setCodeCopied(false), 2000)
    })
  }

  // The publisher's own page that is not public opens through a one-time address, so neither its
  // code nor a sign-in in the browser is needed; anything else opens the page's own address. The
  // web client opens the plain address, as a window opened after a request may be blocked there.
  const openPage = (event: React.MouseEvent<HTMLAnchorElement>): void => {
    if (isWeb || !published || published.access === 'public' || !canManage) return
    event.preventDefault()
    const fallback = published.url
    void sharedPageLink(id).then((result) => {
      window.open('url' in result ? result.url : fallback, '_blank', 'noreferrer')
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

  // Self-hosted, a page on Kettu can only be unpublished on kettu.sh.
  const canManage =
    status !== null &&
    published !== null &&
    canChange(published, status) &&
    !(cloudOff && published.target === 'kettu')
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
        <h2 className="k-share__title" data-access={published.access}>
          <Icon icon={ACCESS_ICONS[published.access]} size={15} />
          {t('share.publishedTitle')}
        </h2>
        <div className="k-share__url">
          <input
            ref={urlField}
            readOnly
            dir="ltr"
            value={urlFocused ? published.url : shortAddress(published.url)}
            aria-label={t('share.url')}
            onFocus={() => setUrlFocused(true)}
            onBlur={() => setUrlFocused(false)}
            className="ui-sg-input k-av-input"
          />
          <Button
            variant="secondary"
            size="sm"
            aria-label={
              copied ? t('share.copied') : published.code ? t('share.copyBoth') : t('share.copy')
            }
            icon={<Icon icon={copied ? Tick02Icon : Copy01Icon} size={14} />}
            onClick={copy}
          >
            {t('share.copyButton')}
          </Button>
        </div>
        {published.target === 'kettu' && canManage && (
          <AccessChoice
            value={published.access}
            disabled={busy}
            onChange={(next) => run(() => setSharedAccess(id, next))}
          />
        )}
        {published.target === 'kettu' && !canManage && !cloudOff && (
          <p className="k-share__meta">{t(`share.accessHint.${published.access}`)}</p>
        )}
        {published.code && (
          <div className="k-share__code">
            <span className="k-share__code-label">{t('share.codeLabel')}</span>
            <span className="k-share__code-value" dir="ltr">
              {published.code}
            </span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={codeCopied ? t('share.copied') : t('share.copyCode')}
                    onClick={copyCode}
                    className="ui-as-icon-btn"
                  />
                }
              >
                <Icon icon={codeCopied ? Tick02Icon : Copy01Icon} size={14} />
              </TooltipTrigger>
              <TooltipContent>{t('share.copyCode')}</TooltipContent>
            </Tooltip>
            {canManage && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="sm"
                      className="k-share__code-new"
                      disabled={busy}
                      onClick={() => run(() => newSharedCode(id))}
                    />
                  }
                >
                  {t('share.newCode')}
                </TooltipTrigger>
                <TooltipContent>{t('share.newCodeHint')}</TooltipContent>
              </Tooltip>
            )}
          </div>
        )}
        {published.codeLocked && canManage && (
          <p className="k-share__meta k-share__warn">{t('share.codeLocked')}</p>
        )}
        <p className="k-share__meta">
          {`${t('share.published', {
            version: published.version,
            ago: longAgo(published.publishedAt, now),
          })} · ${t(`share.where.${published.target}`)}`}
        </p>
        {published.target === 'kettu' && canManage && <StorageLine />}
        {published.target === 'kettu' && cloudOff && (
          <p className="k-share__meta">{t('share.selfHosted.published')}</p>
        )}
        {published.target === 'kettu' && !kettu && !cloudOff && (
          <div className="k-share__note">
            <p>{t('share.signedOutPublished')}</p>
            <SignInButton />
          </div>
        )}
        {published.target === 'kettu' && kettu && published.otherAccount && !cloudOff && (
          <p className="k-share__meta">
            {published.accountEmail
              ? t('share.otherKettu', { email: published.accountEmail })
              : t('share.otherKettuUnnamed')}
          </p>
        )}
        {published.target === 'cloudflare' && !account && (
          <div className="k-share__note">
            <p>{t('share.noAccountPublished')}</p>
            <Button variant="secondary" size="sm" onClick={toSettings}>
              {t('share.openSettings')}
            </Button>
          </div>
        )}
        {published.target === 'cloudflare' && published.otherAccount && account && (
          <p className="k-share__meta">{t('share.otherAccount')}</p>
        )}
        {published.target === 'kettu' && canManage && autoOn && (
          <p className="k-share__meta">{t('share.autoFollows')}</p>
        )}
        {canManage && head > published.version && !(autoOn && published.target === 'kettu') && (
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
          <a
            href={published.url}
            target="_blank"
            rel="noreferrer"
            className="k-av-link"
            onClick={openPage}
          >
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
  } else {
    const ready = target === 'cloudflare' ? account !== null : signedIn
    body = (
      <>
        <p className="k-share__lead">{t('share.unpublished')}</p>
        {account && !cloudOff && (
          <div className="k-share__choose">
            <span>{t('share.publishTo')}</span>
            <SegmentedControl<SharingTarget>
              aria-label={t('share.publishTo')}
              variant="tray"
              size="sm"
              fullWidth
              value={target}
              onChange={(next) => {
                setChosen(next)
                setFailure(null)
              }}
              options={[
                { value: 'kettu', label: t('share.targets.kettu') },
                { value: 'cloudflare', label: t('share.targets.cloudflare') },
              ]}
            />
          </div>
        )}
        {target === 'cloudflare' && account && (
          <>
            <div className="k-share__target">
              <Icon icon={CloudIcon} size={15} />
              {t('share.targets.cloudflare')}
              <span dir="ltr">{`${account.subdomain}.workers.dev`}</span>
            </div>
            <p className="k-share__meta">{t('share.cloudflarePublic')}</p>
          </>
        )}
        {target === 'kettu' && signedIn && (
          <AccessChoice
            value={access}
            disabled={busy}
            onChange={(next) => {
              setAccess(next)
              setFailure(null)
            }}
          />
        )}
        {target === 'kettu' && signedIn && <StorageLine />}
        {target === 'kettu' && signedIn && skipped && (
          <p className="k-share__meta k-share__warn">
            {`${t('share.autoSkipped')} ${t(`share.failures.${skipped}`)}`}
          </p>
        )}
        {target === 'kettu' && !signedIn && (
          <div className="k-share__note">
            <p>{t('share.needKettu', onHost)}</p>
            <SignInButton />
          </div>
        )}
        {target === 'cloudflare' && !account && (
          <div className="k-share__note">
            <p>{t('share.selfHosted.connect')}</p>
            <Button variant="secondary" size="sm" onClick={toSettings}>
              {t('share.selfHosted.openSettings')}
            </Button>
          </div>
        )}
        {ready && !noticeSeen && <p className="k-share__meta">{t('share.disclosure')}</p>}
        {ready && (
          <Button loading={busy} className="k-share__wide" onClick={publish}>
            {busy ? t('share.publishing') : t('share.publish')}
          </Button>
        )}
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
              {(failure?.failed === 'invalid_token' || failure?.failed === 'storage_full') && (
                <Button variant="secondary" size="sm" onClick={toSettings}>
                  {t('share.openSettings')}
                </Button>
              )}
              {failure?.failed === 'signed_out' && <SignInButton />}
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
