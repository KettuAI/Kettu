import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { AnimatePresence, motion } from 'motion/react'
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  FileDownIcon,
  FolderIcon,
  MinusIcon,
  PlusIcon,
  XIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { mediaKindOfName, type CarriedMedia } from '@shared/media'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogPortal, DialogTitle } from '@renderer/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { PanelButton } from '@renderer/features/shell/panel-button'
import { bytes as formatBytes, fileUrlPath, relativePath } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { fileManagerName, formatShortcut, isMac, isMod } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { selectDraft, useAttachmentsStore } from '@renderer/stores/attachments'
import { useThreadsStore } from '@renderer/stores/threads'
import {
  closedViewer,
  closeViewer,
  useViewerStore,
  type ViewerRequest,
} from '@renderer/stores/viewer'
import { openAttachmentPath } from '../attachments/open-attachment'
import { base64Bytes } from './carried'
import { openMedia } from './grants'
import { showFileAction } from './show-file'
import { placeOf } from './viewer-motion'
import { draftItems, threadItems, type ViewerItem } from './viewer-items'
import { StageItem, type ItemView, type PictureControls, type Shown } from './viewer-stage'
import { MAX_ZOOM, type Size } from './zoom'

/** What an item's source came to: shown, or left out of the viewer. */
type Source =
  | { state: 'loading' }
  | { state: 'gone' } // not found, not allowed, not media, or a sound
  | { state: 'failed'; message: string }
  | {
      state: 'ready'
      kind: 'image' | 'video'
      src: string
      mimeType: string
      size: number | null
      /** A file's media URL, for the actions main takes on it. */
      url: string | null
      /** Bytes read for an attachment, kept for copy and save. */
      bytes: Uint8Array | null
    }

// Main decodes these when it copies a picture; any other is drawn here and handed over as PNG.
const MAIN_DECODES = new Set(['image/png', 'image/jpeg'])
const COPIED_MS = 1500

/** The media viewer: one for the window, open while a request is. */
export function MediaViewer() {
  const request = useViewerStore((s) => s.request)
  const closing = useViewerStore((s) => s.closing)
  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && closeViewer()}>
      {request && <ViewerLayer key={request.item.key} request={request} closing={closing} />}
    </Dialog>
  )
}

function base64Size(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor((data.length * 3) / 4) - padding
}

/**
 * A picture drawn again as PNG, at `size` or its own pixels: a file by its media URL, which answers
 * CORS so the canvas stays readable, or carried bytes. A new image that never showed draws its
 * first frame, so an animation copies as it starts.
 */
async function drawnAsPng(source: string | Blob, size: Size | null): Promise<Uint8Array> {
  const src = typeof source === 'string' ? source : URL.createObjectURL(source)
  try {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.src = src
    await image.decode()
    const width = Math.max(1, Math.round(size?.width ?? image.naturalWidth))
    const height = Math.max(1, Math.round(size?.height ?? image.naturalHeight))
    const canvas = new OffscreenCanvas(width, height)
    canvas.getContext('2d')!.drawImage(image, 0, 0, width, height)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    return new Uint8Array(await blob.arrayBuffer())
  } finally {
    if (typeof source !== 'string') URL.revokeObjectURL(src)
  }
}

async function fileSource(path: string, request: ViewerRequest, fresh: boolean): Promise<Source> {
  const { projectPath, sessionId } = request
  if (!projectPath || !sessionId) return { state: 'gone' }
  const result = await openMedia(projectPath, path, sessionId, fresh)
  if (result.kind !== 'granted') return { state: 'gone' }
  const { grant } = result
  if (grant.kind === 'audio') return { state: 'gone' }
  return {
    state: 'ready',
    kind: grant.kind,
    src: grant.url,
    mimeType: grant.mimeType,
    size: grant.size,
    url: grant.url,
    bytes: null,
  }
}

/**
 * The viewer over the window: the bar, and the stage with the item and the step buttons. It holds
 * the session's images and videos in thread order and the draft's images after them.
 */
