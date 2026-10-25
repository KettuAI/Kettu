import { useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { CircleAlertIcon, ExternalLinkIcon, FolderIcon, RotateCwIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { mediaKindOfName, type MediaGrant, type MediaKind } from '@shared/media'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { ProjectPathContext } from '@renderer/features/files/file-refs'
import { FileTypeIcon } from '@renderer/features/files/file-type-icon'
import { errorMessage } from '@renderer/lib/host'
import { fileManagerName } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { VIDEO_BOX } from './boxes'
import { openMedia, SessionIdContext } from './grants'
import { LocalAudio } from './local-audio'
import { LocalImage } from './local-image'
import { LocalVideo } from './local-video'
import { NamedMediaContext } from './named'
import { useNearView } from './near-view'

type Shown =
  | { kind: 'asking' }
  | { kind: 'granted'; grant: MediaGrant }
  | { kind: 'text' } // not allowed, or not media: the reference stays as written
  | { kind: 'missing' }
  | { kind: 'unsupported'; grant: MediaGrant }
  | { kind: 'failed'; message: string }

function fileName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/**
 * A media file a reply names by its path, from the media scheme: an image in place, a clip or a
 * sound with Chromium's players. It asks for its grant once it nears the view. `image` marks a
 * Markdown image, which the blocks of its message then leave out; without it, a file that cannot
 * be shown renders nothing. Give it `key={path}`, so a
 * different path starts over.
 */
export function LocalMedia({
  path,
  alt = '',
  image = false,
}: {
  path: string
  alt?: string
  image?: boolean
}) {
  const projectPath = useContext(ProjectPathContext)
  const sessionId = useContext(SessionIdContext)
  const named = useContext(NamedMediaContext)
  const enabled = !!projectPath && !!sessionId
  const ref = useRef<HTMLSpanElement>(null)
  const near = useNearView(ref, enabled)
  const [shown, setShown] = useState<Shown>({ kind: 'asking' })
  // Each retry, and a grant main no longer holds, asks the host again.
  const [asked, setAsked] = useState(0)
  // A file that fails to load is asked for once more, since main may have dropped its grant.
  const [renewed, setRenewed] = useState(false)
  const name = fileName(path)
  const nominated = mediaKindOfName(name) ?? 'image'

  useEffect(
    () => (image && enabled && named ? named.image(path) : undefined),
    [image, enabled, named, path],
  )

  useEffect(() => {
    if (!projectPath || !sessionId || !near) return
    let current = true
    openMedia(projectPath, path, sessionId, asked > 0).then(
      (result) => {
        if (!current) return
        if (result.kind === 'granted') setShown({ kind: 'granted', grant: result.grant })
        else setShown({ kind: result.kind === 'not_found' ? 'missing' : 'text' })
      },
      (error: unknown) => {
        if (current) setShown({ kind: 'failed', message: errorMessage(error) })
      },
    )
    return () => {
      current = false
    }
  }, [projectPath, sessionId, path, asked, near])

  const ask = () => {
    setShown({ kind: 'asking' })
    setAsked((n) => n + 1)
  }
  const retry = () => {
    setRenewed(false)
    ask()
  }
  // A grant main dropped answers 404; a fresh one tells that apart from a bad file.
  const failed = (grant: MediaGrant, message: string | null) => {
    if (!renewed) {
      setRenewed(true)
      ask()
    } else if (message) setShown({ kind: 'failed', message })
    else setShown({ kind: 'unsupported', grant })
  }

  if (!enabled || shown.kind === 'text') {
    // Under a block the reference stays the chip or link it was in the sentence.
    return image ? <span title={path}>{alt || name}</span> : null
  }
  if (shown.kind === 'asking') {
    return (
      <span
        ref={ref}
        className={cn('align-top', LOADING[nominated])}
        style={loadingStyle(nominated)}
      >
        <span className="block size-full animate-in fade-in fill-mode-both delay-200 duration-(--duration-fast)">
          <Skeleton
            className={cn('size-full', nominated === 'audio' ? 'rounded-full' : 'rounded-xl')}
          />
        </span>
      </span>
    )
  }
  if (shown.kind === 'granted') {
    const { grant } = shown
    if (grant.kind === 'video') {
      return (
        <LocalVideo
          path={path}
          name={name}
          grant={grant}
          onFailed={(message) => failed(grant, message)}
        />
      )
    }
    if (grant.kind === 'audio') {
      return (
        <LocalAudio
          path={path}
          name={name}
          grant={grant}
          onFailed={(message) => failed(grant, message)}
        />
      )
    }
    return <LocalImage name={name} alt={alt} grant={grant} onFailed={() => failed(grant, null)} />
  }
  return <MediaState shown={shown} path={path} name={name} onRetry={retry} />
}

const LOADING: Record<MediaKind, string> = {
  image: 'inline-block h-24 w-40',
  video: 'block max-w-full',
  audio: 'block h-13.5 w-full max-w-[420px]',
}

function loadingStyle(kind: MediaKind) {
  return kind === 'video' ? VIDEO_BOX : undefined
}

/** Missing, unreadable or a format Chromium cannot play, in the item's place. */
function MediaState({
  shown,
  path,
  name,
  onRetry,
}: {
  shown: Extract<Shown, { kind: 'missing' | 'unsupported' | 'failed' }>
  path: string
  name: string
  onRetry: () => void
}) {
  const { t } = useTranslation(['session', 'common'])
  const [error, setError] = useState<string | null>(null)
  const retryButton = (
    <Button variant="outline" size="xs" onClick={onRetry}>
      <RotateCwIcon />
      {t('common:actions.retry')}
    </Button>
  )
  const title = (
    <span className="flex min-w-0 items-center gap-1.5">
      <FileTypeIcon path={name} className="size-3.5 shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  )
  if (shown.kind === 'failed') {
    return (
      <Placeholder
        title={
          <span className="flex items-center gap-1.5 text-danger">
            <CircleAlertIcon className="size-3.5 shrink-0" />
            {t('media.cannotRead', { name })}
          </span>
        }
        detail={<span className="font-mono text-meta">{shown.message}</span>}
        action={retryButton}
      />
    )
  }
  if (shown.kind === 'missing') {
    return <Placeholder title={title} detail={t('media.notFound', { path })} action={retryButton} />
  }
  const { grant } = shown
  const act = (action: (url: string) => Promise<void>) => () => {
    setError(null)
    action(grant.url).catch((e: unknown) => setError(errorMessage(e)))
  }
  return (
    <Placeholder
      title={title}
      detail={
        <>
          {grant.kind === 'video'
            ? t('media.unsupportedVideo')
            : grant.kind === 'audio'
              ? t('media.unsupportedAudio')
              : t('media.unsupported')}
          {error && <span className="block text-danger">{error}</span>}
        </>
      }
      action={
        <>
          <Button variant="outline" size="xs" onClick={act(window.overbench.media.openExternal)}>
            <ExternalLinkIcon />
            {t('media.openWithDefault')}
          </Button>
          <Button variant="outline" size="xs" onClick={act(window.overbench.media.reveal)}>
            <FolderIcon />
            {t('media.showIn', { name: fileManagerName() })}
          </Button>
        </>
      }
    />
  )
}

/** A state in the item's place: at least 96 px high, with what happened and what to do. */
function Placeholder({
  title,
  detail,
  action,
}: {
  title: ReactNode
  detail: ReactNode
  action: ReactNode
}) {
  return (
    <span className="flex min-h-24 max-w-md flex-col justify-center gap-1 rounded-xl bg-card px-3.5 py-3 shadow-[inset_0_0_0_var(--hairline)_var(--border-default)]">
      <span className="text-ui font-medium text-foreground">{title}</span>
      <span className="text-small break-all text-muted-foreground">{detail}</span>
      {action && <span className="mt-1.5 flex flex-wrap gap-1.5">{action}</span>}
    </span>
  )
}
