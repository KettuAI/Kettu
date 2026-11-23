import { useEffect, useRef, useState } from 'react'
import { OFFICE_PREVIEW_LIMIT } from '@shared/media'
import { readMedia } from '@renderer/lib/media-bytes'
import { useLinkOpener } from '@renderer/features/session/composer/link-opener'
import type { PictureControls } from '@renderer/features/session/media/picture-zoom'
import { MAX_ZOOM, stepZoom } from '@renderer/features/session/media/zoom'
import type { DocumentFailure } from './document-failure'
import type { Picture } from './file-preview'
import { Lines } from './file-preview'
import { holdsEncryptedPackage, isOle2 } from './office-bytes'
import documentStyles from './word-document.css?inline'
import './word-viewer.css'

/** The room a fitted page leaves on each side of the pane, as a picture does. */
const FIT_MARGIN = 24
/** A zoom that ends this close to the fit snaps back to it. */
const SNAP = 0.05
/** A wheel or pinch of this many pixels doubles the zoom by `e`. */
const WHEEL_ZOOM = 0.01

/** Where each document was left, at a zoom of 1, so another tab and back finds the place. */
const positions = new Map<string, { top: number; left: number }>()

// Pictures come out as data URLs, which the page's policy allows and which leave nothing to
// revoke. Embedded fonts stay off: a font face written into a shadow root does not apply, and
// one written outside it would put a document's font names in the app. Linked content and
// embedded HTML are never read.
const RENDER = {
  className: 'docx',
  breakPages: true,
  ignoreLastRenderedPageBreak: false,
  renderHeaders: true,
  renderFooters: true,
  renderFootnotes: true,
  renderEndnotes: true,
  renderAltChunks: false,
  useBase64URL: true,
  ignoreFonts: true,
}

const SERIF =
  /times|georgia|cambria|garamond|palatino|book antiqua|century|constantia|baskerville|simsun|song|mincho|batang|fangsong|kai|宋|仿宋|楷/i
const MONOSPACE = /courier|consolas|menlo|monaco|lucida console|mono|fixedsys/i

/** The installed family that stands closest to a document's own font where that is missing. */
function genericFor(family: string): string {
  const first = family.split(',')[0] ?? ''
  if (MONOSPACE.test(first)) return 'monospace'
  return SERIF.test(first) ? 'serif' : 'sans-serif'
}

function addFallback(style: CSSStyleDeclaration): void {
  const family = style.getPropertyValue('font-family')
  if (family) style.setProperty('font-family', `${family}, ${genericFor(family)}`)
}

/** Ends every font list the document writes with a generic family. */
function addFontFallbacks(shadow: ShadowRoot): void {
  for (const sheet of shadow.styleSheets) {
    for (const rule of sheet.cssRules) if (rule instanceof CSSStyleRule) addFallback(rule.style)
  }
  for (const el of shadow.querySelectorAll<HTMLElement>('[style*="font-family"]')) {
    addFallback(el.style)
  }
}

/**
 * A Word document's pages one under another, drawn by docx-preview into a shadow root, so its
 * styles can never reach the app nor the app's reach it. It fits the pane's width, never
 * enlarged, and zooms as a picture does; its zoom goes to the header through `onPicture`.
 */
