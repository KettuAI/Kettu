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
import { errorMessage, host } from '@renderer/lib/host'
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

/** An artifact as a single page in the main area, live, away from the app and the machine. */
export default function ArtifactViewer({ id }: { id: string }) {
  const { t } = useTranslation('artifacts')
  const [attempt, setAttempt] = useState(0)
  const [url, setUrl] = useState<string | null>(null)
  const [shown, setShown] = useState<Shown | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloads, setReloads] = useState(0)
  const connected = useConnectionStore((s) => s.agentHost === 'connected')

  // The window may frame the artifact's origin only between open and close, so close waits for
  // the frame to be gone, which it is by the time React runs this cleanup.
  useEffect(() => {
    let live = true
    let opened: string | null = null
    window.overbench.artifacts.open(id).then(
      (result) => {
        opened = result.url
        if (live) setUrl(result.url)
        else void window.overbench.artifacts.close(result.url).catch(() => {})
      },
      (reason: unknown) => live && setError(errorMessage(reason)),
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
          if (live) setError(errorMessage(reason))
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
    const onKeyDown = (event: KeyboardEvent): void => {
      // Keys typed in the page stay there; Esc goes back only from the app's own page.
      if (event.key !== 'Escape' || event.defaultPrevented || isEditable(event.target)) return
      event.preventDefault()
      closeArtifact()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const retry = (): void => {
    setError(null)
    setUrl(null)
    setAttempt((count) => count + 1)
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
            <TopBarButton label={t('viewer.reload')} onClick={() => setReloads((n) => n + 1)}>
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
              <EmptyDescription>{error}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" size="compact" onClick={retry}>
                {t('viewer.retry')}
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          url && <ArtifactFrame key={url} url={url} title={shown?.title ?? ''} reloads={reloads} />
        )}
      </div>
    </div>
  )
}

/**
 * The page's frame, one per origin: main cancels a frame's navigation from one artifact's origin
 * to another's, so a new artifact always gets a new frame.
 */
function ArtifactFrame({ url, title, reloads }: { url: string; title: string; reloads: number }) {
  const { t } = useTranslation('artifacts')
  const frame = useRef<HTMLIFrameElement>(null)
  const [loaded, setLoaded] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [stopped, setStopped] = useState(false)
  const [blocked, setBlocked] = useState<string | null>(null)
  const origin = url.slice(0, -1)

  useEffect(() => {
    const show = setTimeout(() => setLoaded(true), SHOW_BY_MS)
    const spin = setTimeout(() => setWaiting(true), SPINNER_AFTER_MS)
    return () => {
      clearTimeout(show)
      clearTimeout(spin)
    }
  }, [])

  useEffect(() => {
    const offBlocked = window.overbench.artifacts.onBlocked((event) => {
      if (event.origin !== origin) return
      setBlocked(event.url)
      // The page's own frame left for an error page; it comes back, though its state is gone.
      if (event.reload && frame.current) frame.current.src = url
    })
    const offStopped = window.overbench.artifacts.onStopped((event) => {
      if (event.origin === origin) setStopped(true)
    })
    return () => {
      offBlocked()
      offStopped()
    }
  }, [origin, url])

  // Reloads in place: the frame keeps the old page until the new one commits.
  useEffect(() => {
    if (reloads === 0 || !frame.current) return
    setStopped(false)
    frame.current.src = url
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
          stopped && 'invisible',
        )}
      />
      {!loaded && waiting && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner className="text-muted-foreground" aria-label={t('viewer.loading')} />
        </div>
      )}
      {stopped && (
        <Empty className="absolute inset-0">
          <EmptyHeader>
            <EmptyTitle>{t('viewer.stoppedTitle')}</EmptyTitle>
            <EmptyDescription>{t('viewer.stoppedDescription')}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              variant="outline"
              size="compact"
              onClick={() => {
                setStopped(false)
                if (frame.current) frame.current.src = url
              }}
            >
              {t('viewer.reload')}
            </Button>
          </EmptyContent>
        </Empty>
      )}
      {blocked && blockedHost && !stopped && (
        <div
          role="status"
          className="absolute inset-x-3 top-2.5 flex items-center gap-2.5 rounded-2xl bg-popover py-1.5 pr-1.5 pl-3.5 text-ui shadow-menu"
        >
          <span className="min-w-0 flex-1 truncate text-secondary">
            <Trans
              t={t}
              i18nKey="viewer.blocked"
              values={{ host: blockedHost }}
              components={{ host: <span className="font-medium text-foreground" /> }}
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

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))
}
