// A Vite plugin that puts the files PDF.js reads at run time in a folder of the build's own,
// `assets/pdfjs/`, under the names PDF.js asks for: its character maps and standard fonts for
// pages that do not embed theirs, and the JavaScript decoders for JPEG 2000 and JBIG2 images that
// the PDF viewer runs in place of WebAssembly. The dev server answers the same paths. Bundling
// would hash their names, which PDF.js builds its requests from.

import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { Plugin } from 'vite'

/** Where the files live in the build, and so in the URLs the viewer asks for. */
export const PDFJS_DATA_DIR = 'assets/pdfjs/'

/** What the viewer needs from each folder of the package, and under which folder it is served. */
const FOLDERS: { from: string; to: string; keep: RegExp }[] = [
  { from: 'cmaps', to: 'cmaps', keep: /\.bcmap$|^LICENSE$/ },
  { from: 'standard_fonts', to: 'standard_fonts', keep: /\.(?:pfb|ttf)$|^LICENSE/ },
  { from: 'wasm', to: '', keep: /_nowasm_fallback\.js$|^LICENSE_(?:JBIG2|OPENJPEG)$/ },
]

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
}

/** The files by their path under the data folder, with the file each is read from. */
function listFiles(root: string): Map<string, string> {
  const files = new Map<string, string>()
  for (const { from, to, keep } of FOLDERS) {
    const dir = path.join(root, from)
    for (const name of readdirSync(dir)) {
      if (keep.test(name)) files.set(path.posix.join(to, name), path.join(dir, name))
    }
  }
  return files
}

export function pdfjsData(): Plugin {
  const root = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  const files = listFiles(root)
  return {
    name: 'kettu:pdfjs-data',
    configureServer(server) {
      server.middlewares.use(`/${PDFJS_DATA_DIR}`, (request, response, next) => {
        const file = files.get(decodeURIComponent((request.url ?? '').split('?')[0]!.slice(1)))
        if (!file) return next()
        response.setHeader('Content-Type', TYPES[path.extname(file)] ?? 'application/octet-stream')
        response.end(readFileSync(file))
      })
    },
    generateBundle() {
      for (const [name, file] of files) {
        this.emitFile({
          type: 'asset',
          fileName: `${PDFJS_DATA_DIR}${name}`,
          source: readFileSync(file),
        })
      }
    },
  }
}
