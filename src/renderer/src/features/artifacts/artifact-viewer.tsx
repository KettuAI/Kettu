import { useEffect, useRef, useState } from 'react'
import { ArrowLeftIcon, CircleAlertIcon, RefreshCwIcon, XIcon } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { ARTIFACT_FRAME_SANDBOX } from '@shared/artifacts'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@renderer/components/ui/empty'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { NoDrag, TopBar } from '@renderer/features/shell/top-bar'
import { errorCode, host } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { useConnectionStore } from '@renderer/stores/connection'
import { closeArtifact } from '@renderer/stores/view'

/** The page shows once it has loaded, or after this long when a CDN never answers. */
const SHOW_BY_MS = 3_000
/** A wait shorter than this shows nothing, so a quick load does not flash a spinner. */
const SPINNER_AFTER_MS = 200

interface Shown {
  title: string
  version: number
}

type ViewerError = 'notFound' | 'unavailable' | 'failed'

const ERROR_KEYS = {
  notFound: 'viewer.errorNotFound',
  unavailable: 'viewer.errorUnavailable',
  failed: 'viewer.errorFailed',
} as const

/** An artifact as a single page in the main area, live, away from the app and the machine. */
export default function ArtifactViewer({ id }: { id: string }) {
  const { t } = useTranslation('artifacts')
  const [attempt, setAttempt] = useState(0)
  const [url, setUrl] = useState<string | null>(null)
  const [shown, setShown] = useState<Shown | null>(null)
  const [error, setError] = useState<ViewerError | null>(null)
  const [reloads, setReloads] = useState(0)
  const [stopped, setStopped] = useState(false)
  const [since] = useState(() => performance.now())
  const connected = useConnectionStore((s) => s.agentHost === 'connected')

  // The window may frame the artifact's origin only between open and close, so close waits for
  // the frame to be gone, which it is by the time React runs this cleanup.
  useEffect(() => {
    let live = true
    let opened: string | null = null
    window.overbench.artifacts.open(id).then(
      (result) => {
        if ('failed' in result) {
          if (live) setError(result.failed === 'not_found' ? 'notFound' : 'unavailable')
          return
        }
        opened = result.url
        if (live) setUrl(result.url)
        else void window.overbench.artifacts.close(result.url).catch(() => {})
      },
      (reason: unknown) => {
        console.error(`Could not open ${id}`, reason)
        if (live) setError('failed')
      },
    )
    return () => {
      live = false
      if (opened) void window.overbench.artifacts.close(opened).catch(() => {})
    }
  }, [id, attempt])

  // Watched again after the host restarts, which forgets every watch.
  useEffect(() => {
    if (!connected) return
    let live = true
    const read = (): Promise<void> =>
      host('artifacts.read', { id }).then(
        ({ title, version }) => {
          if (live) setShown({ title, version })
        },
        (reason: unknown) => {
          if (live) setError(readError(reason))
        },
      )
    void read()
    void host('artifacts.watch', { id }).catch(() => {})
    const off = window.overbench.agents.onEvent((event) => {
      if (event.type !== 'artifacts.version' || event.id !== id) return
      void read()
      setReloads((count) => count + 1)
    })
    return () => {
      live = false
      off()
      void host('artifacts.unwatch', { id }).catch(() => {})
    }
  }, [id, connected, attempt])

  useEffect(() => {
    if (!url) return
    const origin = url.slice(0, -1)
    return window.overbench.artifacts.onStopped((event) => {
      if (event.origin === origin) setStopped(true)
    })
  }, [url])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Keys typed in the page stay there; Esc goes back only from the app's own page.
      if (event.key !== 'Escape' || event.defaultPrevented || isEditable(event.target)) return
      event.preventDefault()
      closeArtifact()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // A frame starts with no reloads, or it would load its page twice.
  const retry = (): void => {
    setError(null)
    setUrl(null)
    setStopped(false)
    setReloads(0)
    setAttempt((count) => count + 1)
  }

  // A stopped page comes back in a new frame: Chromium shows a page reloaded into the old one in
  // the light theme, whatever the app's.
  const restart = (): void => {
    setStopped(false)
    setReloads(0)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar>
        <NoDrag className="-ml-2.5 min-w-0 gap-1.5">
          <TopBarButton label={t('viewer.back')} shortcut="Esc" onClick={closeArtifact}>
            <ArrowLeftIcon />
          </TopBarButton>
          {shown && (
            <>
              <h1 className="min-w-0 truncate px-1.5 text-ui font-medium">{shown.title}</h1>
              <span className="shrink-0 text-xs text-secondary tabular-nums">
                {t('viewer.version', { version: shown.version })}
              </span>
            </>
          )}
        </NoDrag>
        <span className="flex-1" />
        {url && !error && (
          <NoDrag>
            <TopBarButton
              label={t('viewer.reload')}
              onClick={() => (stopped ? restart() : setReloads((n) => n + 1))}
            >
              <RefreshCwIcon />
            </TopBarButton>
          </NoDrag>
        )}
      </TopBar>
      <div className="relative min-h-0 flex-1 bg-background">
        {error ? (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CircleAlertIcon className="text-danger" />
              </EmptyMedia>
              <EmptyTitle>{t('viewer.errorTitle')}</EmptyTitle>
              <EmptyDescription>{t(ERROR_KEYS[error])}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" size="compact" onClick={retry}>
                {t('viewer.retry')}
              </Button>
            </EmptyContent>
          </Empty>
        ) : stopped ? (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyTitle>{t('viewer.stoppedTitle')}</EmptyTitle>
              <EmptyDescription>{t('viewer.stoppedDescription')}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" size="compact" onClick={restart}>
                {t('viewer.reload')}
              </Button>
            </EmptyContent>
          </Empty>
        ) : url ? (
          <ArtifactFrame
            key={url}
            url={url}
            title={shown?.title ?? ''}
            reloads={reloads}
            since={since}
          />
        ) : (
          <Waiting since={since} />
        )}
      </div>
    </div>
  )
}

