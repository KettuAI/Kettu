// A Vite plugin that gives the built page's scripts, module preloads and style sheets an SRI
// `integrity`, for the hosted web client. Vite adds none, and no plugin of the project's
// dependencies does. The hashes are taken from the files as written, since Vite still changes
// chunks after the page's HTML is made.

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Plugin } from 'vite'

const TAG = /<(?:script|link)\b[^>]*?\b(?:src|href)="\/([^"]+)"[^>]*>/g

export function integrity(): Plugin {
  return {
    name: 'kettu:integrity',
    apply: 'build',
    async writeBundle(options) {
      const dir = options.dir!
      const page = path.join(dir, 'index.html')
      const html = await readFile(page, 'utf8')
      const hashes = new Map<string, string>()
      for (const [, file] of html.matchAll(TAG)) {
        if (hashes.has(file!)) continue
        const bytes = await readFile(path.join(dir, file!))
        hashes.set(file!, createHash('sha384').update(bytes).digest('base64'))
      }
      const marked = html.replace(TAG, (tag: string, file: string) =>
        tag.includes(' integrity=')
          ? tag
          : tag.replace(/\s*\/?>$/, (end) => ` integrity="sha384-${hashes.get(file)}"${end}`),
      )
      await writeFile(page, marked)
    },
  }
}
