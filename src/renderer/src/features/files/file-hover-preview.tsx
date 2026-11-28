import {
  cloneElement,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react'
import {
  Alert02Icon,
  ArrowUpRight01Icon,
  File01Icon,
  FileNotFoundIcon,
  Folder01Icon,
  Image01Icon,
  RotateClockwiseIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { FileContent } from '@shared/files'
import type { MediaGrant } from '@shared/media'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { useDark } from '@renderer/hooks/use-dark'
import { useNoHover } from '@renderer/hooks/use-no-hover'
import { bytes } from '@renderer/lib/format'
import { errorCode, errorMessage } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { useThemesStore } from '@renderer/stores/themes'
import {
  getCachedFilePreview,
  previewSourceKey,
  readFilePreview,
  type FilePreviewSource,
} from './file-hover-cache'
import { highlightPreviewLines, previewTokenStyle, type PreviewToken } from './file-hover-highlight'
import {
  computePreviewScrollTop,
  FILE_HOVER_CLOSE_DELAY_MS,
  FILE_HOVER_OPEN_DELAY_MS,
  formatLineRange,
  slicePreviewText,
  type LineRange,
  type PreviewTextSlice,
} from './file-hover-model'
import { FileTypeIcon } from './file-type-icon'
import { folderOf, nameOf } from './paths'

type HoverAnchor = ComponentProps<typeof HoverCardContent>['anchor']

export type FileHoverPreviewKind = 'file' | 'folder' | 'image' | 'missing'

export interface FileHoverPreviewCardProps {
  /** Project or agent file source; null for folders, external attachments, or missing entries. */
  source: FilePreviewSource | null
  /** Display path shown in the header (relative for project files, absolute for agent files). */
  path: string
  /** Optional 1-based inclusive line range to highlight and scroll to. */
  range?: LineRange | null
  /** Entry kind when no host file read is needed (folder, attached image, missing). */
  kind?: FileHoverPreviewKind
  /** Pre-existing thumbnail URL for image chips whose bytes are carried as an attachment. */
  thumb?: string | null
  /** Optional file size in bytes for external attachments. */
  size?: number | null
  /** Optional custom message for missing entries. */
  missingMessage?: string | null
  /** Opens the file in the Files pane (or default target); shown as a compact header button. */
  onOpen?: (() => void) | null
  /** Preloaded content override, mainly useful for deterministic rendering and tests. */
  initialContent?: FileContent | null
  /** Preloaded error override, mainly useful for deterministic rendering and tests. */
  initialError?: unknown
}

export interface FileHoverPreviewProps extends FileHoverPreviewCardProps {
  /** Controlled open state; when omitted, the component manages its own open state. */
  open?: boolean
  /** Controlled open state callback. */
  onOpenChange?: (open: boolean) => void
  /** Suppresses the hover card while another overlay such as a context menu is open. */
  suppressed?: boolean
  /** Optional virtual anchor (such as the first line rect of a wrapped inline link). */
  anchor?: HoverAnchor
  /** Trigger element passed to HoverCardTrigger `render`. */
  trigger: ReactElement<Record<string, unknown>>
  /** Trigger children rendered inside `trigger`. */
  children?: ReactNode
}

/**
 * Desktop-only interactive hover preview for thread file references.
 * On touch/no-hover devices (`useNoHover() === true`), renders the trigger directly with no
 * HoverCard wrapper so mobile and touch interactions stay completely untouched.
 */
export function FileHoverPreview({
  open: controlledOpen,
  onOpenChange,
  suppressed = false,
  anchor,
  trigger,
  children,
  onOpen,
  ...cardProps
}: FileHoverPreviewProps) {
  const noHover = useNoHover()
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next)
    onOpenChange?.(next)
  }

  if (noHover) {
    return children !== undefined && isValidElement(trigger)
      ? cloneElement(trigger, undefined, children)
      : trigger
  }

  const isOpen = open && !suppressed
  const handleOpen = onOpen
    ? () => {
        setOpen(false)
        onOpen()
      }
    : null

  return (
    <HoverCard open={isOpen} onOpenChange={(next) => setOpen(next && !suppressed)}>
      <HoverCardTrigger
        delay={FILE_HOVER_OPEN_DELAY_MS}
        closeDelay={FILE_HOVER_CLOSE_DELAY_MS}
        render={trigger}
      >
        {children}
      </HoverCardTrigger>
      <HoverCardContent
        anchor={anchor}
        align="start"
        side="bottom"
        sideOffset={6}
        className="flex max-h-[min(400px,calc(100vh-32px))] w-[min(540px,calc(100vw-24px))] flex-col overflow-hidden p-0"
      >
        {isOpen && <FileHoverPreviewCard {...cardProps} onOpen={handleOpen} />}
      </HoverCardContent>
    </HoverCard>
  )
}

