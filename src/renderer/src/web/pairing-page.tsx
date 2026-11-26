import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  AlertCircleIcon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  CancelCircleIcon,
  ComputerIcon,
  RefreshIcon,
  Shield01Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { parseBrowserPairingLink, type PairingPayload } from '@shared/remote/pairing'
import type { PairProgress } from '@shared/remote/pair'
import { BrandIcon } from '@renderer/components/brand'
import { SystemLogo } from '@renderer/components/system-logo'
import { Alert, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { Field, FieldError, FieldLabel } from '@renderer/components/ui/field'
import { Input } from '@renderer/components/ui/input'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'
import {
  canRetryDiscoveryFailure,
  platformDisplayName,
  platformLogoName,
  type DiscoveryPairProgress,
  type HostedDiscoveredHost,
  type HostedDiscoveredHosts,
} from './hosted/discovery'

export type PairingNotice = 'removed' | null

/** Active one-click discovery pairing controller handed back to the pairing page. */
export interface DiscoveryPairController {
  confirm(): void
  cancel(): void
  /** Resolves true once the host added this browser and the app is opening. */
  readonly done: Promise<boolean>
}

/** Account-backed computer discovery and one-click pairing for the hosted web client. */
export interface HostedAccountDiscovery {
  list(signal?: AbortSignal): Promise<HostedDiscoveredHosts>
  pair(
    host: HostedDiscoveredHost,
    progress: (state: DiscoveryPairProgress) => void,
  ): DiscoveryPairController
}

/** What the hosted client adds to the page: who is signed in, discovery, and a way back. */
export interface HostedPairing {
  email: string
  onSwitchAccount(): void
  /** Back to the host shown before, when there is one. */
  onBack: (() => void) | null
  /** Lists online computers of the signed-in account and pairs without a link. */
  discovery?: HostedAccountDiscovery
}

/** Active discovery pairing state displayed on the pairing page. */
export interface ActiveDiscoveryPairing {
  host: HostedDiscoveredHost
  progress: DiscoveryPairProgress
  added: boolean
}

/**
 * The page an unpaired browser shows: on the hosted client it lists the signed-in account's online
 * computers for one-click pairing with six-digit code confirmation, with the pairing link field as
 * a secondary option; elsewhere it shows the link field directly. A code in the page's own address
 * starts at once.
 */
export function PairingPage({
  initial,
  notice,
  deviceName,
  hosted,
  onPair,
}: {
  initial: PairingPayload | null
  notice: PairingNotice
  deviceName: string
  hosted?: HostedPairing
  onPair(payload: PairingPayload, progress: (state: PairProgress) => void): Promise<boolean>
}) {
  const [link, setLink] = useState('')
  const [invalid, setInvalid] = useState(false)
  const [progress, setProgress] = useState<PairProgress | null>(null)
  const [added, setAdded] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [discovered, setDiscovered] = useState<HostedDiscoveredHosts | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [discoveryPairing, setDiscoveryPairing] = useState<ActiveDiscoveryPairing | null>(null)

  const started = useRef(false)
  const mounted = useRef(true)
  const listRun = useRef(0)
  const listAbort = useRef<AbortController | null>(null)
  const pairRun = useRef(0)
  const pairSession = useRef<DiscoveryPairController | null>(null)

  const discovery = hosted?.discovery
  const linkBusy = added || progress?.state === 'connecting' || progress?.state === 'waiting'
  const discoveryBusy = discoveryPairing !== null

  const loadHosts = useCallback(async (): Promise<void> => {
    if (!discovery) return
    listAbort.current?.abort()
    const controller = new AbortController()
    listAbort.current = controller
    const run = ++listRun.current
    try {
      const next = await discovery.list(controller.signal)
      if (!mounted.current || run !== listRun.current || controller.signal.aborted) return
      setDiscovered(next)
    } catch {
      if (!mounted.current || run !== listRun.current || controller.signal.aborted) return
      setDiscovered({ state: 'unavailable' })
    } finally {
      if (mounted.current && run === listRun.current) setRefreshing(false)
    }
  }, [discovery])

  const refreshHosts = (): void => {
    if (!discovery) return
    setRefreshing(true)
    void loadHosts()
  }

  const startLink = (payload: PairingPayload): void => {
    pairRun.current++
    pairSession.current?.cancel()
    pairSession.current = null
    setDiscoveryPairing(null)
    setInvalid(false)
    void onPair(payload, setProgress).then((ok) => {
      if (!mounted.current) return
      setAdded(ok)
      if (!ok) {
        setLinkOpen(true)
        refreshHosts()
      }
    })
  }

  useEffect(() => {
    if (!initial || started.current) return
    started.current = true
    startLink(initial)
    // Only the code the page opened with starts by itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial])

  useEffect(() => {
    if (!discovery || initial) return
    listAbort.current?.abort()
    const controller = new AbortController()
    listAbort.current = controller
    const run = ++listRun.current
    void discovery
      .list(controller.signal)
      .then(
        (next) => {
          if (mounted.current && run === listRun.current && !controller.signal.aborted) {
            setDiscovered(next)
          }
        },
        () => {
          if (mounted.current && run === listRun.current && !controller.signal.aborted) {
            setDiscovered({ state: 'unavailable' })
          }
        },
      )
      .finally(() => {
        if (mounted.current && run === listRun.current) setRefreshing(false)
      })
    return () => controller.abort()
  }, [discovery, initial])

  useEffect(() => {
    if (!discovery || linkBusy || discoveryBusy) return
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void loadHosts()
    }
    window.addEventListener('focus', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', onVisible)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [discovery, linkBusy, discoveryBusy, loadHosts])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      listAbort.current?.abort()
      pairSession.current?.cancel()
      pairSession.current = null
    }
  }, [])

  const startDiscovery = (host: HostedDiscoveredHost): void => {
    if (!discovery) return
    pairSession.current?.cancel()
    const run = ++pairRun.current
    setProgress(null)
    setInvalid(false)
    setDiscoveryPairing({ host, progress: { state: 'connecting' }, added: false })
    const session = discovery.pair(host, (next) => {
      if (!mounted.current || run !== pairRun.current) return
      setDiscoveryPairing((current) =>
        current && current.host.relayId === host.relayId ? { ...current, progress: next } : current,
      )
    })
    pairSession.current = session
    void session.done.then((ok) => {
      if (!mounted.current || run !== pairRun.current) return
      pairSession.current = null
      if (ok) {
        setDiscoveryPairing((current) => (current ? { ...current, added: true } : current))
      }
    })
  }

  const confirmDiscovery = (): void => {
    pairSession.current?.confirm()
  }

  const cancelDiscovery = (): void => {
    pairRun.current++
    pairSession.current?.cancel()
    pairSession.current = null
    setDiscoveryPairing(null)
    refreshHosts()
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const payload = parseBrowserPairingLink(link)
    if (!payload) return setInvalid(true)
    startLink(payload)
  }

  return (
    <PairingView
      notice={notice}
      deviceName={deviceName}
      hosted={hosted}
      progress={progress}
      added={added}
      link={link}
      invalid={invalid}
      linkOpen={linkOpen || progress?.state === 'failed' || invalid}
      discovered={discovered}
      refreshing={refreshing || (discovery !== undefined && discovered === null)}
      discoveryPairing={discoveryPairing}
      onLink={(next) => {
        setLink(next)
        setInvalid(false)
      }}
      onToggleLink={() => setLinkOpen((open) => !open)}
      onRefresh={refreshHosts}
      onSelectHost={startDiscovery}
      onConfirmDiscovery={confirmDiscovery}
      onCancelDiscovery={cancelDiscovery}
      onRetryDiscovery={() => {
        if (discoveryPairing) startDiscovery(discoveryPairing.host)
      }}
      onSubmit={submit}
    />
  )
}

/** The pairing page in one of its states. */
export function PairingView({
  notice,
  deviceName,
  hosted,
  progress,
  added,
  link,
  invalid,
  linkOpen = false,
  discovered = null,
  refreshing = false,
  discoveryPairing = null,
  onLink,
  onToggleLink,
  onRefresh,
  onSelectHost,
  onConfirmDiscovery,
  onCancelDiscovery,
  onRetryDiscovery,
  onSubmit,
}: {
  notice: PairingNotice
  deviceName: string
  hosted?: HostedPairing
  progress: PairProgress | null
  added: boolean
  link: string
  invalid: boolean
  linkOpen?: boolean
  discovered?: HostedDiscoveredHosts | null
  refreshing?: boolean
  discoveryPairing?: ActiveDiscoveryPairing | null
  onLink(link: string): void
  onToggleLink?(): void
  onRefresh?(): void
  onSelectHost?(host: HostedDiscoveredHost): void
  onConfirmDiscovery?(): void
  onCancelDiscovery?(): void
  onRetryDiscovery?(): void
  onSubmit(event: FormEvent): void
}) {
  const { t } = useTranslation('web')
  const hasDiscovery = hosted?.discovery !== undefined
  const linkBusy = added || progress?.state === 'connecting' || progress?.state === 'waiting'

  return (
    <main className="flex min-h-dvh items-center justify-center bg-app px-5 py-10 text-primary">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col items-start gap-4">
          <BrandIcon size={48} />
          <h1 className="text-xl font-semibold">
            {discoveryPairing
              ? t('pair.account.pair.title', { name: discoveryPairing.host.name })
              : t('pair.title')}
          </h1>
          {!discoveryPairing && (
            <p className="text-sm text-secondary">
              {t(hosted ? 'pair.introHosted' : 'pair.intro')}
            </p>
          )}
        </div>

        {notice === 'removed' && !progress && !discoveryPairing && (
          <Alert variant="warning">
            <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={1.9} aria-hidden />
            <AlertDescription>{t('pair.removed')}</AlertDescription>
          </Alert>
        )}

        {discoveryPairing ? (
          <DiscoveryPairPanel
            pairing={discoveryPairing}
            deviceName={deviceName}
            onConfirm={onConfirmDiscovery}
            onCancel={onCancelDiscovery}
            onRetry={onRetryDiscovery}
          />
        ) : linkBusy ? (
          <div className="flex items-start gap-3 rounded-xl bg-card px-4 py-3.5 shadow-card">
            <Spinner className="mt-0.5" />
            <div className="flex flex-col gap-1 text-sm" aria-live="polite">
              {added ? (
                <span>{t('pair.added')}</span>
              ) : progress?.state === 'waiting' ? (
                <>
                  <span className="font-medium">{t('pair.waiting')}</span>
                  <span className="text-secondary">
                    {t('pair.waitingHint', { name: deviceName })}
                  </span>
                </>
              ) : (
                <span>{t('pair.connecting')}</span>
              )}
            </div>
          </div>
        ) : hasDiscovery ? (
          <div className="flex flex-col gap-5">
            <AccountHostsSection
              discovered={discovered}
              refreshing={refreshing}
              onRefresh={onRefresh}
              onSelect={onSelectHost}
              onSwitchAccount={hosted?.onSwitchAccount}
            />

            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  aria-expanded={linkOpen}
                  onClick={onToggleLink}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-secondary transition-colors hover:text-primary"
                >
                  <span>{t('pair.linkToggle')}</span>
                  <HugeiconsIcon
                    icon={linkOpen ? ArrowUp01Icon : ArrowDown01Icon}
                    size={14}
                    strokeWidth={1.9}
                    aria-hidden
                  />
                </button>
                {hosted?.onBack && (
                  <Button type="button" variant="ghost" size="sm" onClick={hosted.onBack}>
                    {t('pair.back')}
                  </Button>
                )}
              </div>

              {linkOpen && (
                <LinkPairingForm
                  hosted
                  progress={progress}
                  link={link}
                  invalid={invalid}
                  onLink={onLink}
                  onSubmit={onSubmit}
                />
              )}
            </div>
          </div>
        ) : (
          <LinkPairingForm
            hosted={Boolean(hosted)}
            progress={progress}
            link={link}
            invalid={invalid}
            onBack={hosted?.onBack ?? undefined}
            onLink={onLink}
            onSubmit={onSubmit}
          />
        )}

        {hosted && (
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-secondary">
            <span>{t('hosted.account', { email: hosted.email })}</span>
            <Button
              variant="link"
              size="xs"
              className="h-auto p-0"
              onClick={hosted.onSwitchAccount}
            >
              {t('hosted.switchAccount')}
            </Button>
          </p>
        )}

        <InsecureNote />
      </div>
    </main>
  )
}

function PlatformIcon({ platform }: { platform: string }) {
  const logo = platformLogoName(platform)
  return (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-subtle text-secondary"
    >
      {logo ? (
        <SystemLogo name={logo} className="size-4" />
      ) : (
        <HugeiconsIcon icon={ComputerIcon} size={16} strokeWidth={1.9} />
      )}
    </span>
  )
}

function AccountHostsSection({
  discovered,
  refreshing,
  onRefresh,
  onSelect,
  onSwitchAccount,
}: {
  discovered: HostedDiscoveredHosts | null
  refreshing: boolean
  onRefresh?(): void
  onSelect?(host: HostedDiscoveredHost): void
  onSwitchAccount?(): void
}) {
  const { t } = useTranslation('web')

  return (
    <section aria-labelledby="account-hosts-heading" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 id="account-hosts-heading" className="text-xs font-medium text-secondary">
          {t('pair.account.heading')}
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('pair.account.refresh')}
          disabled={refreshing}
          onClick={onRefresh}
        >
          <HugeiconsIcon
            icon={RefreshIcon}
            size={14}
            strokeWidth={1.9}
            aria-hidden
            className={cn(refreshing && 'animate-spin')}
          />
        </Button>
      </div>

      <div className="rounded-xl bg-card shadow-card">
        {discovered === null ? (
          <div className="divide-y divide-border-subtle" aria-busy="true">
            {[0, 1].map((row) => (
              <div key={row} className="flex items-center gap-3 px-4 py-3">
                <Skeleton className="size-8 shrink-0 rounded-lg" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3.5 w-28" />
                  <Skeleton className="h-3 w-16" />
                </div>
                <Skeleton className="h-7 w-16 rounded-lg" />
              </div>
            ))}
          </div>
        ) : discovered.state === 'ok' && discovered.hosts.length > 0 ? (
          <ul className="divide-y divide-border-subtle">
            {discovered.hosts.map((host) => (
              <li key={host.relayId} className="flex items-center gap-3 px-4 py-3">
                <PlatformIcon platform={host.platform} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-primary">{host.name}</div>
                  <div className="truncate text-xs text-secondary">
                    {platformDisplayName(host.platform)}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  aria-label={t('pair.account.connectTo', { name: host.name })}
                  onClick={() => onSelect?.(host)}
                >
                  {t('pair.account.connect')}
                </Button>
              </li>
            ))}
          </ul>
        ) : discovered.state === 'unavailable' ? (
          <div className="flex flex-col items-start gap-3 px-4 py-4">
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-primary">
                {t('pair.account.unavailable.title')}
              </p>
              <p className="text-xs text-secondary">{t('pair.account.unavailable.body')}</p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={refreshing}
              onClick={onRefresh}
            >
              {t('pair.again')}
            </Button>
          </div>
        ) : discovered.state === 'signed_out' ? (
          <div className="flex flex-col items-start gap-3 px-4 py-4">
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-primary">
                {t('pair.account.signedOut.title')}
              </p>
              <p className="text-xs text-secondary">{t('pair.account.signedOut.body')}</p>
            </div>
            {onSwitchAccount && (
              <Button type="button" size="sm" variant="secondary" onClick={onSwitchAccount}>
                {t('hosted.signIn.button')}
              </Button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-1 px-4 py-4">
            <p className="text-sm font-medium text-primary">{t('pair.account.empty.title')}</p>
            <p className="text-xs text-secondary">{t('pair.account.empty.body')}</p>
          </div>
        )}
      </div>
    </section>
  )
}

function DiscoveryPairPanel({
  pairing,
  deviceName,
  onConfirm,
  onCancel,
  onRetry,
}: {
  pairing: ActiveDiscoveryPairing
  deviceName: string
  onConfirm?(): void
  onCancel?(): void
  onRetry?(): void
}) {
  const { t } = useTranslation('web')
  const { host, progress, added } = pairing

  if (added) {
    return (
      <div className="flex items-start gap-3 rounded-xl bg-card px-4 py-3.5 shadow-card">
        <Spinner className="mt-0.5" />
        <span className="text-sm" aria-live="polite">
          {t('pair.added')}
        </span>
      </div>
    )
  }

  if (progress.state === 'failed') {
    return (
      <div className="flex flex-col gap-4">
        <Alert variant="error">
          <HugeiconsIcon icon={CancelCircleIcon} strokeWidth={1.9} aria-hidden />
          <AlertDescription>
            {t(`pair.account.failed.${progress.reason}`, { name: host.name })}
          </AlertDescription>
        </Alert>
        <div className="flex gap-2">
          {canRetryDiscoveryFailure(progress.reason) && (
            <Button type="button" onClick={onRetry}>
              {t('pair.again')}
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('pair.back')}
          </Button>
        </div>
      </div>
    )
  }

  const code = progress.state === 'compare' ? progress.code : null
  const matched = progress.state === 'compare' && progress.matched

  return (
    <div className="flex flex-col gap-4 rounded-xl bg-card p-4 shadow-card">
      {code === null ? (
        <div className="flex min-h-18 items-center justify-center rounded-xl bg-subtle text-secondary">
          <Spinner />
        </div>
      ) : (
        <div
          role="img"
          aria-label={t('pair.account.codeLabel', { code: [...code].join(' ') })}
          className="flex min-h-18 items-center justify-center gap-3 rounded-xl bg-subtle px-4 py-3 font-mono text-3xl font-medium tracking-[0.08em] text-primary tabular-nums select-none"
        >
          <span aria-hidden>{code.slice(0, 3)}</span>
          <span aria-hidden>{code.slice(3)}</span>
        </div>
      )}

      <div className="flex flex-col gap-1.5 text-sm" aria-live="polite">
        {progress.state === 'connecting' ? (
          <>
            <span className="font-medium">
              {t('pair.account.pair.connecting', { name: host.name })}
            </span>
            <span className="text-secondary">
              {t('pair.account.pair.intro', { name: host.name })}
            </span>
          </>
        ) : matched ? (
          <>
            <span className="inline-flex items-center gap-2 font-medium">
              <Spinner />
              {t('pair.account.pair.waiting', { name: host.name })}
            </span>
            <span className="text-secondary">
              {t('pair.account.pair.matched', { name: host.name, device: deviceName })}
            </span>
          </>
        ) : (
          <>
            <span className="font-medium">{t('pair.account.pair.check', { name: host.name })}</span>
            <span className="text-secondary">{t('pair.account.pair.differs')}</span>
          </>
        )}
      </div>

      <div className="flex gap-2">
        {!matched && (
          <Button type="button" disabled={code === null} onClick={onConfirm}>
            {t('pair.account.pair.match')}
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('pair.cancel')}
        </Button>
      </div>
    </div>
  )
}

function LinkPairingForm({
  hosted,
  progress,
  link,
  invalid,
  onBack,
  onLink,
  onSubmit,
}: {
  hosted: boolean
  progress: PairProgress | null
  link: string
  invalid: boolean
  onBack?: () => void
  onLink(link: string): void
  onSubmit(event: FormEvent): void
}) {
  const { t } = useTranslation('web')
  return (
    <form className="flex flex-col gap-3" onSubmit={onSubmit}>
      {progress?.state === 'failed' && (
        <Alert variant="error">
          <HugeiconsIcon icon={CancelCircleIcon} strokeWidth={1.9} aria-hidden />
          <AlertDescription>{t(`pair.failed.${progress.reason}`)}</AlertDescription>
        </Alert>
      )}
      <Field data-invalid={invalid || undefined}>
        <FieldLabel htmlFor="pairing-link">{t('pair.linkLabel')}</FieldLabel>
        <Input
          id="pairing-link"
          value={link}
          onChange={(event) => onLink(event.target.value)}
          placeholder={t(hosted ? 'pair.linkPlaceholderHosted' : 'pair.linkPlaceholder')}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-invalid={invalid || undefined}
        />
        {invalid && <FieldError>{t('pair.notLink')}</FieldError>}
      </Field>
      <div className="flex gap-2">
        <Button type="submit" disabled={link.trim() === ''}>
          {progress?.state === 'failed' ? t('pair.again') : t('pair.submit')}
        </Button>
        {onBack && (
          <Button type="button" variant="ghost" onClick={onBack}>
            {t('pair.back')}
          </Button>
        )}
      </div>
    </form>
  )
}

/** On a page opened over plain http, what that leaves open; nothing on https or localhost. */
export function InsecureNote({ className }: { className?: string }) {
  const { t } = useTranslation('web')
  if (typeof window === 'undefined' || window.isSecureContext) return null
  return (
    <Alert variant="warning" className={className}>
      <HugeiconsIcon icon={Shield01Icon} strokeWidth={1.9} aria-hidden />
      <AlertTitle>{t('insecure.title')}</AlertTitle>
      <AlertDescription>{t('insecure.body')}</AlertDescription>
    </Alert>
  )
}
