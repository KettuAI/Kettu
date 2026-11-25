import { useEffect, useRef, useState } from 'react'
import { Cancel01Icon } from '@hugeicons/core-free-icons'
import { Trans, useTranslation } from 'react-i18next'
import { RUNTIME_VERSION, type DriveMessage } from '@shared/artifact-runtime/page-messages'
import { Icon } from '@renderer/components/affect/app-shell'
import { cn } from '@renderer/lib/utils'
import { ArtifactIframe } from './artifact-iframe'
import { PickLayer } from './canvas-view'
import { useEditorFrame, useEditorState, type ArtifactEditor } from './editor'
import { OpeningCover } from './viewer-states'

/** The page shows once it has loaded, or after this long when a CDN never answers. */
const SHOW_BY_MS = 3_000

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
  scale = 1,
  cover,
  onReady,
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
  /** How much a transform above the frame scales it, so a pick lands where the pointer is. */
  scale?: number
  /** The artifact whose picture covers the wait; false where the one holding the frame shows it. */
  cover?: string | false
  /** Whether the page shows yet, for a cover drawn outside the frame. */
  onReady?: (ready: boolean) => void
}) {
  const { t } = useTranslation('artifacts')
  const frame = useRef<HTMLIFrameElement>(null)
  const driven = useEditorFrame(editor, null)
  const mode = useEditorState(editor).mode
  const [loaded, setLoaded] = useState(false)
  const [blocked, setBlocked] = useState<string | null>(null)
  const [forcedReload, setForcedReload] = useState(0)
  const shownSrc = useRef(src)
  const origin = url.slice(0, -1)

  // A new version loads in the same frame, the page told first so it keeps its scroll.
  useEffect(() => {
    const element = frame.current
    if (src === shownSrc.current || !element) return
    shownSrc.current = src
    const keep: DriveMessage = { v: RUNTIME_VERSION, kind: 'keep-scroll' }
    element.contentWindow?.postMessage(keep, '*')
  }, [src])

  useEffect(() => {
    const show = setTimeout(() => setLoaded(true), SHOW_BY_MS)
    return () => clearTimeout(show)
  }, [])
  useEffect(() => onReady?.(loaded), [loaded, onReady])

  useEffect(
    () =>
      window.kettu.artifacts.onBlocked((event) => {
        if (event.origin !== origin) return
        setBlocked(event.url)
        // The page's own frame left for an error page; it comes back, though its state is gone.
        if (event.reload) setForcedReload((n) => n + 1)
      }),
    [origin],
  )

  const blockedHost = blocked ? URL.parse(blocked)?.host : null

  return (
    <div className={cn('absolute inset-0', className)}>
      <ArtifactIframe
        iframeRef={(el) => {
          frame.current = el
          driven.ref(el)
        }}
        src={src}
        reloadSeq={reloads + forcedReload}
        title={title}
        onPortReady={() => driven.onLoad()}
        onLoad={() => setLoaded(true)}
        className={cn(
          'absolute inset-0 size-full border-0 opacity-0 transition-opacity duration-(--duration-fast)',
          loaded && 'opacity-100',
        )}
      />
      {mode && driven.frame && <PickLayer frame={driven.frame} scale={scale} mode={mode} />}
      {!loaded && cover !== false && <Waiting since={since} id={cover ?? null} />}
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
 * The content's wait, from `since`, so opening and loading show one wait: the artifact's picture,
 * soft, with a band of light crossing it, once the wait passes 0.2 s.
 */
export function Waiting({
  since,
  id = null,
  look = 'sheet',
}: {
  since: number
  id?: string | null
  look?: 'sheet' | 'card'
}) {
  return <OpeningCover id={id} since={since} look={look} />
}

/** A host cut from its start when it does not fit, since its end names the site. */
function HostName({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <span dir="rtl" title={title} className="k-av-blocked__host">
      <bdi dir="ltr">{children}</bdi>
    </span>
  )
}