interface LoadState {
  key: string
  content: FileContent | null
  error: unknown
}

/**
 * Scrollable file preview card shown inside the hover popover: compact path header, optional
 * line-range badge, quick open action, and bounded scrollable code/image/meta preview body.
 */
export function FileHoverPreviewCard({
  source,
  path,
  range = null,
  kind = 'file',
  thumb = null,
  size = null,
  missingMessage = null,
  onOpen = null,
  initialContent,
  initialError,
}: FileHoverPreviewCardProps) {
  const { t } = useTranslation('files')
  const [reloadCount, setReloadCount] = useState(0)
  const [loaded, setLoaded] = useState<LoadState | null>(null)
  const shouldFetch =
    source !== null &&
    kind !== 'folder' &&
    kind !== 'missing' &&
    initialContent === undefined &&
    initialError === undefined
  const cacheKey = source ? previewSourceKey(source) : null
  const requestKey = cacheKey ? `${cacheKey}#${reloadCount}` : null
  const cached = useMemo(
    () => (shouldFetch && source && reloadCount === 0 ? getCachedFilePreview(source) : null),
    [shouldFetch, source, reloadCount],
  )

  useEffect(() => {
    if (!shouldFetch || !source || !requestKey || cached !== null) return
    let active = true
    void readFilePreview(source, { force: reloadCount > 0 }).then(
      (content) => {
        if (active) setLoaded({ key: requestKey, content, error: null })
      },
      (error: unknown) => {
        if (active) setLoaded({ key: requestKey, content: null, error })
      },
    )
    return () => {
      active = false
    }
  }, [shouldFetch, source, requestKey, cached, reloadCount])

  const content =
    initialContent !== undefined
      ? initialContent
      : cached !== null
        ? cached
        : loaded?.key === requestKey
          ? loaded.content
          : null
  const error =
    initialError !== undefined
      ? initialError
      : cached !== null
        ? null
        : loaded?.key === requestKey
          ? loaded.error
          : null
  const loading = shouldFetch && content === null && error === null

  const fileName = nameOf(path) || path
  const folder = folderOf(path)
  const lineRangeText = formatLineRange(range)

  return (
    <div data-file-hover-preview="" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-subtle px-3 py-2">
        {kind === 'folder' ? (
          <HugeiconsIcon
            icon={Folder01Icon}
            size={15}
            strokeWidth={1.9}
            aria-hidden
            className="shrink-0 text-tertiary"
          />
        ) : (
          <FileTypeIcon path={path} className="size-4 shrink-0" />
        )}
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5" title={path}>
          <span className="shrink-0 text-small font-medium text-primary">{fileName}</span>
          {folder && (
            <span className="min-w-0 truncate font-mono text-caption text-tertiary">{folder}</span>
          )}
        </div>
        {lineRangeText && (
          <span
            data-preview-range=""
            className="shrink-0 rounded-sm bg-control-on-tint px-1.5 py-0.5 font-mono text-caption text-control-on tabular"
          >
            {t('hoverPreview.lineBadge', { lines: lineRangeText })}
          </span>
        )}
        {onOpen && (
          <button
            type="button"
            data-preview-open=""
            aria-label={t('hoverPreview.openInFiles')}
            onClick={onOpen}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-caption font-medium text-secondary transition-colors hover:bg-hover hover:text-primary focus-visible:focus-ring"
          >
            <span>{t('hoverPreview.openInFiles')}</span>
            <HugeiconsIcon icon={ArrowUpRight01Icon} size={13} strokeWidth={1.9} aria-hidden />
          </button>
        )}
      </div>

      <PreviewBody
        path={path}
        kind={kind}
        range={range}
        thumb={thumb}
        size={size}
        missingMessage={missingMessage}
        loading={loading}
        content={content}
        error={error}
        contentKey={requestKey ?? path}
        onOpen={onOpen}
        onRetry={() => setReloadCount((c) => c + 1)}
      />
    </div>
  )
}