export default function WordStage({
  viewKey,
  path,
  url,
  name,
  onPicture,
  onFailed,
}: {
  /** What the place reached in the document is kept under. */
  viewKey: string
  path: string
  url: string
  name: string
  onPicture: (path: string, picture: Picture | null) => void
  onFailed: (failure: DocumentFailure) => void
}) {
  const scroll = useRef<HTMLDivElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  const links = useLinkOpener(null)
  // The page's handlers outlive a render, so they follow the latest ones.
  const latest = useRef({ open: links.open, onPicture, onFailed })
  useEffect(() => {
    latest.current = { open: links.open, onPicture, onFailed }
  })

  useEffect(() => {
    const container = scroll.current
    const element = host.current
    if (!container || !element) return
    const reading = new AbortController()
    let disposed = false
    let teardown = () => {}
    setReady(false)

    const start = async () => {
      let bytes: Uint8Array
      try {
        bytes = await readMedia(url, reading.signal)
      } catch {
        if (!disposed) latest.current.onFailed('unreadable')
        return
      }
      // The file may have grown since it was granted.
      if (bytes.length > OFFICE_PREVIEW_LIMIT) return latest.current.onFailed('unreadable')
      // A password-protected Word file is an OLE2 container, not an archive.
      if (isOle2(bytes)) {
        return latest.current.onFailed(holdsEncryptedPackage(bytes) ? 'encrypted' : 'invalid')
      }
      const { renderAsync } = await import('docx-preview')
      if (disposed) return
      const shadow = element.shadowRoot ?? element.attachShadow({ mode: 'open' })
      const styles = document.createElement('div')
      const body = document.createElement('div')
      const base = new CSSStyleSheet()
      base.replaceSync(documentStyles)
      shadow.adoptedStyleSheets = [base]
      shadow.replaceChildren(styles, body)
      try {
        await renderAsync(bytes, body, styles, RENDER)
      } catch {
        if (!disposed) latest.current.onFailed('invalid')
        return
      }
      if (disposed) return
      addFontFallbacks(shadow)

      // The widest page at a zoom of 1, plus the room the wrapper leaves around it.
      const pages = [...shadow.querySelectorAll<HTMLElement>('section.docx')]
      const widest = pages.length > 0 ? Math.max(...pages.map((page) => page.offsetWidth)) : 794
      const natural = widest + 2 * FIT_MARGIN
      let fit = 1
      let zoom = 1
      let atFit = true

      const report = () => {
        latest.current.onPicture(path, { controls, zoom: { z: zoom, fit } })
      }
      const widthFit = () => Math.max(0.1, Math.min(1, container.clientWidth / natural))
      // The point at the pane's centre stays there while the zoom changes.
      const apply = (next: number) => {
        const x = (container.scrollLeft + container.clientWidth / 2) / zoom
        const y = (container.scrollTop + container.clientHeight / 2) / zoom
        zoom = next
        element.style.zoom = String(next)
        container.scrollLeft = x * zoom - container.clientWidth / 2
        container.scrollTop = y * zoom - container.clientHeight / 2
        report()
      }
      const zoomTo = (target: number) => {
        const z = Math.min(MAX_ZOOM, Math.max(fit, target))
        atFit = z / fit - 1 < SNAP
        apply(atFit ? fit : z)
      }
      const controls: PictureControls = {
        zoomBy: (direction) => zoomTo(stepZoom(zoom, direction, fit)),
        fit: () => zoomTo(fit),
        actual: () => zoomTo(1),
        toggle: () => zoomTo(zoom > fit ? fit : 1),
      }

      fit = widthFit()
      zoom = fit
      element.style.zoom = String(fit)
      const saved = positions.get(viewKey)
      container.scrollTop = saved ? saved.top * zoom : 0
      container.scrollLeft = saved ? saved.left * zoom : 0
      setReady(true)
      report()

      const resized = new ResizeObserver(() => {
        fit = widthFit()
        if (atFit || zoom < fit) zoomTo(fit)
        else report()
      })
      resized.observe(container)

      const onScroll = () => {
        positions.set(viewKey, {
          top: container.scrollTop / zoom,
          left: container.scrollLeft / zoom,
        })
      }
      container.addEventListener('scroll', onScroll, { passive: true })

      // In-document links scroll within it, http(s) links ask first, and any other goes nowhere.
      const onLink = (event: Event) => {
        const link = (event.target as Element | null)?.closest('a')
        if (!link) return
        event.preventDefault()
        if (event.type !== 'click') return
        const href = link.getAttribute('href') ?? ''
        if (href.startsWith('#')) {
          shadow.getElementById(href.slice(1))?.scrollIntoView()
          return
        }
        const target = URL.parse(href)
        if (target?.protocol === 'https:' || target?.protocol === 'http:') {
          latest.current.open(target.href)
        }
      }
      shadow.addEventListener('click', onLink)
      shadow.addEventListener('auxclick', onLink)

      const onWheel = (event: WheelEvent) => {
        if (!event.ctrlKey && !event.metaKey) return
        event.preventDefault()
        zoomTo(zoom * Math.exp(-event.deltaY * WHEEL_ZOOM))
      }
      container.addEventListener('wheel', onWheel, { passive: false })

      teardown = () => {
        resized.disconnect()
        container.removeEventListener('scroll', onScroll)
        container.removeEventListener('wheel', onWheel)
        shadow.removeEventListener('click', onLink)
        shadow.removeEventListener('auxclick', onLink)
        latest.current.onPicture(path, null)
        element.style.zoom = ''
        shadow.replaceChildren()
      }
    }
    start().catch(() => {
      if (!disposed) latest.current.onFailed('invalid')
    })
    return () => {
      disposed = true
      reading.abort()
      teardown()
    }
  }, [path, url, viewKey])

  return (
    <div className="kp-word absolute inset-0" data-selectable="">
      <div ref={scroll} tabIndex={0} role="group" aria-label={name} className="kp-word__scroll">
        <div ref={host} />
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
