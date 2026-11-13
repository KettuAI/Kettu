import { useEffect, useRef, useState } from 'react'
import { Cancel01Icon } from '@hugeicons/core-free-icons'
import { Trans, useTranslation } from 'react-i18next'
import { RUNTIME_VERSION, type DriveMessage } from '@shared/artifact-runtime/page-messages'
import { ARTIFACT_FRAME_SANDBOX, WEB_ARTIFACT_FRAME_SANDBOX } from '@shared/artifacts'
import { Icon } from '@renderer/components/affect/app-shell'
import { Spinner } from '@renderer/components/ui/spinner'
import { isWeb } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { PickLayer } from './canvas-view'
import { useEditorFrame, useEditorState, type ArtifactEditor } from './editor'

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
  editor,
}: {
  /** The artifact's origin, as `artifact:open` gave it. */
  url: string
  src: string
  title: string
  /** Counts Reload presses after the frame appeared. */
  reloads: number
  since: number
  className?: string
  /** Select and comment mode, where the viewer or the pane shows them. */
  editor?: ArtifactEditor
}) {
  const { t } = useTranslation('artifacts')
  const frame = useRef<HTMLIFrameElement>(null)
  const driven = useEditorFrame(editor, null)
  const mode = useEditorState(editor).mode
  const [loaded, setLoaded] = useState(false)
  const [blocked, setBlocked] = useState<string | null>(null)
  const [mountedAt] = useState(reloads)
  const [firstSrc] = useState(src)
  const shownSrc = useRef(src)
  const origin = url.slice(0, -1)

  // A new version loads in the same frame, the page told first so it keeps its scroll.
  useEffect(() => {
    const element = frame.current
    if (src === shownSrc.current || !element) return
    shownSrc.current = src
    const keep: DriveMessage = { v: RUNTIME_VERSION, kind: 'keep-scroll' }
    element.contentWindow?.postMessage(keep, '*')
    element.src = src
  }, [src])

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
        ref={(el) => {
          frame.current = el
          driven.ref(el)
        }}
        src={firstSrc}
        title={title}
        sandbox={isWeb ? WEB_ARTIFACT_FRAME_SANDBOX : ARTIFACT_FRAME_SANDBOX}
        allow=""
        referrerPolicy="no-referrer"
        onLoad={() => {
          setLoaded(true)
          driven.onLoad()
        }}
        className={cn(
          'absolute inset-0 size-full border-0 opacity-0 transition-opacity duration-(--duration-fast)',
          loaded && 'opacity-100',
        )}
      />
      {mode && driven.frame && <PickLayer frame={driven.frame} scale={1} mode={mode} />}
      {!loaded && <Waiting since={since} />}
      {blocked && blockedHost && (
        <div role="status" className="k-av-blocked">
          <span className="k-av-blocked__text">
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
            className="ui-as-tool ui-as-tool--label"
          >
            {t('viewer.openInBrowser')}
          </a>
          <button
            type="button"
            aria-label={t('viewer.dismiss')}
            title={t('viewer.dismiss')}
            onClick={() => setBlocked(null)}
            className="ui-as-icon-btn k-av-btn"
          >
            <Icon icon={Cancel01Icon} size={15} />
          </button>
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
    <span dir="rtl" title={title} className="k-av-blocked__host">
      <bdi dir="ltr">{children}</bdi>
    </span>
  )
}