function PreviewBody({
  path,
  kind,
  range,
  thumb,
  size,
  missingMessage,
  loading,
  content,
  error,
  contentKey,
  onOpen,
  onRetry,
}: {
  path: string
  kind: FileHoverPreviewKind
  range: LineRange | null
  thumb: string | null
  size: number | null
  missingMessage: string | null
  loading: boolean
  content: FileContent | null
  error: unknown
  contentKey: string
  onOpen: (() => void) | null
  onRetry: () => void
}) {
  const { t } = useTranslation('files')

  if (kind === 'folder') {
    return (
      <MetaNotice
        icon={Folder01Icon}
        title={t('hoverPreview.folderTitle')}
        description={t('hoverPreview.folderDescription')}
      />
    )
  }

  if (kind === 'missing') {
    return (
      <MetaNotice
        icon={FileNotFoundIcon}
        title={t('preview.openFailed')}
        description={missingMessage ?? t('preview.missing')}
      />
    )
  }

  if (kind === 'image' && content === null && !loading && error === null) {
    return thumb ? (
      <ImagePreview src={thumb} alt={nameOf(path)} size={size} />
    ) : (
      <MetaNotice
        icon={Image01Icon}
        title={nameOf(path)}
        description={
          size !== null ? t('hoverPreview.mediaDescription', { size: bytes(size) }) : path
        }
      />
    )
  }

  if (loading) {
    return <PreviewSkeleton />
  }

  if (error !== null) {
    const missing = errorCode(error) === 'not_found'
    return (
      <MetaNotice
        icon={missing ? FileNotFoundIcon : Alert02Icon}
        title={t('hoverPreview.loadFailed')}
        description={missing ? t('preview.missing') : errorMessage(error)}
      >
        {!missing && (
          <button
            type="button"
            data-preview-retry=""
            onClick={onRetry}
            className="mt-2 inline-flex items-center gap-1 rounded-md bg-subtle px-2 py-1 text-caption font-medium text-primary transition-colors hover:bg-hover focus-visible:focus-ring"
          >
            <HugeiconsIcon icon={RotateClockwiseIcon} size={12} strokeWidth={1.9} aria-hidden />
            {t('hoverPreview.retry')}
          </button>
        )}
      </MetaNotice>
    )
  }

  if (content === null) {
    return (
      <MetaNotice
        icon={File01Icon}
        title={nameOf(path)}
        description={
          size !== null
            ? `${bytes(size)} \u00b7 ${t('hoverPreview.externalFileDescription')}`
            : t('hoverPreview.externalFileDescription')
        }
      />
    )
  }

  if (content.kind === 'binary') {
    return (
      <MetaNotice
        icon={File01Icon}
        title={t('preview.binaryTitle')}
        description={t('preview.binaryDescription', { size: bytes(content.size) })}
      />
    )
  }

  if (content.kind === 'too-large') {
    return (
      <MetaNotice
        icon={File01Icon}
        title={t('preview.tooLargeTitle')}
        description={t('preview.tooLargeDescription', {
          size: bytes(content.size),
          limit: bytes(content.limit),
        })}
      />
    )
  }

  if (content.kind === 'media') {
    return <MediaPreview path={path} grant={content.grant} />
  }

  return (
    <TextCodePreview
      path={path}
      text={content.text}
      range={range}
      contentKey={contentKey}
      onOpen={onOpen}
    />
  )
}

