import { useEffect, useRef, useState } from 'react'
import { useLinkOpener } from '@renderer/features/session/composer/link-opener'
import type { PictureControls } from '@renderer/features/session/media/picture-zoom'
import { MAX_ZOOM, stepZoom } from '@renderer/features/session/media/zoom'
import type { Picture } from './file-preview'
import { Lines } from './file-preview'
import { loadViewerLibrary, openPdf, pdfFailure, pdfjs, type PdfFailure } from './pdf-engine'
import './pdf-viewer.css'

/** The room a fitted page leaves on each side of the pane, as a picture does. */
const FIT_MARGIN = 24
/** A zoom that ends this close to the fit snaps back to it. */
const SNAP = 0.05
/** A wheel or pinch of this many pixels doubles the zoom by `e`. */
const WHEEL_ZOOM = 0.01

/** Where each PDF was left, so another tab and back finds the page it was on. */
const positions = new Map<string, number>()

export type { PdfFailure }

/**
 * A PDF's pages one under another, drawn by PDF.js's viewer as they scroll into view, with a text
 * layer to select and links to follow. It fits the pane's width, never enlarged, and zooms as a
 * picture does; its zoom and page go to the header through `onPicture`.
 */
export default function PdfStage({
  viewKey,
  path,
  url,
  name,
  onPicture,
  onFailed,
}: {
  /** What a page reached in the document is kept under. */
  viewKey: string
  path: string
  url: string
  name: string
  onPicture: (path: string, picture: Picture | null) => void
  onFailed: (failure: PdfFailure) => void
}) {
  const scroll = useRef<HTMLDivElement>(null)
  const pages = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  const links = useLinkOpener(null)
  // The page's handlers outlive a render, so they follow the latest ones.
  const latest = useRef({ open: links.open, onPicture, onFailed })
  useEffect(() => {
    latest.current = { open: links.open, onPicture, onFailed }
  })

  useEffect(() => {
    const container = scroll.current
    const viewerElement = pages.current
    if (!container || !viewerElement) return
    let disposed = false
    let teardown = () => {}
    setReady(false)

    const start = async () => {
      const lost = (error: unknown) => {
        if (!disposed) latest.current.onFailed(pdfFailure(error))
      }
      const [library, opened] = await Promise.all([loadViewerLibrary(), openPdf(url, lost)])
      if (disposed) return opened.close()
      const eventBus = new library.EventBus()
      const linkService = new library.PDFLinkService({ eventBus })
      const viewer = new library.PDFViewer({
        container,
        viewer: viewerElement,
        eventBus,
        linkService,
        annotationMode: pdfjs.AnnotationMode.ENABLE,
        annotationEditorMode: pdfjs.AnnotationEditorType.DISABLE,
      })
      linkService.setViewer(viewer)

      let fit = 1
      let atFit = true
      const total = opened.document.numPages

      const report = () => {
        latest.current.onPicture(path, {
          controls,
          zoom: { z: viewer.currentScale, fit },
          pages: { current: viewer.currentPageNumber, total },
        })
      }
      const widthFit = () => {
        const view = viewer.getPageView(0)
        const width = view ? view.viewport.width / viewer.currentScale : 0
        if (!width) return 1
        return Math.max(0.1, Math.min(1, (container.clientWidth - 2 * FIT_MARGIN) / width))
      }
      const zoomTo = (target: number) => {
        const z = Math.min(MAX_ZOOM, Math.max(fit, target))
        atFit = z / fit - 1 < SNAP
        viewer.currentScale = atFit ? fit : z
      }
      const controls: PictureControls = {
        zoomBy: (direction) => zoomTo(stepZoom(viewer.currentScale, direction, fit)),
        fit: () => zoomTo(fit),
        actual: () => zoomTo(1),
        toggle: () => zoomTo(viewer.currentScale > fit ? fit : 1),
      }

      eventBus.on('pagesinit', () => {
        fit = widthFit()
        viewer.currentScale = fit
        const saved = positions.get(viewKey)
        if (saved && saved > 1 && saved <= total) viewer.currentPageNumber = saved
        // Fitting scrolls the first page flush to the top, past the stage's margin.
        else container.scrollTop = 0
        setReady(true)
        report()
      })
      eventBus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => {
        positions.set(viewKey, pageNumber)
        report()
      })
      eventBus.on('scalechanging', report)
      viewer.setDocument(opened.document)
      linkService.setDocument(opened.document, null)

      const resized = new ResizeObserver(() => {
        if (!viewer.pagesCount) return
        fit = widthFit()
        if (atFit || viewer.currentScale < fit) zoomTo(fit)
        else report()
      })
      resized.observe(container)

      // In-document links jump within it, http(s) links ask first, and any other goes nowhere.
      const onLink = (event: MouseEvent) => {
        const link = (event.target as Element | null)?.closest('a')
        if (!link) return
        const href = link.getAttribute('href') ?? ''
        if (href === '' || href.startsWith('#')) return
        event.preventDefault()
        event.stopPropagation()
        const target = URL.parse(link.href)
        if (target?.protocol === 'https:' || target?.protocol === 'http:') {
          latest.current.open(target.href)
        }
      }
      container.addEventListener('click', onLink, true)

      const onWheel = (event: WheelEvent) => {
        if (!event.ctrlKey && !event.metaKey) return
        event.preventDefault()
        zoomTo(viewer.currentScale * Math.exp(-event.deltaY * WHEEL_ZOOM))
      }
      container.addEventListener('wheel', onWheel, { passive: false })

      teardown = () => {
        resized.disconnect()
        container.removeEventListener('click', onLink, true)
        container.removeEventListener('wheel', onWheel)
        latest.current.onPicture(path, null)
        viewer.cleanup()
        viewer.setDocument(null)
        opened.close()
      }
    }
    start().catch((error: unknown) => {
      if (!disposed) latest.current.onFailed(pdfFailure(error))
    })
    return () => {
      disposed = true
      teardown()
    }
  }, [path, url, viewKey])

  return (
    <div className="kp-pdf absolute inset-0" data-selectable="">
      <div ref={scroll} tabIndex={0} role="group" aria-label={name} className="kp-pdf__scroll">
        <div ref={pages} className="pdfViewer" />
      </div>
      {!ready && (
        <div className="absolute inset-0 bg-surface">
          <Lines />
        </div>
      )}
      {links.dialog}
    </div>
  )
}
