import { useMemo, useState } from 'react'
import type { PageKey } from '@shared/artifact-runtime/page-messages'
import { useHostHas } from '@renderer/lib/host-features'
import { ArtifactIframe } from './artifact-iframe'
import type { FrameSheet } from './canvas-sheets'
import { useKeyedFrame } from './live-frame'
import { PresentStage } from './present-stage'
import { usePartThumbnail } from './thumbnails'
import { framePageUrl, type ShownVersion } from './use-artifact'

/**
 * Presenting a canvas from `start`, a frame's id or a page's place: every frame live, the next
 * page following the last frame of one, until Esc.
 */
export function CanvasPresent({
  artifactId,
  url,
  shown,
  title,
  sheets,
  start,
  onExit,
}: {
  artifactId: string
  url: string
  shown: Pick<ShownVersion, 'version' | 'loadFrom'>
  title: string
  sheets: FrameSheet[]
  start: string
  onExit: (last: string) => void
}) {
  const byKey = useMemo(() => new Map(sheets.map((s) => [s.key, s])), [sheets])
  const thumbnails = useHostHas('partThumbnails') === true
  return (
    <PresentStage
      title={title}
      sheets={sheets}
      start={start}
      onExit={onExit}
      renderSheet={(sheet, onKey) => {
        const frame = byKey.get(sheet.key)!
        return (
          <PresentFrame
            origin={url.slice(0, -1)}
            src={framePageUrl(url, shown, {
              group: frame.page?.group ?? 0,
              index: frame.page?.index ?? 1,
              file: frame.file,
            })}
            title={sheet.name}
            onKey={onKey}
          />
        )
      }}
      renderThumb={(sheet) =>
        thumbnails && !byKey.get(sheet.key)?.page ? (
          <FrameThumb artifactId={artifactId} version={shown.version} frame={sheet.key} />
        ) : (
          <span className="k-ce-thumb__none">{sheet.name}</span>
        )
      }
    />
  )
}

export function PresentFrame({
  origin,
  src,
  title,
  onKey,
}: {
  origin: string
  src: string
  title: string
  onKey: (key: PageKey) => void
}) {
  const { ref, onLoad } = useKeyedFrame(undefined, null, origin, onKey)
  const [loaded, setLoaded] = useState(false)
  return (
    <ArtifactIframe
      iframeRef={ref}
      src={src}
      title={title}
      onPortReady={onLoad}
      onLoad={() => setLoaded(true)}
      style={{ opacity: loaded ? 1 : 0 }}
    />
  )
}

/** A frame's picture, as the host draws it; its name until then, or where it draws none. */
export function FrameThumb({
  artifactId,
  version,
  frame,
  name,
  inView = true,
}: {
  artifactId: string
  version: number
  frame: string
  name?: string
  inView?: boolean
}) {
  const thumbnail = usePartThumbnail(artifactId, version, { frame }, inView)
  if (thumbnail.state === 'ready') {
    return <img className="k-ce-thumb__img" src={thumbnail.src} alt="" draggable={false} />
  }
  return name ? <span className="k-ce-thumb__none">{name}</span> : null
}
