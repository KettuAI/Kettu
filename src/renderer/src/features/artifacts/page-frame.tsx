import { useEffect, useRef, useState } from 'react'
import { XIcon } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { ARTIFACT_FRAME_SANDBOX } from '@shared/artifacts'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'

/** The page shows once it has loaded, or after this long when a CDN never answers. */
const SHOW_BY_MS = 3_000
/** A wait shorter than this shows nothing, so a quick load does not flash a spinner. */
const SPINNER_AFTER_MS = 200

/**
 * A single page's frame, filling its area, with the bar for a navigation main blocked. One frame
 * per origin: main cancels a frame's navigation from one artifact's origin to another's, so a new
 * artifact always gets a new frame.
 */
export function PageFrame({
  url,
  src,
  title,
  reloads,
  since,
  className,
}: {
  /** The artifact's origin, as `artifact:open` gave it. */
  url: string
  src: string
  title: string
  /** Counts Reload presses after the frame appeared. */
  reloads: number
  since: number
  className?: string
}) {
  const { t } = useTranslation('artifacts')
  const frame = useRef<HTMLIFrameElement>(null)
  const [loaded, setLoaded] = useState(false)
  const [blocked, setBlocked] = useState<string | null>(null)
  const [mountedAt] = useState(reloads)
  const origin = url.slice(0, -1)

  useEffect(() => {
    const show = setTimeout(() => setLoaded(true), SHOW_BY_MS)
    return () => clearTimeout(show)
  }, [])

  useEffect(
    () =>
      window.kettu.artifacts.onBlocked((event) => {
        if (event.origin !== origin) return
        setBlocked(event.url)
        // The page's own frame left for an error page; it comes back, though its state is gone.
        if (event.reload && frame.current) frame.current.src = src
      }),
    [origin, src],
  )

  // Reloads in place: the frame keeps the old page until the new one commits.
  useEffect(() => {
    if (reloads !== mountedAt && frame.current) frame.current.src = src
  }, [reloads, mountedAt, src])

  const blockedHost = blocked ? URL.parse(blocked)?.host : null

  return (
    <div className={cn('absolute inset-0', className)}>
      <iframe
        ref={frame}
        src={src}
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
          className="absolute inset-x-3 top-2.5 flex items-center gap-2.5 rounded-xl bg-popover py-1.5 pr-1.5 pl-3.5 text-ui shadow-menu"
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
    </div>
  )
}

/**
 * A spinner once the wait that began at `since` passes SPINNER_AFTER_MS, so a quick load shows
 * nothing, and opening and loading show one wait.
 */
export function Waiting({ since }: { since: number }) {
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