/**
 * The page's frame, one per origin: main cancels a frame's navigation from one artifact's origin
 * to another's, so a new artifact always gets a new frame.
 */
function ArtifactFrame({
  url,
  title,
  reloads,
  since,
}: {
  url: string
  title: string
  reloads: number
  since: number
}) {
  const { t } = useTranslation('artifacts')
  const frame = useRef<HTMLIFrameElement>(null)
  const [loaded, setLoaded] = useState(false)
  const [blocked, setBlocked] = useState<string | null>(null)
  const origin = url.slice(0, -1)

  useEffect(() => {
    const show = setTimeout(() => setLoaded(true), SHOW_BY_MS)
    return () => clearTimeout(show)
  }, [])

  useEffect(
    () =>
      window.overbench.artifacts.onBlocked((event) => {
        if (event.origin !== origin) return
        setBlocked(event.url)
        // The page's own frame left for an error page; it comes back, though its state is gone.
        if (event.reload && frame.current) frame.current.src = url
      }),
    [origin, url],
  )

  // Reloads in place: the frame keeps the old page until the new one commits.
  useEffect(() => {
    if (reloads > 0 && frame.current) frame.current.src = url
  }, [reloads, url])

  const blockedHost = blocked ? URL.parse(blocked)?.host : null

  return (
    <>
      <iframe
        ref={frame}
        src={url}
        title={title}
        sandbox={ARTIFACT_FRAME_SANDBOX}
        allow=""
        referrerPolicy="no-referrer"
        onLoad={() => setLoaded(true)}
        className={cn(
          'absolute inset-0 size-full border-0 opacity-0 transition-opacity duration-(--duration-fast)',
          loaded && 'opacity-100',
        )}
      />
      {!loaded && <Waiting since={since} />}
      {blocked && blockedHost && (
        <div
          role="status"
          className="absolute inset-x-3 top-2.5 flex items-center gap-2.5 rounded-2xl bg-popover py-1.5 pr-1.5 pl-3.5 text-ui shadow-menu"
        >
          <span className="flex min-w-0 flex-1 whitespace-pre text-secondary">
            <Trans
              t={t}
              i18nKey="viewer.blocked"
              values={{ host: blockedHost }}
              components={{ host: <HostName title={blockedHost} /> }}
            />
          </span>
          <a
            href={blocked}
            target="_blank"
            rel="noreferrer"
            onClick={() => setBlocked(null)}
            className={buttonVariants({ variant: 'outline', size: 'compact' })}
          >
            {t('viewer.openInBrowser')}
          </a>
          <Button
            variant="quiet"
            size="icon"
            aria-label={t('viewer.dismiss')}
            onClick={() => setBlocked(null)}
          >
            <XIcon />
          </Button>
        </div>
      )}
    </>
  )
}

/**
 * A spinner once the wait that began at `since` passes SPINNER_AFTER_MS, so a quick load shows
 * nothing, and opening and loading show one wait.
 */
function Waiting({ since }: { since: number }) {
  const { t } = useTranslation('artifacts')
  const [shown, setShown] = useState(false)

  useEffect(() => {
    const timer = setTimeout(
      () => setShown(true),
      Math.max(0, since + SPINNER_AFTER_MS - performance.now()),
    )
    return () => clearTimeout(timer)
  }, [since])

  if (!shown) return null
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <Spinner className="text-muted-foreground" aria-label={t('viewer.loading')} />
    </div>
  )
}

/** A host cut from its start when it does not fit, since its end names the site. */
function HostName({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <span dir="rtl" title={title} className="min-w-0 truncate font-medium text-foreground">
      <bdi dir="ltr">{children}</bdi>
    </span>
  )
}

function TopBarButton({
  label,
  shortcut,
  onClick,
  children,
}: {
  label: string
  shortcut?: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="quiet"
            size="icon-compact"
            aria-label={label}
            onClick={onClick}
            className="text-foreground"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label} {shortcut && <span className="opacity-60">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  )
}

function readError(reason: unknown): ViewerError {
  const code = errorCode(reason)
  if (code === 'not_found') return 'notFound'
  if (code === 'host_restarted') return 'unavailable'
  console.error('Could not read the artifact', reason)
  return 'failed'
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))
}
