// Unified sandboxed iframe for artifacts: renders a direct iframe on desktop and host-served
// web clients, and mounts an isolated static shell over the virtual frame host on hosted/relay web.

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { ARTIFACT_FRAME_SANDBOX, WEB_ARTIFACT_FRAME_SANDBOX } from '@shared/artifacts'
import { isWeb } from '@renderer/lib/platform'
import type { PreparedSandboxFrame } from '@renderer/web/virtual-frames'
import { getVirtualFrameHost } from './virtual-frame-host'

function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Extracts the frame root prefix (`<origin>/frame/<token>/`) from a page URL. */
function frameRootOf(src: string): string | null {
  const parsed = URL.parse(src, location.href)
  if (!parsed || !parsed.pathname.startsWith('/frame/')) return null
  const slash = parsed.pathname.indexOf('/', '/frame/'.length)
  if (slash < 0) return null
  return `${parsed.origin}${parsed.pathname.slice(0, slash + 1)}`
}

/** Builds a sibling page URL within the same artifact version for relative HTML links. */
function siblingPageUrl(currentSrc: string, targetPath: string, search: string): string | null {
  const parsed = URL.parse(currentSrc, location.href)
  if (!parsed) return null
  const match = /^(\/frame\/[^/]+\/_kettu\/v\/\d+\/)/.exec(parsed.pathname)
  if (!match) return null
  const encoded = targetPath.split('/').map(encodeURIComponent).join('/')
  return `${parsed.origin}${match[1]}${encoded}${search}`
}

export interface ArtifactIframeProps {
  src: string
  title: string
  className?: string
  style?: CSSProperties
  tabIndex?: number
  dataLoaded?: boolean
  /** Increment to force a reload of the current page. */
  reloadSeq?: number
  iframeRef?: (el: HTMLIFrameElement | null) => void
  /** Called once page content and scripts finish loading (matches native onLoad on direct mode). */
  onLoad?: () => void
  /**
   * Called once page-runtime is ready for its MessagePort in virtual sandbox mode; fires alongside
   * native onLoad on desktop and direct web clients.
   */
  onPortReady?: () => void
}

