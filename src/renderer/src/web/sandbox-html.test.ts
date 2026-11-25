import { describe, expect, it, vi } from 'vitest'
import { ARTIFACT_CDNS, sandboxFrameCsp } from '@shared/artifact-policy'
import { SOURCE_ATTRIBUTE } from '@shared/artifact-source'
import { assembleHtml, assembleViewerHtml, resolveArtifactPath } from './sandbox-html'
import { createVirtualFrames } from './virtual-frames'
import type { HostLink } from '@shared/remote/link'

describe('sandboxFrameCsp', () => {
  it('forces opaque origin without allow-same-origin on every sandbox mode', () => {
    for (const mode of ['default', 'strict', 'viewer'] as const) {
      const csp = sandboxFrameCsp(mode)
      expect(csp).toContain('sandbox allow-scripts')
      expect(csp).not.toContain('allow-same-origin')
      expect(csp).toContain("frame-ancestors 'self'")
      expect(csp).toContain("default-src 'none'")
      expect(csp).toContain("form-action 'none'")
      expect(csp).toContain("base-uri 'none'")
    }
  })

  it('keeps strict and viewer policies free of external CDNs and default free of self', () => {
    const lax = sandboxFrameCsp('default')
    const strict = sandboxFrameCsp('strict')
    const viewer = sandboxFrameCsp('viewer')

    for (const cdn of ARTIFACT_CDNS) {
      expect(lax).toContain(cdn)
      expect(strict).not.toContain(cdn)
      expect(viewer).not.toContain(cdn)
    }
    expect(lax).not.toContain("script-src 'self'")
    expect(strict).not.toContain("script-src 'self'")
    expect(strict).not.toContain("connect-src 'self'")
    expect(viewer).not.toContain("'unsafe-eval'")
  })
})

describe('resolveArtifactPath', () => {
  const files = new Set([
    'index.html',
    'shared.css',
    'frames/home.html',
    'frames/style.css',
    'assets/logo.png',
    'assets/a b.png',
  ])

  it('resolves relative, nested, root-relative and encoded paths inside files', () => {
    expect(resolveArtifactPath('', 'shared.css', files)).toBe('shared.css')
    expect(resolveArtifactPath('', './shared.css?v=1#top', files)).toBe('shared.css')
    expect(resolveArtifactPath('frames/', 'style.css', files)).toBe('frames/style.css')
    expect(resolveArtifactPath('frames/', '../shared.css', files)).toBe('shared.css')
    expect(resolveArtifactPath('frames/', '/assets/logo.png', files)).toBe('assets/logo.png')
    expect(resolveArtifactPath('', 'assets/a%20b.png', files)).toBe('assets/a b.png')
  })

  it('rejects traversal, external schemes and unknown files', () => {
    expect(resolveArtifactPath('frames/', '../../etc/passwd', files)).toBeNull()
    expect(resolveArtifactPath('', '../shared.css', files)).toBeNull()
    expect(resolveArtifactPath('', 'https://cdn.jsdelivr.net/a.js', files)).toBeNull()
    expect(resolveArtifactPath('', '//example.com/a.js', files)).toBeNull()
    expect(resolveArtifactPath('', 'javascript:alert(1)', files)).toBeNull()
    expect(resolveArtifactPath('', 'data:text/plain,hi', files)).toBeNull()
    expect(resolveArtifactPath('', 'missing.css', files)).toBeNull()
  })
})

