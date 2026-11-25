// Emits static sandbox shell pages (`_kettu/frame*.html`) and copies built-in viewers (`_kettu/viewer/`)
// during web builds, and serves them with production-matching security headers in the dev server.

import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Plugin } from 'vite'

export interface WebSandboxOptions {
  viewersDir: string
  /** Map from sandbox shell route (e.g. `/_kettu/frame`) to its isolated HTTP CSP header. */
  frames: Readonly<Record<string, string>>
  shellHtml: string
  permissionsPolicy: string
  viewerPrefix: string
  mimeType: (filePath: string) => string
}

export function webSandbox(options: WebSandboxOptions): Plugin {
  const cspByPath = new Map<string, string>()
  for (const [route, csp] of Object.entries(options.frames)) {
    cspByPath.set(route, csp)
    cspByPath.set(`${route}.html`, csp)
  }

  return {
    name: 'kettu:web-sandbox',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const parsed = URL.parse(req.url ?? '', 'http://localhost')
        if (!parsed) return next()
        const csp = cspByPath.get(parsed.pathname)
        if (csp) {
          const body = Buffer.from(options.shellHtml, 'utf8')
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': body.length,
            'Content-Security-Policy': csp,
            'Permissions-Policy': options.permissionsPolicy,
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            'Cache-Control': 'no-cache',
          })
          res.end(req.method === 'HEAD' ? undefined : body)
          return
        }
        if (parsed.pathname.startsWith(options.viewerPrefix)) {
          const rel = parsed.pathname.slice(options.viewerPrefix.length)
          if (!rel || rel.includes('..') || rel.includes('\\')) {
            res.writeHead(404)
            res.end()
            return
          }
          const file = path.resolve(options.viewersDir, rel)
          const root = path.resolve(options.viewersDir)
          if (!file.startsWith(`${root}${path.sep}`)) {
            res.writeHead(404)
            res.end()
            return
          }
          void readFile(file)
            .then((bytes) => {
              res.writeHead(200, {
                'Content-Type': options.mimeType(rel),
                'Content-Length': bytes.length,
                'Access-Control-Allow-Origin': 'null',
                'Cross-Origin-Resource-Policy': 'cross-origin',
                'X-Content-Type-Options': 'nosniff',
                'Referrer-Policy': 'no-referrer',
                'Cache-Control': 'no-cache',
              })
              res.end(req.method === 'HEAD' ? undefined : bytes)
            })
            .catch(() => {
              res.writeHead(404)
              res.end()
            })
          return
        }
        next()
      })
    },
    async writeBundle(bundleOptions) {
      const outDir = bundleOptions.dir
      if (!outDir) return
      const kettuDir = path.join(outDir, '_kettu')
      await mkdir(kettuDir, { recursive: true })
      for (const route of Object.keys(options.frames)) {
        const name = `${path.basename(route)}.html`
        await writeFile(path.join(kettuDir, name), options.shellHtml, 'utf8')
      }
      const hasViewers = await stat(options.viewersDir).then(
        (info) => info.isDirectory(),
        () => false,
      )
      if (!hasViewers) {
        throw new Error(
          `Missing built artifact viewers at ${options.viewersDir}; run vite.viewers.config.mts first.`,
        )
      }
      const target = path.join(kettuDir, 'viewer')
      await cp(options.viewersDir, target, {
        recursive: true,
        filter: (src) => path.basename(src) !== 'parts.json',
      })
    },
  }
}