export function ArtifactIframe({
  src,
  title,
  className,
  style,
  tabIndex,
  dataLoaded,
  reloadSeq = 0,
  iframeRef,
  onLoad,
  onPortReady,
}: ArtifactIframeProps) {
  const host = getVirtualFrameHost()
  const [navigated, setNavigated] = useState<{ base: string; target: string } | null>(null)
  const effectiveSrc = navigated && navigated.base === src ? navigated.target : src
  const [strictSeq, setStrictSeq] = useState(0)
  // Bind a fresh key (nonce) on every reload so changing only the fragment remounts the shell
  // iframe instead of firing a same-document hashchange.
  const [shell, setShell] = useState<{ url: string; nonce: string } | null>(null)
  const frameEl = useRef<HTMLIFrameElement | null>(null)
  const preparedRef = useRef<PreparedSandboxFrame | null>(null)
  const deliveredRef = useRef(false)
  const portReadyRef = useRef(false)
  const loadedRef = useRef(false)
  const onLoadRef = useRef(onLoad)
  const onPortReadyRef = useRef(onPortReady)
  const reloadMounted = useRef(reloadSeq)
  const [firstDirectSrc] = useState(src)
  const shownDirectSrc = useRef(src)

  useEffect(() => {
    onLoadRef.current = onLoad
    onPortReadyRef.current = onPortReady
  })

  // Direct mode (desktop and host-served web): native iframe with no extra indirection.
  useEffect(() => {
    if (host) return
    const el = frameEl.current
    if (!el) return
    if (src !== shownDirectSrc.current) {
      shownDirectSrc.current = src
      el.src = src
    } else if (reloadSeq !== reloadMounted.current) {
      reloadMounted.current = reloadSeq
      el.src = src
    }
  }, [host, src, reloadSeq])

  // Subscribe to strict-mode upgrade notifications for older hosts that omit `strict`.
  useEffect(() => {
    if (!host) return
    const root = frameRootOf(effectiveSrc)
    if (!root) return
    return host.onStrictUpgrade(root, () => setStrictSeq((n) => n + 1))
  }, [host, effectiveSrc])

  // Virtual mode: assemble HTML and VFS port first, then mount a fresh static shell and deliver
  // the document once the shell posts `ready` with a matching nonce.
  useEffect(() => {
    if (!host) return
    let live = true
    let activePrepared: PreparedSandboxFrame | null = null
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null
    const nonce = newNonce()
    deliveredRef.current = false
    portReadyRef.current = false
    loadedRef.current = false
    preparedRef.current = null

    const onMessage = (event: MessageEvent): void => {
      if (!live) return
      const win = frameEl.current?.contentWindow
      if (!win || event.source !== win) return
      const data = event.data as {
        kettuSandbox?: unknown
        nonce?: unknown
        path?: unknown
        search?: unknown
      } | null
      if (!data || data.nonce !== nonce) return

      if (data.kettuSandbox === 'ready') {
        if (deliveredRef.current || !preparedRef.current) return
        deliveredRef.current = true
        const current = preparedRef.current
        win.postMessage({ kettuSandbox: 'render', nonce, html: current.html }, '*', [
          current.vfsPort,
        ])
        return
      }

      if (data.kettuSandbox === 'port-ready') {
        if (portReadyRef.current) return
        portReadyRef.current = true
        onPortReadyRef.current?.()
        // Fallback fade-in in case a slow external CDN delays the load event.
        fallbackTimer = setTimeout(() => {
          if (!live || loadedRef.current) return
          loadedRef.current = true
          onLoadRef.current?.()
        }, 2_500)
        return
      }

      if (data.kettuSandbox === 'loaded') {
        if (fallbackTimer) {
          clearTimeout(fallbackTimer)
          fallbackTimer = null
        }
        if (!portReadyRef.current) {
          portReadyRef.current = true
          onPortReadyRef.current?.()
        }
        if (!loadedRef.current) {
          loadedRef.current = true
          onLoadRef.current?.()
        }
        return
      }

      if (data.kettuSandbox === 'navigate' && typeof data.path === 'string') {
        const nextSearch = typeof data.search === 'string' ? data.search : ''
        const nextUrl = siblingPageUrl(effectiveSrc, data.path, nextSearch)
        if (nextUrl) setNavigated({ base: src, target: nextUrl })
      }
    }

    window.addEventListener('message', onMessage)
    void host
      .prepare(effectiveSrc)
      .then((prepared) => {
        if (!live) {
          prepared.dispose()
          return
        }
        activePrepared = prepared
        preparedRef.current = prepared
        setShell({ url: `${prepared.sandboxPath}${prepared.search}#${nonce}`, nonce })
      })
      .catch((error: unknown) => {
        console.error('Could not prepare sandbox artifact frame', error)
        if (live && !loadedRef.current) {
          loadedRef.current = true
          onLoadRef.current?.()
        }
      })

    return () => {
      live = false
      if (fallbackTimer) clearTimeout(fallbackTimer)
      window.removeEventListener('message', onMessage)
      activePrepared?.dispose()
      preparedRef.current = null
    }
  }, [host, effectiveSrc, src, reloadSeq, strictSeq])

  const bindRef = (el: HTMLIFrameElement | null): void => {
    frameEl.current = el
    iframeRef?.(el)
  }

  if (!host) {
    return (
      <iframe
        ref={bindRef}
        src={firstDirectSrc}
        title={title}
        tabIndex={tabIndex}
        sandbox={isWeb ? WEB_ARTIFACT_FRAME_SANDBOX : ARTIFACT_FRAME_SANDBOX}
        allow=""
        referrerPolicy="no-referrer"
        onLoad={() => {
          onPortReadyRef.current?.()
          onLoadRef.current?.()
        }}
        style={style}
        className={className}
        data-loaded={dataLoaded || undefined}
      />
    )
  }

  return (
    <iframe
      key={shell?.nonce ?? 'pending'}
      ref={bindRef}
      src={shell?.url}
      title={title}
      tabIndex={tabIndex}
      sandbox={WEB_ARTIFACT_FRAME_SANDBOX}
      allow=""
      referrerPolicy="no-referrer"
      style={style}
      className={className}
      data-loaded={dataLoaded || undefined}
    />
  )
}
