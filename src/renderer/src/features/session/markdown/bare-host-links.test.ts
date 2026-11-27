import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { defaultRehypePlugins, Streamdown, type Components } from 'streamdown'
import { describe, expect, it } from 'vitest'
import { isBareLink, isLocalLink, planLinkOpen, type LinkPrefs } from '../link-open'
import { bareHostUrl, findBareHostLinks, restoreIpv6Hrefs } from './bare-host-links'
import { cjkPlugin } from './cjk-plugin'
import { localTarget, unopenedTarget } from './local-links'
import { remarkPlugins } from './remark'

function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join('')
  return ''
}

const components: Components = {
  a: ({ href, children }) => {
    const raw = href ?? ''
    const local = localTarget(raw)
    if (local !== null) return `[${text(children)}](local:${local})`
    const unopened = unopenedTarget(raw)
    if (unopened !== null) return `[${text(children)}](unopened:${unopened})`
    return `[${text(children)}](${raw})`
  },
}

const rehypePlugins = Object.entries(defaultRehypePlugins).flatMap(([name, plugin]) =>
  name === 'harden' ? [restoreIpv6Hrefs, plugin] : [plugin],
)

function render(markdown: string): string {
  const html = renderToStaticMarkup(
    createElement(
      Streamdown,
      {
        mode: 'streaming',
        parseIncompleteMarkdown: false,
        plugins: { cjk: cjkPlugin },
        remarkPlugins,
        rehypePlugins,
        components,
        linkSafety: { enabled: false },
        controls: false,
      },
      markdown,
    ),
  )
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .trim()
}

