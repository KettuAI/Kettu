import { useContext, useEffect, useState, type ReactNode } from 'react'
import { CircleAlertIcon, RotateCwIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { MediaGrant } from '@shared/media'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { ProjectPathContext } from '@renderer/features/files/file-refs'
import { FileTypeIcon } from '@renderer/features/files/file-type-icon'
import { errorMessage } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { openMedia, SessionIdContext } from './grants'
import { ImageViewer } from './image-viewer'

/** The tallest an image shows in the thread; the viewer shows it whole. */
const MAX_HEIGHT = 288

type Shown =
  | { kind: 'asking' }
  | { kind: 'granted'; grant: MediaGrant }
  | { kind: 'text' } // not allowed, or not an image: the reference stays as written
  | { kind: 'missing' }
  | { kind: 'unsupported' }
  | { kind: 'failed'; message: string }

function fileName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/**
 * An image a reply names by its path, in place, from the media scheme. Give it `key={path}`, so a
 * different path starts over. See docs/design/ui.md#media.
 */
export function LocalImage({ path, alt }: { path: string; alt: string }) {
  const { t } = useTranslation(['session', 'common'])
  const projectPath = useContext(ProjectPathContext)
  const sessionId = useContext(SessionIdContext)
  const [shown, setShown] = useState<Shown>({ kind: 'asking' })
  // Each retry, and a grant main no longer holds, asks the host again.
  const [asked, setAsked] = useState(0)
  // A picture that fails to load is asked for once more, since main may have dropped its grant.
  const [renewed, setRenewed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [viewing, setViewing] = useState(false)
  const name = fileName(path)

  useEffect(() => {
    if (!projectPath || !sessionId) return
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
  }, [projectPath, sessionId, path, asked])

  const ask = () => {
    setShown({ kind: 'asking' })
    setLoaded(false)
    setAsked((n) => n + 1)
  }
  const retry = () => {
    setRenewed(false)
    ask()
  }

  if (!projectPath || !sessionId || shown.kind === 'text') {
    return <span title={path}>{alt || name}</span>
  }
  if (shown.kind === 'asking') {
    return (
      <span className="inline-block h-24 w-40 animate-in align-top fade-in fill-mode-both delay-200 duration-(--duration-fast)">
        <Skeleton className="size-full rounded-xl" />
      </span>
    )
  }
  if (shown.kind === 'missing' || shown.kind === 'failed' || shown.kind === 'unsupported') {
    const retryButton = (
      <Button variant="outline" size="xs" onClick={retry}>
        <RotateCwIcon />
        {t('common:actions.retry')}
      </Button>
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
    return (
      <Placeholder
        title={
          <span className="flex min-w-0 items-center gap-1.5">
            <FileTypeIcon path={name} className="size-3.5 shrink-0" />
            <span className="truncate">{name}</span>
          </span>
        }
        detail={shown.kind === 'missing' ? t('media.notFound', { path }) : t('media.unsupported')}
        action={shown.kind === 'missing' ? retryButton : null}
      />
    )
  }

  const { grant } = shown
  const box =
    grant.width && grant.height
      ? {
          width: `min(100%, ${grant.width}px, ${(MAX_HEIGHT * grant.width) / grant.height}px)`,
          aspectRatio: `${grant.width} / ${grant.height}`,
        }
      : undefined
  return (
    <>
      <button
        type="button"
        aria-label={t('media.openImage', { name: alt || name })}
        onClick={() => setViewing(true)}
        style={box}
        className={cn(
          'group/media relative mr-1.5 inline-block max-w-full cursor-zoom-in overflow-hidden rounded-xl bg-card align-top focus-ring',
          !box && !loaded && 'size-24',
        )}
      >
        {!loaded && (
          // Shown only when the picture takes a while, so a quick one never flashes.
          <span className="absolute inset-0 animate-in fade-in fill-mode-both delay-200 duration-(--duration-fast)">
            <Skeleton className="size-full rounded-[inherit]" />
          </span>
        )}
        <img
          src={grant.url}
          alt={alt}
          decoding="async"
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => {
            // A grant main dropped answers 404; a fresh one tells that apart from a bad file.
            if (renewed) {
              setShown({ kind: 'unsupported' })
            } else {
              setRenewed(true)
              ask()
            }
          }}
          className={cn(
            'block checkerboard',
            box ? 'size-full object-contain' : 'max-h-[288px] max-w-full',
          )}
        />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-[inset_0_0_0_var(--hairline)_var(--border-default)] transition-shadow duration-(--duration-fast) group-hover/media:shadow-[inset_0_0_0_var(--hairline)_var(--border-strong)]"
        />
      </button>
      <ImageViewer open={viewing} onOpenChange={setViewing} grant={grant} name={name} alt={alt} />
    </>
  )
}

/** A state in the image's place: at least 96 px high, with what happened and what to do. */
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
      {action && <span className="mt-1.5 flex gap-1.5">{action}</span>}
    </span>
  )
}
