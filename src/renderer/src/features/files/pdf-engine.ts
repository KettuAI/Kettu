// PDF.js for the Files pane: the library with its worker, the viewer layer and the way a document
// opens. Only the PDF viewer imports it, so none of it loads until a PDF is opened.

import * as pdfjs from 'pdfjs-dist'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { mediaUrlToken } from '@shared/media'
import { readMedia, readRange } from '@renderer/lib/media-bytes'
import type { DocumentFailure } from './document-failure'

/** Where the build puts the files PDF.js reads at run time, which it builds its requests from. */
const DATA_URL = () => new URL(`${import.meta.env.BASE_URL}assets/pdfjs/`, document.baseURI).href

export type PdfFailure = DocumentFailure

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
  let source: { data: Uint8Array } | { range: RangeTransport } | { url: string } = { url }
  if (url.startsWith('blob:')) source = { data: await readMedia(url) }
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