describe('findBareHostLinks and bareHostUrl', () => {
  it('matches valid bare IPv4, localhost, and IPv6 host:port addresses', () => {
    expect(findBareHostLinks('127.0.0.1:4173')).toEqual([
      { from: 0, to: 14, url: 'http://127.0.0.1:4173/' },
    ])
    expect(findBareHostLinks('192.168.1.20:4173')).toEqual([
      { from: 0, to: 17, url: 'http://192.168.1.20:4173/' },
    ])
    expect(findBareHostLinks('0.0.0.0:8000 and 255.255.255.255:65535')).toEqual([
      { from: 0, to: 12, url: 'http://0.0.0.0:8000/' },
      { from: 17, to: 38, url: 'http://255.255.255.255:65535/' },
    ])
    expect(findBareHostLinks('192.168.1.10:8080/api?a=1#top')).toEqual([
      { from: 0, to: 29, url: 'http://192.168.1.10:8080/api?a=1#top' },
    ])
    expect(findBareHostLinks('127.0.0.1:80/health')).toEqual([
      { from: 0, to: 19, url: 'http://127.0.0.1/health' },
    ])
    expect(findBareHostLinks('Open localhost:3000 or api.localhost:5173/v1')).toEqual([
      { from: 5, to: 19, url: 'http://localhost:3000/' },
      { from: 23, to: 44, url: 'http://api.localhost:5173/v1' },
    ])
    expect(findBareHostLinks('LOCALHOST:8080')).toEqual([
      { from: 0, to: 14, url: 'http://localhost:8080/' },
    ])
    expect(findBareHostLinks('Listening on [::1]:4173/status?ready=1#check')).toEqual([
      { from: 13, to: 44, url: 'http://[::1]:4173/status?ready=1#check' },
    ])
    expect(findBareHostLinks('Check [fe80::1]:8080 and [2001:DB8::1]:8443/api')).toEqual([
      { from: 6, to: 20, url: 'http://[fe80::1]:8080/' },
      { from: 25, to: 47, url: 'http://[2001:db8::1]:8443/api' },
    ])
  })

  it('trims surrounding English and CJK punctuation without dropping balanced brackets', () => {
    const extract = (input: string) =>
      findBareHostLinks(input).map((item) => ({
        text: input.slice(item.from, item.to),
        url: item.url,
      }))

    expect(extract('服务地址是 127.0.0.1:4173，启动后可访问。')).toEqual([
      { text: '127.0.0.1:4173', url: 'http://127.0.0.1:4173/' },
    ])
    expect(extract('请打开127.0.0.1:4173/status?ready=1#check（测试环境）。')).toEqual([
      {
        text: '127.0.0.1:4173/status?ready=1#check',
        url: 'http://127.0.0.1:4173/status?ready=1#check',
      },
    ])
    expect(extract('地址：192.168.1.20:4173和127.0.0.1:3000。')).toEqual([
      { text: '192.168.1.20:4173', url: 'http://192.168.1.20:4173/' },
      { text: '127.0.0.1:3000', url: 'http://127.0.0.1:3000/' },
    ])
    expect(
      extract('(127.0.0.1:4173), (127.0.0.1:4173/api), (127.0.0.1:4173/wiki/Foo_(bar)).'),
    ).toEqual([
      { text: '127.0.0.1:4173', url: 'http://127.0.0.1:4173/' },
      { text: '127.0.0.1:4173/api', url: 'http://127.0.0.1:4173/api' },
      { text: '127.0.0.1:4173/wiki/Foo_(bar)', url: 'http://127.0.0.1:4173/wiki/Foo_(bar)' },
    ])
    expect(
      extract('Is it at 127.0.0.1:4173? Ready at 127.0.0.1:4173: ok; [[::1]:4173/api]'),
    ).toEqual([
      { text: '127.0.0.1:4173', url: 'http://127.0.0.1:4173/' },
      { text: '127.0.0.1:4173', url: 'http://127.0.0.1:4173/' },
      { text: '[::1]:4173/api', url: 'http://[::1]:4173/api' },
    ])
  })

  it('rejects invalid octets, ports, schemes, userinfo, paths, ranges, and non-addresses', () => {
    for (const input of [
      '1.2.3.4',
      '127.0.0.1',
      'localhost',
      '[::1]',
      '999.168.1.20:4173',
      '127.0.0.256:4173',
      '01.2.3.4:4173',
      '127.0.0.01:4173',
      '1.2.3.4.5:80',
      '1.2.3:80',
      '192.168.1.20:65536',
      '192.168.1.20:0',
      '192.168.1.20:080',
      '192.168.1.20:999999',
      'localhost:65536',
      '[::1]:0',
      'http://127.0.0.1:4173',
      'https://127.0.0.1:4173',
      'ws://127.0.0.1:3000',
      'wss://127.0.0.1:3000/ws',
      'ssh://192.168.1.1:22',
      'tcp://127.0.0.1:5432',
      '//127.0.0.1:4173',
      'src/127.0.0.1:4173',
      'src/localhost:3000',
      'user@192.168.1.1:22',
      'root@localhost:22',
      'user@[::1]:22',
      '127.0.0.1:4173@evil.com',
      'HOST=127.0.0.1:4173',
      'v1.2.3.4:80',
      'notlocalhost:3000',
      'my-localhost:3000',
      '127.0.0.1:8080:80',
      '127.0.0.1:8000-8010',
      '127.0.0.1:80ms',
      '127.0.0.1:80.1',
      '12:34:56',
      '[::1::2]:8080',
      '[1234]:8080',
      '::ffff:127.0.0.1:80',
    ]) {
      expect(findBareHostLinks(input), input).toEqual([])
    }

    expect(bareHostUrl('127.0.0.1:4173')).toBe('http://127.0.0.1:4173/')
    expect(bareHostUrl('localhost:4173/api')).toBe('http://localhost:4173/api')
    expect(bareHostUrl('[::1]:4173')).toBe('http://[::1]:4173/')
    expect(bareHostUrl('docs/127.0.0.1:4173')).toBeNull()
    expect(bareHostUrl('127.0.0.1:4173 and more')).toBeNull()
  })
})