function ViewerLayer({ request, closing }: { request: ViewerRequest; closing: boolean }) {
  const { t } = useTranslation(['session', 'common'])
  const thread = useThreadsStore((s) =>
    request.sessionId ? (s.replicas[request.sessionId]?.state ?? null) : null,
  )
  const draft = useAttachmentsStore(selectDraft(request.draft ?? ''))
  const all = useMemo(() => {
    const items = [
      ...(thread ? threadItems(thread) : []),
      ...(request.draft ? draftItems(request.draft, draft) : []),
    ]
    return items.some((item) => item.key === request.item.key) ? items : [...items, request.item]
  }, [thread, draft, request])

  const [sources, setSources] = useState(() => new Map<string, Source>())
  const asked = useRef(new Set<string>())
  const retried = useRef(new Set<string>())
  const urls = useRef<string[]>([])
  const setSource = useCallback((key: string, source: Source) => {
    setSources((map) => new Map(map).set(key, source))
  }, [])
  const sourceOf = useCallback(
    (item: ViewerItem): Source => {
      if (item.source.kind !== 'bytes') return sources.get(item.key) ?? { state: 'loading' }
      // Carried bytes are ready at once; only a failure to play them is kept.
      const failed = sources.get(item.key)
      if (failed) return failed
      const { media, mimeType, data } = item.source
      return {
        state: 'ready',
        kind: media,
        src: `data:${mimeType};base64,${data}`,
        mimeType,
        size: base64Size(data),
        url: null,
        bytes: null,
      }
    },
    [sources],
  )

  const [currentAt, setCurrent] = useState(request.item)
  const [direction, setDirection] = useState(1)
  const [stepped, setStepped] = useState(false)
  const shown = useMemo(
    () => all.filter((item) => item.key === currentAt.key || sourceOf(item).state !== 'gone'),
    [all, currentAt.key, sourceOf],
  )
  const index = shown.findIndex((item) => item.key === currentAt.key)
  const item = shown[index] ?? currentAt
  const source = sourceOf(item)

  // Every file the thread names asks for its grant, so the count leaves out what cannot show.
  useEffect(() => {
    for (const each of all) {
      if (each.source.kind !== 'file' || asked.current.has(each.key)) continue
      asked.current.add(each.key)
      fileSource(each.source.path, request, false).then(
        (found) => setSource(each.key, found),
        (error: unknown) => setSource(each.key, { state: 'failed', message: errorMessage(error) }),
      )
    }
  }, [all, request, setSource])

  // An attachment's bytes are read as it comes near: the item shown and those beside it.
  useEffect(() => {
    for (const each of [shown[index], shown[index + 1], shown[index - 1]]) {
      if (!each || each.source.kind !== 'attachment' || asked.current.has(each.key)) continue
      asked.current.add(each.key)
      const { attachment } = each.source
      const read =
        attachment.blob && request.sessionId
          ? host('sessions.blob', { sessionId: request.sessionId, hash: attachment.blob })
          : host('attachments.read', { id: attachment.id })
      read.then(
        ({ mimeType, bytes }) => {
          const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
          urls.current.push(url)
          setSource(each.key, {
            state: 'ready',
            kind: 'image',
            src: url,
            mimeType,
            size: bytes.byteLength,
            url: null,
            bytes: new Uint8Array(bytes),
          })
        },
        (error: unknown) => setSource(each.key, { state: 'failed', message: errorMessage(error) }),
      )
    }
  }, [shown, index, request, setSource])

  useEffect(
    () => () => {
      for (const url of urls.current) URL.revokeObjectURL(url)
    },
    [],
  )

  // The stage's size, which the picture fits. The popup mounts after the layer's first render,
  // so the stage is observed once it is there.
  const stage = useRef<HTMLDivElement | null>(null)
  const [stageSize, setStageSize] = useState<Size>({ width: 0, height: 0 })
  const observeStage = useCallback((el: HTMLDivElement | null) => {
    stage.current = el
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setStageSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      stage.current = null
    }
  }, [])

  const [view, setView] = useState<ItemView>({ pixels: null, zoom: null })
  const viewing = useRef(item.key)
  useLayoutEffect(() => {
    viewing.current = item.key
  })
  const onView = useCallback((key: string, next: ItemView) => {
    if (key === viewing.current) setView(next)
  }, [])
  const controls = useRef(new Map<string, PictureControls>())
  const onControls = useCallback((key: string, handle: PictureControls | null) => {
    if (handle) controls.current.set(key, handle)
    else controls.current.delete(key)
  }, [])
  const picture = () => controls.current.get(item.key) ?? null

  // A clip takes over its inline player's moment and state, and hands them back.
  const player = useRef<{ viewer: HTMLVideoElement; inline: HTMLVideoElement | null } | null>(null)
  const takeOver = (key: string, viewer: HTMLVideoElement) => {
    if (key !== viewing.current) return
    const inline = placeOf(key)?.querySelector('video') ?? null
    player.current = { viewer, inline }
    if (!inline) return
    viewer.currentTime = inline.currentTime
    const playing = !inline.paused
    inline.pause()
    if (playing) void viewer.play().catch(() => {})
  }
  const handBack = (playOn: boolean) => {
    const held = player.current
    player.current = null
    if (!held) return
    const playing = !held.viewer.paused
    held.viewer.pause()
    if (!held.inline) return
    held.inline.currentTime = held.viewer.currentTime
    if (playOn && playing) void held.inline.play().catch(() => {})
  }
  useEffect(() => {
    if (closing) handBack(true)
  }, [closing])

  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  const stepTo = (at: number) => {
    const next = shown[Math.max(0, Math.min(shown.length - 1, at))]
    if (!next || next.key === item.key || closing) return
    handBack(false)
    setDirection(at > index ? 1 : -1)
    setStepped(true)
    setCurrent(next)
    setView({ pixels: null, zoom: null })
    setError(null)
    setCopied(false)
  }

  const ready = source.state === 'ready' ? source : null
  const isPicture = ready?.kind === 'image'
  const name =
    item.name ??
    (item.source.kind === 'bytes' && item.source.media === 'video'
      ? t('media.video')
      : t('viewer.image'))

  // Copy and save take a file by its media URL and carried media by its bytes.
  const carried = (): CarriedMedia => {
    const bytes =
      ready?.bytes ?? (item.source.kind === 'bytes' ? base64Bytes(item.source.data) : null)
    if (!ready || !bytes) throw new Error('The picture is not here yet')
    return { bytes, mimeType: ready.mimeType, name }
  }
  const run = (action: () => Promise<unknown>) => {
    setError(null)
    action().catch((e: unknown) => setError(errorMessage(e)))
  }
  const copy = () => {
    if (!ready || !isPicture) return
    run(async () => {
      const media = ready.url ?? carried()
      if (MAIN_DECODES.has(ready.mimeType)) {
        await window.overbench.media.copyImage(media)
      } else {
        // An SVG at the size the viewer fits it to; any other picture at its own pixels.
        const fitted =
          ready.mimeType === 'image/svg+xml' && view.pixels && view.zoom
            ? {
                width: view.pixels.width * view.zoom.fit,
                height: view.pixels.height * view.zoom.fit,
              }
            : null
        const source =
          typeof media === 'string'
            ? media
            : new Blob([new Uint8Array(media.bytes)], { type: media.mimeType })
        await window.overbench.media.copyImage({
          bytes: await drawnAsPng(source, fitted),
          mimeType: 'image/png',
          name,
        })
      }
      setCopied(true)
      clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), COPIED_MS)
    })
  }
  const save = () => {
    if (ready) run(() => window.overbench.media.saveAs(ready.url ?? carried()))
  }

  // A project file opens in the Files pane, which the viewer then uncovers; any other file shows
  // in the file manager. Carried media has no file.
  const showFile = (() => {
    if (item.source.kind === 'file') {
      return ready?.url ? showFileAction(item.source.path, request.projectPath, ready.url) : null
    }
    const uri = item.source.kind === 'attachment' ? item.source.attachment.uri : null
    const path = uri ? fileUrlPath(uri, window.overbench.platform) : null
    if (!path) return null
    const { projectPath } = request
    return {
      inFiles: !!projectPath && relativePath(path, projectPath) !== path,
      show: () => openAttachmentPath({ type: 'file', uri }, projectPath),
    }
  })()
  const show = () => {
    if (!showFile) return
    run(async () => {
      await showFile.show()
      if (showFile.inFiles) closeViewer()
    })
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || closing) return
    const zoom = isPicture ? picture() : null
    if (isMod(event) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'c') {
      if (!isPicture) return
      event.preventDefault()
      copy()
      return
    }
    // A clip's controls keep their own keys while they have focus.
    if (
      event.altKey ||
      event.metaKey ||
      event.ctrlKey ||
      event.target instanceof HTMLMediaElement
    ) {
      return
    }
    const key = event.key
    if (key === 'ArrowLeft') stepTo(index - 1)
    else if (key === 'ArrowRight') stepTo(index + 1)
    else if (key === 'Home') stepTo(0)
    else if (key === 'End') stepTo(shown.length - 1)
    else if (zoom && event.shiftKey && event.code === 'Digit1') zoom.fit()
    else if (zoom && event.shiftKey && event.code === 'Digit0') zoom.actual()
    else if (zoom && (key === '+' || key === '=')) zoom.zoomBy(1)
    else if (zoom && key === '-') zoom.zoomBy(-1)
    else return
    event.preventDefault()
  }

  const unsupported = t(
    (ready?.kind ?? mediaKindOfName(name)) === 'video'
      ? 'media.unsupportedVideo'
      : 'media.unsupported',
  )
  const stageShown: Shown =
    source.state === 'ready'
      ? { state: 'ready', kind: source.kind, src: source.src }
      : source.state === 'failed'
        ? source
        : source.state === 'gone'
          ? { state: 'failed', message: unsupported }
          : { state: 'loading' }
  const failed = (message: string | null) => {
    // A file whose grant main dropped fails to load; a fresh grant tells that apart.
    const key = item.key
    if (item.source.kind === 'file' && message === null && !retried.current.has(key)) {
      retried.current.add(key)
      fileSource(item.source.path, request, true).then(
        (found) => setSource(key, found),
        (e: unknown) => setSource(key, { state: 'failed', message: errorMessage(e) }),
      )
      return
    }
    setSource(key, { state: 'failed', message: message ?? unsupported })
  }

  const zoom = isPicture ? view.zoom : null
  const atFit = !!zoom && zoom.z <= zoom.fit
  const facts = [
    view.pixels ? `${view.pixels.width} × ${view.pixels.height}` : null,
    ready?.size != null ? formatBytes(ready.size) : null,
  ].filter(Boolean)
  const fade = { duration: 0.2 }

  return (
    <DialogPortal>
      <DialogPrimitive.Backdrop
        render={
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: closing ? 0 : 1 }}
            transition={fade}
          />
        }
        className="fixed inset-0 z-50 bg-viewer-scrim"
      />
      <DialogPrimitive.Popup
        // The bar and its buttons read on the dark scrim in either theme.
        data-theme="dark"
        data-overlay-layer=""
        initialFocus={stage}
        onKeyDown={onKeyDown}
        className="fixed inset-0 z-50 flex flex-col text-foreground outline-none app-region-no-drag"
      >
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: closing ? 0 : 1 }}
          transition={fade}
          className={cn(
            'flex h-top-bar shrink-0 items-center gap-1 pr-2.5 pl-5 app-region-drag',
            isMac
              ? 'pl-[calc(32px+var(--traffic-lights))]'
              : 'pr-[calc(100vw-env(titlebar-area-x,0px)-env(titlebar-area-width,100vw)+10px)]',
          )}
        >
          <DialogTitle className="min-w-0 truncate font-sans text-ui leading-normal">
            {name}
          </DialogTitle>
          {facts.length > 0 && (
            <span className="ml-1 shrink-0 text-meta text-tertiary tabular">
              {facts.join(' · ')}
            </span>
          )}
          <span className="ml-1 shrink-0 text-meta text-tertiary tabular">
            {t('viewer.position', { number: index + 1, count: shown.length })}
          </span>
          {error && <span className="ml-1 min-w-0 truncate text-meta text-danger">{error}</span>}
          <span className="flex-1" />
          {zoom && (
            <>
              <PanelButton
                size="icon-sm"
                label={t('viewer.zoomOut')}
                shortcut="−"
                disabled={atFit}
                onClick={() => picture()?.zoomBy(-1)}
              >
                <MinusIcon />
              </PanelButton>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="quiet"
                      size="sm"
                      onClick={() => picture()?.toggle()}
                      className="min-w-12 px-1.5 text-meta tabular app-region-no-drag"
                    />
                  }
                >
                  {Math.round(zoom.z * 100)}%
                </TooltipTrigger>
                <TooltipContent>{atFit ? t('viewer.actualSize') : t('viewer.fit')}</TooltipContent>
              </Tooltip>
              <PanelButton
                size="icon-sm"
                label={t('viewer.zoomIn')}
                shortcut="+"
                disabled={zoom.z >= MAX_ZOOM}
                onClick={() => picture()?.zoomBy(1)}
              >
                <PlusIcon />
              </PanelButton>
            </>
          )}
          {isPicture && (
            <PanelButton
              size="icon-sm"
              label={copied ? t('viewer.copied') : t('viewer.copy')}
              shortcut={formatShortcut('Mod+C')}
              onClick={copy}
            >
              {copied ? (
                <CheckIcon className="animate-in text-icon animation-duration-(--duration-fast) fade-in zoom-in-75" />
              ) : (
                <CopyIcon />
              )}
            </PanelButton>
          )}
          <PanelButton size="icon-sm" label={t('viewer.saveAs')} disabled={!ready} onClick={save}>
            <FileDownIcon />
          </PanelButton>
          {showFile && (
            <PanelButton
              size="icon-sm"
              label={
                showFile.inFiles
                  ? t('media.showInFiles')
                  : t('media.showIn', { name: fileManagerName() })
              }
              onClick={show}
            >
              <FolderIcon />
            </PanelButton>
          )}
          <PanelButton
            size="icon-sm"
            label={t('common:actions.close')}
            shortcut="Esc"
            onClick={closeViewer}
          >
            <XIcon />
          </PanelButton>
        </motion.div>
        <div
          ref={observeStage}
          tabIndex={-1}
          className="group/stage relative min-h-0 flex-1 outline-none"
        >
          <AnimatePresence initial={false} custom={direction}>
            <StageItem
              key={item.key}
              itemKey={item.key}
              alt={item.alt || name}
              shown={stageShown}
              stage={stageSize}
              direction={direction}
              from={stepped ? null : request.from}
              leaving={closing}
              onLeft={closedViewer}
              onView={onView}
              onBackground={closeViewer}
              onFailed={failed}
              onControls={onControls}
              onVideoReady={(element) => takeOver(item.key, element)}
            />
          </AnimatePresence>
          {index > 0 && (
            <StepButton
              side="start"
              label={t('viewer.previous')}
              leaving={closing}
              onClick={() => stepTo(index - 1)}
            />
          )}
          {index >= 0 && index < shown.length - 1 && (
            <StepButton
              side="end"
              label={t('viewer.next')}
              leaving={closing}
              onClick={() => stepTo(index + 1)}
            />
          )}
        </div>
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
}

/** Previous or Next at the stage's edge, shown on hover and focus; it fades as the viewer closes. */
function StepButton({
  side,
  label,
  leaving,
  onClick,
}: {
  side: 'start' | 'end'
  label: string
  leaving: boolean
  onClick: () => void
}) {
  const Icon = side === 'start' ? ChevronLeftIcon : ChevronRightIcon
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        'absolute top-1/2 z-10 grid size-8 -translate-y-1/2 place-items-center rounded-full bg-popover text-popover-foreground opacity-0 shadow-md transition-opacity duration-(--duration-fast) group-hover/stage:opacity-100 focus-visible:opacity-100 focus-ring',
        side === 'start' ? 'left-3' : 'right-3',
        leaving && 'pointer-events-none opacity-0!',
      )}
    >
      <Icon className="size-4" />
    </button>
  )
}
