// Virtual filesystem bootstrap shim for sandboxed artifact shells: runs before page-runtime and
// page scripts, routing fetch, XMLHttpRequest, dynamic media attributes, and relative HTML links
// to the current artifact version.

/** Static configuration embedded into the sandbox bootstrap shim. */
export interface SandboxShimConfig {
  /** Directory of the current HTML file (empty at root, trailing '/' for subdirectories). */
  baseDir: string
  /** Valid relative file paths in the current artifact version. */
  files: string[]
  /** Preloaded text files (such as document.md or slides.json) to skip the first VFS round-trip. */
  preloaded?: Record<string, { type: string; text: string }>
}

interface VfsReply {
  id?: unknown
  ok?: unknown
  type?: unknown
  bytes?: unknown
}

interface CachedFile {
  type: string
  bytes: ArrayBuffer
}

const MAX_DATA_URL_BYTES = 4 * 1024 * 1024

/** Starts VFS interception and reports lifecycle milestones to the parent frame. */
export function start(config: SandboxShimConfig): void {
  const win = window as unknown as Record<string, unknown>
  const vfsPort = (win.__kettuVfsPort as MessagePort | null | undefined) ?? null
  const nonce = typeof win.__kettuSandboxNonce === 'string' ? win.__kettuSandboxNonce : ''
  delete win.__kettuVfsPort
  delete win.__kettuSandboxNonce

  const nativeFetch = window.fetch.bind(window)
  const NativeResponse = window.Response
  const NativeHeaders = window.Headers
  const NativeBlob = window.Blob
  const NativeXHR = window.XMLHttpRequest
  const createObjectUrl = URL.createObjectURL.bind(URL)
  const parentWin = window.parent
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  const fileSet = new Set(config.files)
  const baseDir = config.baseDir
  const shellOrigin = location.origin
  const fileCache = new Map<string, Promise<CachedFile | null>>()
  const assetUrlCache = new Map<string, Promise<string | null>>()

  if (config.preloaded) {
    for (const [path, entry] of Object.entries(config.preloaded)) {
      const encoded = encoder.encode(entry.text)
      fileCache.set(path, Promise.resolve({ type: entry.type, bytes: encoded.buffer }))
    }
  }

  let seq = 0
  const pending = new Map<number, (file: CachedFile | null) => void>()
  if (vfsPort) {
    vfsPort.onmessage = (event: MessageEvent) => {
      const data = event.data as VfsReply | null
      if (!data || typeof data.id !== 'number') return
      const resolve = pending.get(data.id)
      if (!resolve) return
      pending.delete(data.id)
      if (data.ok === true && typeof data.type === 'string' && data.bytes instanceof ArrayBuffer) {
        resolve({ type: data.type, bytes: data.bytes })
      } else {
        resolve(null)
      }
    }
    vfsPort.start()
  }

  /** Normalizes a relative path and checks membership in the current version's files. */
  function normalizePath(dir: string, raw: string): string | null {
    const clean = raw.split('#')[0]!.split('?')[0]!
    if (!clean) return null
    let decoded: string
    try {
      decoded = decodeURIComponent(clean)
    } catch {
      decoded = clean
    }
    const combined = decoded.startsWith('/') ? decoded.slice(1) : `${dir}${decoded}`
    const parts: string[] = []
    for (const seg of combined.split('/')) {
      if (!seg || seg === '.') continue
      if (seg === '..') {
        if (parts.length === 0) return null
        parts.pop()
      } else {
        parts.push(seg)
      }
    }
    const resolved = parts.join('/')
    return fileSet.has(resolved) ? resolved : null
  }

  /** Resolves a URL to a virtual file path in this version, or null for non-local requests. */
  function resolveVirtual(raw: string): string | null {
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) return null
    if (/^(?:data:|blob:|javascript:|mailto:|tel:|about:)/i.test(trimmed)) return null
    if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('//')) {
      try {
        const parsed = new URL(trimmed, location.href)
        if (parsed.origin !== shellOrigin) return null
        const pathname = parsed.pathname
        if (pathname.startsWith('/_kettu/viewer/')) return null
        // Relative URLs resolved against /_kettu/frame* carry the /_kettu/ prefix.
        if (pathname.startsWith('/_kettu/')) {
          const under = normalizePath(baseDir, pathname.slice('/_kettu/'.length))
          if (under) return under
        }
        return normalizePath('', pathname)
      } catch {
        return null
      }
    }
    return normalizePath(baseDir, trimmed)
  }

  /** Fetches a single file on demand from the parent VFS MessagePort and caches the promise. */
  function readFile(path: string): Promise<CachedFile | null> {
    const existing = fileCache.get(path)
    if (existing) return existing
    if (!vfsPort) return Promise.resolve(null)
    const promise = new Promise<CachedFile | null>((resolve) => {
      const id = ++seq
      pending.set(id, resolve)
      vfsPort.postMessage({ id, path })
    })
    fileCache.set(path, promise)
    return promise
  }

  /** Encodes bytes as a base64 data URL, falling back to a blob URL for large media. */
  function toAssetUrl(path: string): Promise<string | null> {
    const existing = assetUrlCache.get(path)
    if (existing) return existing
    const promise = readFile(path).then((file) => {
      if (!file) return null
      if (file.bytes.byteLength > MAX_DATA_URL_BYTES) {
        return createObjectUrl(new NativeBlob([file.bytes], { type: file.type }))
      }
      const bytes = new Uint8Array(file.bytes)
      let binary = ''
      const chunk = 0x8000
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
      }
      return `data:${file.type};base64,${btoa(binary)}`
    })
    assetUrlCache.set(path, promise)
    return promise
  }

  // 1. Intercept window.fetch for files belonging to this artifact version.
  window.fetch = function kettuFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (method === 'GET' || method === 'HEAD') {
      const rawUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const target = resolveVirtual(rawUrl)
      if (target) {
        return readFile(target).then((file) => {
          if (!file) {
            return new NativeResponse(null, { status: 404, statusText: 'Not Found' })
          }
          const headers = new NativeHeaders({
            'Content-Type': file.type,
            'Content-Length': String(file.bytes.byteLength),
          })
          return new NativeResponse(method === 'HEAD' ? null : file.bytes.slice(0), {
            status: 200,
            statusText: 'OK',
            headers,
          })
        })
      }
    }
    return nativeFetch(input, init)
  }

  // 2. Intercept XMLHttpRequest for pages reading local data files over XHR.
  const nativeOpen = NativeXHR.prototype.open
  const nativeSend = NativeXHR.prototype.send
  const xhrTargets = new WeakMap<XMLHttpRequest, { path: string; method: string }>()

  NativeXHR.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ): void {
    const upper = String(method || 'GET').toUpperCase()
    const raw = typeof url === 'string' ? url : String(url)
    const target = upper === 'GET' || upper === 'HEAD' ? resolveVirtual(raw) : null
    if (target && async !== false) {
      xhrTargets.set(this, { path: target, method: upper })
      return
    }
    xhrTargets.delete(this)
    nativeOpen.call(this, method, url, async ?? true, username ?? null, password ?? null)
  }

  NativeXHR.prototype.send = function (
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    const entry = xhrTargets.get(this)
    if (!entry) return nativeSend.call(this, body)
    xhrTargets.delete(this)
    void readFile(entry.path).then((file) => {
      const status = file ? 200 : 404
      const statusText = file ? 'OK' : 'Not Found'
      const bytes = file && entry.method !== 'HEAD' ? file.bytes.slice(0) : new ArrayBuffer(0)
      const type = file?.type ?? 'text/plain; charset=utf-8'
      let response: unknown
      let responseText = ''
      if (this.responseType === 'arraybuffer') {
        response = bytes
      } else if (this.responseType === 'blob') {
        response = new NativeBlob([bytes], { type })
      } else if (this.responseType === 'json') {
        try {
          response = JSON.parse(decoder.decode(bytes))
        } catch {
          response = null
        }
      } else {
        responseText = decoder.decode(bytes)
        response = responseText
      }
      const define = (name: string, value: unknown) => {
        Object.defineProperty(this, name, { configurable: true, get: () => value })
      }
      define('status', status)
      define('statusText', statusText)
      define('response', response)
      if (!this.responseType || this.responseType === 'text') define('responseText', responseText)
      this.getResponseHeader = (header: string) =>
        header.toLowerCase() === 'content-type' ? type : null
      define('readyState', 4)
      this.dispatchEvent(new Event('readystatechange'))
      this.dispatchEvent(new ProgressEvent('load'))
      this.dispatchEvent(new ProgressEvent('loadend'))
    })
  }

  // 3. Rewrite relative media attributes inserted or mutated dynamically (e.g. images/* in viewers).
  const MEDIA_ATTRS = new Set(['src', 'poster', 'href', 'xlink:href'])
  const MEDIA_TAGS = new Set(['img', 'source', 'video', 'audio', 'image'])

  function resolveElementAttr(el: Element, attr: string): void {
    if (!MEDIA_TAGS.has(el.localName.toLowerCase())) return
    const raw = el.getAttribute(attr)
    if (!raw) return
    const target = resolveVirtual(raw)
    if (!target) return
    const mark = `${attr}:${target}`
    if (el.getAttribute('data-kettu-vfs-ref') === mark) return
    el.setAttribute('data-kettu-vfs-ref', mark)
    void toAssetUrl(target).then((url) => {
      if (!url || el.getAttribute('data-kettu-vfs-ref') !== mark) return
      el.setAttribute(attr, url)
    })
  }

  function scanElement(node: Node): void {
    if (node.nodeType !== 1) return
    const el = node as Element
    const tag = el.localName.toLowerCase()
    if (MEDIA_TAGS.has(tag)) {
      for (const attr of MEDIA_ATTRS) {
        if (el.hasAttribute(attr)) resolveElementAttr(el, attr)
      }
    }
    const nested = el.querySelectorAll('img,source,video,audio,image')
    for (let i = 0; i < nested.length; i++) {
      const child = nested[i]!
      for (const attr of MEDIA_ATTRS) {
        if (child.hasAttribute(attr)) resolveElementAttr(child, attr)
      }
    }
  }

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes' && record.attributeName) {
        resolveElementAttr(record.target as Element, record.attributeName)
      } else {
        for (let i = 0; i < record.addedNodes.length; i++) {
          scanElement(record.addedNodes[i]!)
        }
      }
    }
  })

  const startObserver = () => {
    if (document.documentElement) {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'poster', 'href', 'xlink:href'],
      })
      scanElement(document.documentElement)
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserver, { once: true })
  } else {
    startObserver()
  }

  // 4. Intercept clicks on relative HTML links within the same artifact and ask parent to navigate.
  document.addEventListener(
    'click',
    (event) => {
      if (event.defaultPrevented || event.button !== 0) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const anchor = (event.target as Element | null)?.closest?.('a[href]')
      if (!anchor) return
      const targetAttr = anchor.getAttribute('target')
      if (targetAttr && targetAttr !== '_self') return
      const href = anchor.getAttribute('href')
      if (!href || href.startsWith('#')) return
      const resolved = resolveVirtual(href)
      if (!resolved || !/\.html?$/i.test(resolved)) return
      event.preventDefault()
      const qIdx = href.indexOf('?')
      const hIdx = href.indexOf('#')
      const search = qIdx >= 0 ? href.slice(qIdx, hIdx >= 0 && hIdx > qIdx ? hIdx : undefined) : ''
      if (parentWin && parentWin !== window) {
        parentWin.postMessage({ kettuSandbox: 'navigate', nonce, path: resolved, search }, '*')
      }
    },
    false,
  )

  // 5. Notify the parent once parsing completes (so page-runtime has attached its listener) and
  //    listen to both readystatechange(complete) and load because document.open/write/close on a
  //    reused window does not always fire a second window.load event.
  if (parentWin && parentWin !== window) {
    let sentPortReady = false
    let sentLoaded = false
    const notifyPortReady = () => {
      if (sentPortReady) return
      sentPortReady = true
      parentWin.postMessage({ kettuSandbox: 'port-ready', nonce }, '*')
    }
    const notifyLoaded = () => {
      notifyPortReady()
      if (sentLoaded) return
      sentLoaded = true
      parentWin.postMessage({ kettuSandbox: 'loaded', nonce }, '*')
    }
    if (document.readyState === 'complete') {
      queueMicrotask(notifyLoaded)
    } else {
      if (document.readyState !== 'loading') {
        queueMicrotask(notifyPortReady)
      } else {
        document.addEventListener('DOMContentLoaded', notifyPortReady, { once: true })
      }
      document.addEventListener('readystatechange', () => {
        if (document.readyState === 'interactive') notifyPortReady()
        else if (document.readyState === 'complete') notifyLoaded()
      })
      window.addEventListener('load', notifyLoaded, { once: true })
    }
  }
}
