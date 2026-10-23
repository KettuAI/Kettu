import { describe, expect, it } from 'vitest'
import { ARTIFACT_CDNS, ARTIFACT_CSP, artifactHeaders, mayRequest } from './policy'

const HOST = '0123456789abcdef0123456789'

describe('mayRequest', () => {
  it.each([
    `overbench-artifact://${HOST}/`,
    `overbench-artifact://${HOST}/index.html?v=2`,
    'data:image/png;base64,AAAA',
    `blob:overbench-artifact://${HOST}/0b1c`,
    ...ARTIFACT_CDNS.map((origin) => `${origin}/lib.js`),
    'https://cdn.jsdelivr.net:443/npm/chart.js',
  ])('lets a page load %s', (url) => {
    expect(mayRequest(HOST, url)).toBe(true)
  })

  it.each([
    'overbench-artifact://ffffffffffffffffffffffffff/',
    'https://example.com/collect?d=secret',
    'http://cdn.jsdelivr.net/npm/x',
    'https://cdn.jsdelivr.net:8443/npm/x',
    'https://user:pass@cdn.jsdelivr.net/npm/x',
    'https://cdn.jsdelivr.net.example.com/x',
    'wss://cdn.jsdelivr.net/socket',
    'ws://127.0.0.1:5173/',
    'http://localhost:5173/src/main.tsx',
    'file:///etc/passwd',
    'devtools://devtools/bundled/inspector.html',
    'chrome://gpu',
    'about:blank',
    'not a url',
  ])('stops a page from loading %s', (url) => {
    expect(mayRequest(HOST, url)).toBe(false)
  })
})

describe('the policy', () => {
  it('allows nothing by default and names the CDNs only where the design does', () => {
    const directives = new Map(
      ARTIFACT_CSP.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1)]),
    )
    expect(directives.get('default-src')).toEqual(["'none'"])
    expect(directives.get('frame-src')).toEqual(["'self'"])
    expect(directives.get('form-action')).toEqual(["'none'"])
    expect(directives.get('media-src')).toEqual(["'self'", 'data:', 'blob:'])
    for (const name of ['script-src', 'style-src', 'font-src', 'img-src', 'connect-src']) {
      expect(directives.get(name)).toEqual(expect.arrayContaining([...ARTIFACT_CDNS]))
    }
  })

  it('goes out with every header the design lists', () => {
    const headers = artifactHeaders()
    expect(headers['Content-Security-Policy']).toBe(ARTIFACT_CSP)
    expect(headers['Permissions-Policy']).toContain('camera=()')
    expect(headers['Permissions-Policy']).toContain('fullscreen=()')
    expect(headers).toMatchObject({
      'Content-Type': 'text/html; charset=utf-8',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    })
  })
})