describe('assembleHtml', () => {
  it('preserves original source offsets while inlining local CSS, JS, images and defer order', async () => {
    const rawHtml = [
      '<!doctype html>',
      '<html>',
      '<head>',
      '<link rel="stylesheet" href="shared.css" />',
      '<script defer src="head-defer.js"></script>',
      '</head>',
      '<body>',
      '<h1 id="title">Hello</h1>',
      '<img src="assets/dot.png" />',
      '<script src="app.js"></script>',
      '</body>',
      '</html>',
    ].join('\n')
    const h1Offset = rawHtml.indexOf('<h1 id="title">')
    const files = new Set([
      'layout.html',
      'shared.css',
      'base.css',
      'head-defer.js',
      'app.js',
      'assets/dot.png',
    ])
    const texts: Record<string, string> = {
      'shared.css': '@import "./base.css"; .hero { background: url("assets/dot.png"); }',
      'base.css': 'body { margin: 0; }',
      'head-defer.js': 'window.order.push("defer");',
      'app.js': 'const closing = "</script>"; window.order.push("app");',
    }
    const dataUrls: Record<string, string> = {
      'assets/dot.png': 'data:image/png;base64,AAAA',
    }

    const assembled = await assembleHtml({
      html: rawHtml,
      path: 'layout.html',
      page: null,
      files,
      readText: async (p) => texts[p] ?? null,
      readDataUrl: async (p) => dataUrls[p] ?? null,
    })

    // Verify source offsets still match byte positions in the original HTML.
    expect(assembled).toMatch(
      new RegExp(`<h1 ${SOURCE_ATTRIBUTE}="[a-z0-9]{8}:${h1Offset}" id="title">`),
    )
    // Verify the sandbox shim runs before page-runtime.
    expect(assembled.indexOf('__kettuSandboxShim.start')).toBeGreaterThan(-1)
    expect(assembled.indexOf('__kettuRuntime.start')).toBeGreaterThan(
      assembled.indexOf('__kettuSandboxShim.start'),
    )
    // Verify CSS @import/url(), image data URLs, closing script escaping, and defer order.
    expect(assembled).toContain('body { margin: 0; }')
    expect(assembled).toContain('url("data:image/png;base64,AAAA")')
    expect(assembled).toContain('src="data:image/png;base64,AAAA"')
    expect(assembled).toContain('<\\/script>')
    expect(assembled.indexOf('window.order.push("app")')).toBeLessThan(
      assembled.indexOf('window.order.push("defer")'),
    )
    expect(assembled.indexOf('window.order.push("defer")')).toBeLessThan(
      assembled.indexOf('</body>'),
    )
  })

  it('rewrites relative ES module imports into inline data modules', async () => {
    const rawHtml =
      '<!doctype html><html><body><script type="module" src="./main.js"></script></body></html>'
    const files = new Set(['index.html', 'main.js', 'util.js'])
    const texts: Record<string, string> = {
      'main.js': 'import { answer } from "./util.js"; window.v = answer();',
      'util.js': 'export const answer = () => 42;',
    }

    const assembled = await assembleHtml({
      html: rawHtml,
      path: 'index.html',
      page: null,
      files,
      readText: async (p) => texts[p] ?? null,
      readDataUrl: async () => null,
    })

    expect(assembled).toMatch(/<script\b[^>]*\btype="module"/)
    expect(assembled).toContain('from "data:text/javascript;charset=utf-8;base64,')
    expect(assembled).not.toContain('src="./main.js"')
  })
})

describe('assembleViewerHtml', () => {
  it('points typed viewers at /_kettu/viewer/ and preloads the content file', () => {
    const html = assembleViewerHtml({
      type: { name: 'document', format: 1 },
      version: 2,
      locale: 'zh-CN',
      files: new Set(['document.md', 'images/chart.png']),
      entryPath: 'document.md',
      entryText: '# Title',
    })
    expect(html).not.toBeNull()
    expect(html).toContain('href="/_kettu/viewer/document.css"')
    expect(html).toContain('src="/_kettu/viewer/document.js"')
    expect(html).toContain('__kettuSandboxShim.start')
    expect(html).toContain('__kettuRuntime.start')
    expect(html).toContain('# Title')
  })
})

describe('createVirtualFrames capability guard', () => {
  it('blocks files/sample on lax frames and triggers strict upgrade for older hosts', async () => {
    const token = 'A'.repeat(43)
    const origin = 'https://app.kettu.sh'
    vi.stubGlobal('location', { origin, href: `${origin}/` })
    vi.stubGlobal('document', { documentElement: { lang: 'en' } })

    const request = vi.fn(async (method: string) => {
      if (method === 'artifacts.openFrame') return { path: `/frame/${token}/` }
      if (method === 'artifacts.read') {
        return {
          title: 'Legacy host artifact',
          version: 1,
          html: '<!doctype html><html><body>hi</body></html>',
          files: [{ path: 'index.html', size: 42, type: 'text/html; charset=utf-8' }],
        }
      }
      return null
    })
    const fakeLink = { request } as unknown as HostLink
    const virtual = createVirtualFrames(fakeLink)
    const opened = await virtual.open('art_01J9Z3K4V5W6X7Y8Z9A0B1C2D3')
    expect(opened).toEqual({ url: `${origin}/frame/${token}/` })
    const frameUrl = (opened as { url: string }).url

    const first = await virtual.host.prepare(`${frameUrl}_kettu/v/1/index.html`)
    expect(first.sandboxPath).toBe('/_kettu/frame')
    expect(first.strict).toBe(false)
    first.dispose()

    const upgraded = vi.fn()
    const off = virtual.host.onStrictUpgrade(frameUrl, upgraded)
    expect(virtual.host.allowCapability(frameUrl, 'db')).toBe(true)
    expect(virtual.host.allowCapability(frameUrl, 'files')).toBe(false)
    expect(upgraded).toHaveBeenCalledTimes(1)
    off()

    const second = await virtual.host.prepare(`${frameUrl}_kettu/v/1/index.html`)
    expect(second.sandboxPath).toBe('/_kettu/frame-strict')
    expect(second.strict).toBe(true)
    expect(virtual.host.allowCapability(frameUrl, 'files')).toBe(true)
    second.dispose()

    vi.unstubAllGlobals()
  })
})