describe('Markdown rendering of bare host:port addresses (#2864)', () => {
  it('links bare IPv4, localhost, and IPv6 addresses while keeping explicit URLs intact', () => {
    expect(render('127.0.0.1:4173')).toBe('[127.0.0.1:4173](http://127.0.0.1:4173/)')
    expect(render('192.168.1.20:4173')).toBe('[192.168.1.20:4173](http://192.168.1.20:4173/)')
    expect(render('127.0.0.1:4173/status?ready=1#check')).toBe(
      '[127.0.0.1:4173/status?ready=1#check](http://127.0.0.1:4173/status?ready=1#check)',
    )
    expect(render('http://127.0.0.1:4173')).toBe('[http://127.0.0.1:4173](http://127.0.0.1:4173/)')
    expect(render('https://127.0.0.1:4173')).toBe(
      '[https://127.0.0.1:4173](https://127.0.0.1:4173/)',
    )
    expect(render('[查看状态](http://127.0.0.1:4173/status?ready=1#check)')).toBe(
      '[查看状态](http://127.0.0.1:4173/status?ready=1#check)',
    )
    expect(render('服务地址是 127.0.0.1:4173，启动后可访问。')).toBe(
      '服务地址是 [127.0.0.1:4173](http://127.0.0.1:4173/)，启动后可访问。',
    )
    expect(render('Dev server: localhost:5173 and [::1]:4173/health')).toBe(
      'Dev server: [localhost:5173](http://localhost:5173/) and [[::1]:4173/health](http://[::1]:4173/health)',
    )
    expect(render('[v6 explicit](https://[::1]:4173/api)')).toBe(
      '[v6 explicit](https://[::1]:4173/api)',
    )
  })

  it('normalizes bare host:port Markdown link targets without breaking local paths', () => {
    expect(render('[status](127.0.0.1:4173/status)')).toBe('[status](http://127.0.0.1:4173/status)')
    expect(render('[dev](localhost:4173)')).toBe('[dev](http://localhost:4173/)')
    expect(render('[v6]([::1]:4173)')).toBe('[v6](http://[::1]:4173/)')
    expect(render('[notes](docs/127.0.0.1:4173)')).toBe('[notes](local:docs/127.0.0.1:4173)')
  })

  it('keeps URL fragments intact instead of splitting numeric hashes into GitHub refs', () => {
    expect(render('Open 127.0.0.1:4173/page#12 now')).toBe(
      'Open [127.0.0.1:4173/page#12](http://127.0.0.1:4173/page#12) now',
    )
  })

  it('links inside formatting, lists, and tables while skipping code, existing links, and invalid text', () => {
    expect(render('**127.0.0.1:4173**')).toBe('[127.0.0.1:4173](http://127.0.0.1:4173/)')
    expect(render('- 192.168.1.20:4173')).toBe('[192.168.1.20:4173](http://192.168.1.20:4173/)')
    expect(render('| Host |\n| --- |\n| 127.0.0.1:4173 |')).toContain(
      '[127.0.0.1:4173](http://127.0.0.1:4173/)',
    )

    expect(render('Run `127.0.0.1:4173` in terminal')).toBe('Run 127.0.0.1:4173 in terminal')
    expect(render('```\n127.0.0.1:4173\n```')).not.toContain('](')
    expect(render('[127.0.0.1:4173](https://example.com)')).toBe(
      '[127.0.0.1:4173](https://example.com/)',
    )
    expect(render('[127.0.0.1:4173][dev]\n\n[dev]: https://example.com')).toBe(
      '[127.0.0.1:4173](https://example.com/)',
    )
    expect(render('ws://127.0.0.1:3000 and ssh://192.168.1.1:22')).toBe(
      'ws://127.0.0.1:3000 and ssh://192.168.1.1:22',
    )
    expect(render('1.2.3.4 and 999.168.1.20:4173 and 192.168.1.20:65536')).toBe(
      '1.2.3.4 and 999.168.1.20:4173 and 192.168.1.20:65536',
    )
    expect(render('user@192.168.1.1:22 and 1.2.3.4.5:80')).toBe(
      'user@192.168.1.1:22 and 1.2.3.4.5:80',
    )
    expect(render('<div>\n127.0.0.1:4173\n</div>')).not.toContain('](')
    expect(render('$$127.0.0.1:4173$$')).not.toContain('](')
  })

  it('produces URLs compatible with link-open routing, local classification, and bare display', () => {
    const prefs: LinkPrefs = {
      openLinksIn: 'browser',
      confirmLinks: true,
      alwaysOpenIn: {},
    }

    const loopback = bareHostUrl('127.0.0.1:4173')!
    expect(isBareLink('127.0.0.1:4173', loopback)).toBe(true)
    expect(isLocalLink(loopback)).toBe(true)
    expect(planLinkOpen(loopback, prefs, { session: true }, false, false)).toEqual({
      destination: 'session',
      ask: false,
    })
    expect(planLinkOpen(loopback, prefs, { session: true }, false, true)).toEqual({
      destination: 'browser',
      ask: false,
    })
    expect(planLinkOpen(loopback, prefs, { session: false }, false, false)).toEqual({
      destination: 'browser',
      ask: true,
    })

    for (const local of ['localhost:3000', '0.0.0.0:8000', '[::1]:4173']) {
      const url = bareHostUrl(local)!
      expect(isBareLink(local, url)).toBe(true)
      expect(isLocalLink(url)).toBe(true)
      expect(planLinkOpen(url, prefs, { session: true }, false, false)).toEqual({
        destination: 'session',
        ask: false,
      })
    }

    const lan = bareHostUrl('192.168.1.20:4173/status?ready=1#check')!
    expect(isBareLink('192.168.1.20:4173/status?ready=1#check', lan)).toBe(true)
    expect(isLocalLink(lan)).toBe(false)
    expect(planLinkOpen(lan, prefs, { session: true }, false, false)).toEqual({
      destination: 'browser',
      ask: true,
    })
    expect(planLinkOpen(lan, prefs, { session: true }, true, false)).toEqual({
      destination: 'browser',
      ask: false,
    })
  })
})