function PreviewSkeleton() {
  return (
    <div data-preview-loading="" className="flex flex-col gap-2 p-3" aria-busy="true">
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-3 w-11/12" />
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-3 w-4/5" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  )
}

function MetaNotice({
  icon,
  title,
  description,
  children,
}: {
  icon: typeof File01Icon
  title: string
  description: string
  children?: ReactNode
}) {
  return (
    <div data-preview-meta="" className="flex items-start gap-2.5 p-3.5 text-small">
      <HugeiconsIcon
        icon={icon}
        size={16}
        strokeWidth={1.9}
        aria-hidden
        className="mt-0.5 shrink-0 text-tertiary"
      />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-primary">{title}</div>
        <div className="mt-0.5 text-caption break-words text-secondary">{description}</div>
        {children}
      </div>
    </div>
  )
}

function MediaPreview({ path, grant }: { path: string; grant: MediaGrant }) {
  const { t } = useTranslation('files')
  const [broken, setBroken] = useState(false)

  if (grant.kind === 'image' && !grant.tooLarge && !broken) {
    return (
      <ImagePreview
        src={grant.url}
        alt={nameOf(path)}
        width={grant.width}
        height={grant.height}
        size={grant.size}
        onError={() => setBroken(true)}
      />
    )
  }

  if (grant.tooLarge) {
    return (
      <MetaNotice
        icon={Image01Icon}
        title={t('preview.mediaTooLargeTitle')}
        description={bytes(grant.size)}
      />
    )
  }

  const title =
    grant.kind === 'audio'
      ? t('hoverPreview.mediaAudioTitle')
      : grant.kind === 'video'
        ? t('hoverPreview.mediaVideoTitle')
        : grant.kind === 'document'
          ? t('hoverPreview.mediaDocumentTitle')
          : t('preview.binaryTitle')

  return (
    <MetaNotice
      icon={File01Icon}
      title={title}
      description={t('hoverPreview.mediaDescription', { size: bytes(grant.size) })}
    />
  )
}

function ImagePreview({
  src,
  alt,
  width,
  height,
  size,
  onError,
}: {
  src: string
  alt: string
  width?: number
  height?: number
  size?: number | null
  onError?: () => void
}) {
  const { t } = useTranslation('files')
  const details = [
    width && height ? t('hoverPreview.imageDimensions', { width, height }) : null,
    size != null ? bytes(size) : null,
  ]
    .filter(Boolean)
    .join(' \u00b7 ')

  return (
    <div data-preview-image="" className="flex flex-col gap-2 p-2.5">
      <div className="checkerboard flex max-h-64 items-center justify-center overflow-hidden rounded-lg p-2 shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)]">
        <img
          src={src}
          alt={alt}
          decoding="async"
          draggable={false}
          onError={onError}
          className="max-h-60 max-w-full rounded-sm object-contain"
        />
      </div>
      {details && <div className="px-0.5 text-caption text-tertiary tabular">{details}</div>}
    </div>
  )
}

function TextCodePreview({
  path,
  text,
  range,
  contentKey,
  onOpen,
}: {
  path: string
  text: string
  range: LineRange | null
  contentKey: string
  onOpen: (() => void) | null
}) {
  const { t } = useTranslation('files')
  const dark = useDark()
  const shownTheme = useThemesStore((s) => s.shown)
  const slice = useMemo<PreviewTextSlice>(() => slicePreviewText(text, range), [text, range])
  const codeText = useMemo(() => slice.lines.map((line) => line.text).join('\n'), [slice.lines])
  const highlightKey = `${path}\0${shownTheme?.name ?? ''}\0${codeText}`
  const [highlighted, setHighlighted] = useState<{
    key: string
    tokens: PreviewToken[][]
  } | null>(null)

  useEffect(() => {
    if (slice.empty) return
    const { sync, cancel } = highlightPreviewLines({
      code: codeText,
      path,
      theme: shownTheme,
      onTokens: (tokens) => setHighlighted({ key: highlightKey, tokens }),
    })
    if (sync) {
      // Defer state update to a microtask so the effect never calls setState synchronously.
      let active = true
      queueMicrotask(() => {
        if (active) setHighlighted({ key: highlightKey, tokens: sync })
      })
      return () => {
        active = false
        cancel()
      }
    }
    return cancel
  }, [slice.empty, codeText, path, shownTheme, highlightKey])

  const scrollRef = useRef<HTMLDivElement>(null)
  const scrolledRef = useRef<string | null>(null)
  const scrollTargetKey = slice.highlight
    ? `${contentKey}:${slice.startLine}-${slice.endLine}:${slice.highlight.start}-${slice.highlight.end}`
    : null

  useLayoutEffect(() => {
    if (!scrollTargetKey || !slice.highlight) return
    if (scrolledRef.current === scrollTargetKey) return
    const scroller = scrollRef.current
    if (!scroller) return
    const align = () => {
      const startRow = scroller.querySelector<HTMLElement>(
        `[data-preview-line="${slice.highlight!.start}"]`,
      )
      if (!startRow) return
      const endRow =
        slice.highlight!.end > slice.highlight!.start
          ? scroller.querySelector<HTMLElement>(`[data-preview-line="${slice.highlight!.end}"]`)
          : null
      const highlightHeight = endRow
        ? endRow.offsetTop + endRow.offsetHeight - startRow.offsetTop
        : startRow.offsetHeight
      scroller.scrollTop = computePreviewScrollTop({
        rowOffsetTop: startRow.offsetTop,
        rowHeight: startRow.offsetHeight || 19,
        highlightHeight,
        containerHeight: scroller.clientHeight,
        scrollHeight: scroller.scrollHeight,
      })
      scrolledRef.current = scrollTargetKey
    }
    align()
    const frame = requestAnimationFrame(align)
    return () => cancelAnimationFrame(frame)
  }, [scrollTargetKey, slice.highlight])

  if (slice.empty) {
    return (
      <div data-preview-empty="" className="px-3.5 py-4 text-caption text-tertiary">
        {t('hoverPreview.empty')}
      </div>
    )
  }

  const tokenLines = highlighted?.key === highlightKey ? highlighted.tokens : null
  const gutterChars = Math.max(2, String(slice.endLine).length)
  const isRangeTruncated = slice.truncatedBefore || slice.truncatedAfter

  return (
    <>
      <div
        ref={scrollRef}
        data-preview-code=""
        data-selectable=""
        className="min-h-0 flex-1 overflow-auto overscroll-contain bg-code-block py-2 font-mono text-[calc(var(--text-code-sm)+var(--code-size-offset))] leading-[1.65]"
      >
        <div className="min-w-max">
          {slice.lines.map((line, index) => {
            const marked =
              slice.highlight !== null &&
              line.number >= slice.highlight.start &&
              line.number <= slice.highlight.end
            const tokens = tokenLines?.[index]
            return (
              <div
                key={line.number}
                data-preview-line={line.number}
                data-highlighted={marked ? '' : undefined}
                className={cn(
                  'flex items-baseline pr-3',
                  marked && 'bg-control-on-tint shadow-[inset_2px_0_0_var(--control-on)]',
                )}
              >
                <span
                  aria-hidden
                  style={{ minWidth: `${gutterChars + 2}ch` }}
                  className={cn(
                    'sticky left-0 z-1 shrink-0 pr-3 pl-2.5 text-right select-none tabular',
                    marked
                      ? 'bg-[color-mix(in_srgb,var(--control-on)_10%,var(--bg-code-block))] font-medium text-control-on shadow-[inset_2px_0_0_var(--control-on)]'
                      : 'bg-code-block text-tertiary',
                  )}
                >
                  {line.number}
                </span>
                <span className="whitespace-pre text-primary">
                  {tokens && tokens.length > 0
                    ? tokens.map((token, tokenIndex) => (
                        <span key={tokenIndex} style={previewTokenStyle(token, dark)}>
                          {token.content}
                        </span>
                      ))
                    : line.text || ' '}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {slice.truncated && (
        <div
          data-preview-truncated=""
          className="flex shrink-0 items-center justify-between gap-2 border-t border-subtle bg-subtle px-3 py-1.5 text-caption text-tertiary"
        >
          <span className="min-w-0 truncate tabular">
            {isRangeTruncated
              ? t('hoverPreview.truncatedRange', {
                  start: slice.startLine,
                  end: slice.endLine,
                  total: slice.totalLines,
                })
              : t('hoverPreview.truncatedClipped')}
          </span>
          {onOpen && (
            <button
              type="button"
              onClick={onOpen}
              className="shrink-0 font-medium text-secondary hover:text-primary focus-visible:focus-ring"
            >
              {t('hoverPreview.openFullFile')}
            </button>
          )}
        </div>
      )}
    </>
  )
}
