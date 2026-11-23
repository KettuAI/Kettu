// PDF.js for the Files pane: the library with its worker, the viewer layer and the way a document
// opens. Only the PDF viewer imports it, so none of it loads until a PDF is opened.

import * as pdfjs from 'pdfjs-dist'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { mediaUrlToken } from '@shared/media'
import { blobOf } from '@renderer/lib/media-blobs'

/** Where the build puts the files PDF.js reads at run time, which it builds its requests from. */
const DATA_URL = () => new URL(`${import.meta.env.BASE_URL}assets/pdfjs/`, document.baseURI).href

/** Why a document did not open: the file is protected, is no PDF, or could not be read. */
export type PdfFailure = 'encrypted' | 'invalid' | 'unreadable'

export function pdfFailure(error: unknown): PdfFailure {
  const name = (error as { name?: unknown } | null)?.name
  if (name === 'PasswordException') return 'encrypted'
  if (name === 'InvalidPDFException' || name === 'FormatError') return 'invalid'
  return 'unreadable'
}

/** The viewer layer reads PDF.js from the global it is built against. */
type ViewerLibrary = typeof import('pdfjs-dist/web/pdf_viewer.mjs')
let viewerLibrary: Promise<ViewerLibrary> | null = null

export function loadViewerLibrary(): Promise<ViewerLibrary> {
  viewerLibrary ??= (async () => {
    ;(globalThis as { pdfjsLib?: unknown }).pdfjsLib = pdfjs
    return import('pdfjs-dist/web/pdf_viewer.mjs')
  })()
  return viewerLibrary
}

export { pdfjs }

export interface OpenedPdf {
  document: PDFDocumentProxy
  close(): void
}

/** The first read of a file on the media scheme, and the most one range asks beyond it. */
const FIRST_BYTES = 64 * 1024

/**
 * Reads `begin` to `end` (exclusive) of a file on the media scheme, and how long the file is.
 * PDF.js reads ranges from http(s) URLs alone, so it reads these through `RangeTransport`; an
 * XHR, since the page may not fetch the scheme.
 */
function readRange(
  url: string,
  begin: number,
  end: number,
  requests: Set<XMLHttpRequest>,
): Promise<{ bytes: Uint8Array; total: number }> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    requests.add(request)
    request.open('GET', url)
    request.responseType = 'arraybuffer'
    request.setRequestHeader('Range', `bytes=${begin}-${end - 1}`)
    request.onload = () => {
      requests.delete(request)
      const body = request.response as ArrayBuffer
      if (request.status === 206) {
        const total = Number(/\/(\d+)$/.exec(request.getResponseHeader('Content-Range') ?? '')?.[1])
        if (Number.isSafeInteger(total)) return resolve({ bytes: new Uint8Array(body), total })
      } else if (request.status === 200) {
        // A server that ignored the range sent the whole file.
        const whole = new Uint8Array(body)
        return resolve({ bytes: whole.subarray(begin, end), total: whole.length })
      }
      reject(new Error(`The file could not be read: ${request.status}`))
    }
    request.onerror = () => {
      requests.delete(request)
      reject(new Error('The file could not be read'))
    }
    request.onabort = () => requests.delete(request)
    request.send()
  })
}

/** PDF.js's own way to take a file from anywhere: it asks for the ranges it needs. */
class RangeTransport extends pdfjs.PDFDataRangeTransport {
  readonly requests = new Set<XMLHttpRequest>()

  constructor(
    private readonly url: string,
    total: number,
    first: Uint8Array,
    private readonly lost: (error: unknown) => void,
  ) {
    super(total, first)
  }

  override requestDataRange(begin: number, end: number): void {
    readRange(this.url, begin, end, this.requests).then(
      ({ bytes }) => this.onDataRange(begin, bytes),
      (error: unknown) => this.lost(error),
    )
  }

  override abort(): void {
    for (const request of this.requests) request.abort()
  }
}

/**
 * Opens the PDF at a media URL, read by ranges so a large file opens without being read whole:
 * by PDF.js itself from the web client's http(s) URL, and through `RangeTransport` from the
 * media scheme. The bytes of the web client's blob URL, which the page's policy lets no request
 * read, come from the blob. Scripts never run, and JPEG 2000 and JBIG2 images are decoded by
 * PDF.js's JavaScript decoders, since a page's policy leaves WebAssembly out. `lost` hears of a
 * read that fails once the document is open.
 */
export async function openPdf(url: string, lost: (error: unknown) => void): Promise<OpenedPdf> {
  const blob = url.startsWith('blob:') ? blobOf(url) : undefined
  if (url.startsWith('blob:') && !blob) throw new Error('The file is no longer held')
  let source: { data: Uint8Array } | { range: RangeTransport } | { url: string } = { url }
  if (blob) source = { data: new Uint8Array(await blob.arrayBuffer()) }
  else if (mediaUrlToken(url)) {
    const first = await readRange(url, 0, FIRST_BYTES, new Set())
    source =
      first.total <= first.bytes.length
        ? { data: first.bytes }
        : { range: new RangeTransport(url, first.total, first.bytes, lost) }
  }
  const port = new PdfWorker()
  const worker = pdfjs.PDFWorker.create({ port })
  const base = DATA_URL()
  const task = pdfjs.getDocument({
    ...source,
    worker,
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: base,
    useWasm: false,
    useWorkerFetch: false,
    enableXfa: false,
    disableAutoFetch: true,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  })
  const close = () => {
    void task.destroy().finally(() => {
      worker.destroy()
      port.terminate()
    })
  }
  try {
    return { document: await task.promise, close }
  } catch (error) {
    close()
    throw error
  }
}
