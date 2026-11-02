import { useRef } from 'react'
import { DownloadIcon, ExternalLinkIcon, FolderIcon, RotateCwIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { mediaKindOfName, type MediaKind } from '@shared/media'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { errorMessage } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { fileManagerName, isWeb } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { VIDEO_BOX } from './boxes'
import { FileCard, FileCardButton, MediaFileCard } from './file-card'
import { MEDIA_MAX_WIDTH } from './frame'
import { fileType, mediaRows } from './layout'
import { LocalAudio } from './local-audio'
import { LocalImage } from './local-image'
import { LocalVideo } from './local-video'
import { MediaGrid } from './media-grid'
import { useMediaFile, type Shown } from './use-media-file'

/**
 * A media file a reply names by its path, from the media scheme: an image in its frame, a clip
 * behind its poster, a sound with Chromium's player, or a file card for one that shows no
 * preview. It asks for its grant once it nears the view. `image` marks a Markdown image, which
 * the blocks of its message then leave out; without it, a file that cannot be shown renders
 * nothing. Give it `key={path}`, so a different path starts over.
 */
export function LocalMedia({
  path,
  alt = '',
  image = false,
  imageHeight,
}: {
  path: string
  alt?: string
  image?: boolean
  /** The tallest an image shows, when not as in a reply. */
  imageHeight?: number
}) {
  const near = useRef<HTMLSpanElement>(null)
  const media = useMediaFile(path, image, near)
  const { shown, name } = media
  const nominated = mediaKindOfName(name) ?? 'image'

  if (!media.enabled || shown.kind === 'text') {
    // Under a block the reference stays the chip or link it was in the sentence.
    return image ? <span title={path}>{alt || name}</span> : null
  }
  if (shown.kind === 'asking') {
    return (
      <span
        ref={near}
        className={cn('align-top', LOADING[nominated])}
        style={nominated === 'video' ? { ...VIDEO_BOX, maxWidth: MEDIA_MAX_WIDTH } : undefined}
      >
        <span className="block size-full animate-in fade-in fill-mode-both delay-200 duration-(--duration-fast)">
          <Skeleton
            render={<span />}
            className={cn(
              'block size-full',
              nominated === 'audio' ? 'rounded-full' : 'rounded-code',
            )}
          />
        </span>
      </span>
    )
  }
  if (shown.kind === 'granted' && shown.grant.tooLarge) {
    return <MediaFileCard path={path} name={name} grant={shown.grant} reason="tooLarge" />
  }
  if (shown.kind === 'granted') {
    const { grant } = shown
    if (grant.kind === 'video') {
      return (
        <LocalVideo
          media={{ kind: 'file', path, grant }}
          name={name}
          viewerKey={media.viewerKey}
          onOpen={(from) => media.open(from, alt)}
          onFailed={(message) => media.failed(grant, message)}
        />
      )
    }
    if (grant.kind === 'audio') {
      return (
        <LocalAudio
          media={{ kind: 'file', path, grant }}
          name={name}
          onFailed={(message) => media.failed(grant, message)}
        />
      )
    }
    return (
      <LocalImage
        name={name}
        alt={alt}
        grant={grant}
        viewerKey={media.viewerKey}
        maxHeight={imageHeight}
        onOpen={(from) => media.open(from, alt)}
        onFailed={() => media.failed(grant, null)}
      />
    )
  }
  if (shown.kind === 'unsupported') {
    return <MediaFileCard path={path} name={name} grant={shown.grant} reason={shown.grant.kind} />
  }
  return <MediaState shown={shown} path={path} name={name} onRetry={media.retry} />
}

/**
 * The media files a block shows under it, in its order: two or more pictures as one grid, every
 * other file in its own row.
 */
export function MediaRows({ paths }: { paths: readonly string[] }) {
  return mediaRows(paths).map((row) =>
    row.kind === 'grid' ? (
      // A block has one grid, which keeps its tiles as pictures join it.
      <MediaGrid key="grid" paths={row.paths} />
    ) : (
      <LocalMedia key={row.path} path={row.path} />
    ),
  )
}

const LOADING: Record<MediaKind, string> = {
  image: 'inline-block h-24 w-40',
  video: 'block w-full',
  audio: 'block h-13.5 w-full max-w-[420px]',
}

/** A file that is missing or unreadable, as a file card that can ask again. */
function MediaState({
  shown,
  path,
  name,
  onRetry,
}: {
  shown: Extract<Shown, { kind: 'missing' | 'failed' }>
  path: string
  name: string
  onRetry: () => void
}) {
  const { t } = useTranslation(['session', 'common'])
  return (
    <FileCard
      name={name}
      title={path}
      type={fileType(name)}
      meta={
        shown.kind === 'failed'
          ? t('media.cannotReadShort', { message: shown.message })
          : t('media.notFound', { path })
      }
      danger={shown.kind === 'failed'}
      actions={
        <FileCardButton label={t('common:actions.retry')} onClick={onRetry}>
          <RotateCwIcon className="size-3.5" />
        </FileCardButton>
      }
    />
  )
}

/** What a file in a format Chromium cannot show or play says, by its kind. */
export function UnsupportedReason({ kind }: { kind: MediaKind }) {
  const { t } = useTranslation('session')
  if (kind === 'video') return t('media.unsupportedVideo')
  return kind === 'audio' ? t('media.unsupportedAudio') : t('media.unsupported')
}

/** Open with default app and Show in the file manager: the ways out for such a file. */
export function PlayElsewhere({
  url,
  projectPath,
  onError,
}: {
  url: string
  /** The project the file is in, whose host may be another one. */
  projectPath: string | null
  onError: (message: string | null) => void
}) {
  const { t } = useTranslation('session')
  const act = (action: (url: string) => Promise<unknown>) => () => {
    onError(null)
    action(url).catch((e: unknown) => onError(errorMessage(e)))
  }
  // A browser has no app or file manager of the host's, nor has this computer of another host's;
  // the file can only be saved.
  if (isWeb || (projectPath !== null && hostOfPath(projectPath) !== null)) {
    return (
      <Button variant="outline" size="xs" onClick={act(window.kettu.media.saveAs)}>
        <DownloadIcon />
        {t('media.saveAs')}
      </Button>
    )
  }
  return (
    <>
      <Button variant="outline" size="xs" onClick={act(window.kettu.media.openExternal)}>
        <ExternalLinkIcon />
        {t('media.openWithDefault')}
      </Button>
      <Button variant="outline" size="xs" onClick={act(window.kettu.media.reveal)}>
        <FolderIcon />
        {t('media.showIn', { name: fileManagerName() })}
      </Button>
    </>
  )
}
