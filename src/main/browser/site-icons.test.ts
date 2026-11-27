import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SiteIconEvent } from '@shared/ipc'
import { SiteIcons, linkIconUrl, linkIconUrls, type IconFetch } from './site-icons'

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`

function iconResponse(bytes: Buffer = PNG_BYTES): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': 'image/png' },
  })
}

function notFoundResponse(): Response {
  return new Response(null, { status: 404 })
}

describe('linkIconUrl', () => {
  it('sends only the host of a public site', () => {
    expect(linkIconUrl('https://expo.dev/blog/device-hub?ref=x#top')).toBe(
      'https://www.google.com/s2/favicons?domain=expo.dev&sz=64',
    )
    expect(linkIconUrl('http://docs.expo.dev:8080/')).toBe(
      'https://www.google.com/s2/favicons?domain=docs.expo.dev&sz=64',
    )
    expect(linkIconUrl('https://Example.COM./a')).toBe(
      'https://www.google.com/s2/favicons?domain=example.com&sz=64',
    )
  })

  it('sends nothing for an address, a name without a public suffix or credentials', () => {
    for (const url of [
      'https://8.8.8.8/',
      'https://[2001:db8::1]/',
      'http://localhost:3000/',
      'http://app.localhost/',
      'http://printer.local/',
      'https://jira.corp/browse/X-1',
      'https://wiki.internal/',
      'http://intranet/',
      'https://co.uk/',
      'https://user:secret@expo.dev/',
      'https://user@expo.dev/',
    ]) {
      expect(linkIconUrl(url), url).toBeNull()
    }
  })

  it('sends nothing for other schemes or an unreadable address', () => {
    for (const url of [
      'file:///etc/hosts',
      'ftp://expo.dev/',
      'javascript:alert(1)',
      'not a url',
    ]) {
      expect(linkIconUrl(url), url).toBeNull()
    }
  })
})

describe('linkIconUrls', () => {
  it('returns only the host for a bare registrable domain', () => {
    expect(linkIconUrls('https://expo.dev/blog/device-hub?ref=x#top')).toEqual([
      'https://www.google.com/s2/favicons?domain=expo.dev&sz=64',
    ])
    expect(linkIconUrls('https://Example.COM./a')).toEqual([
      'https://www.google.com/s2/favicons?domain=example.com&sz=64',
    ])
    expect(linkIconUrls('https://example.co.uk/docs')).toEqual([
      'https://www.google.com/s2/favicons?domain=example.co.uk&sz=64',
    ])
  })

  it('adds the registrable domain after a subdomain', () => {
    expect(linkIconUrls('https://mcp.context7.com/mcp')).toEqual([
      'https://www.google.com/s2/favicons?domain=mcp.context7.com&sz=64',
      'https://www.google.com/s2/favicons?domain=context7.com&sz=64',
    ])
    expect(linkIconUrls('https://api.githubcopilot.com/mcp/')).toEqual([
      'https://www.google.com/s2/favicons?domain=api.githubcopilot.com&sz=64',
      'https://www.google.com/s2/favicons?domain=githubcopilot.com&sz=64',
    ])
    expect(linkIconUrls('https://mcp.linear.app/sse')).toEqual([
      'https://www.google.com/s2/favicons?domain=mcp.linear.app&sz=64',
      'https://www.google.com/s2/favicons?domain=linear.app&sz=64',
    ])
    expect(linkIconUrls('https://mcp.api.example.co.uk/v1')).toEqual([
      'https://www.google.com/s2/favicons?domain=mcp.api.example.co.uk&sz=64',
      'https://www.google.com/s2/favicons?domain=example.co.uk&sz=64',
    ])
    expect(linkIconUrls('http://docs.expo.dev:8080/')).toEqual([
      'https://www.google.com/s2/favicons?domain=docs.expo.dev&sz=64',
      'https://www.google.com/s2/favicons?domain=expo.dev&sz=64',
    ])
    expect(linkIconUrls('https://MCP.Context7.COM./mcp')).toEqual([
      'https://www.google.com/s2/favicons?domain=mcp.context7.com&sz=64',
      'https://www.google.com/s2/favicons?domain=context7.com&sz=64',
    ])
  })

  it('returns nothing for non-public hosts, IPs, localhost or invalid URLs', () => {
    for (const url of [
      'https://8.8.8.8/',
      'https://[2001:db8::1]/',
      'http://localhost:3000/',
      'http://app.localhost/',
      'http://printer.local/',
      'https://jira.corp/browse/X-1',
      'https://co.uk/',
      'https://user:secret@mcp.context7.com/',
      'file:///etc/hosts',
      'not a url',
    ]) {
      expect(linkIconUrls(url), url).toEqual([])
    }
  })
})

describe('SiteIcons.link', () => {
  const dirs: string[] = []

  async function openIcons(fetchImpl: IconFetch) {
    const dir = await mkdtemp(join(tmpdir(), 'site-icons-'))
    dirs.push(dir)
    const events: SiteIconEvent[] = []
    const fetch = vi.fn(fetchImpl)
    const icons = SiteIcons.open(dir, {
      fetch,
      changed: (event) => events.push(event),
    })
    await icons.ready
    return { icons, events, fetch }
  }

  afterEach(async () => {
    vi.useRealTimers()
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('falls back to the registrable domain when the full subdomain answers 404', async () => {
    const { icons, events, fetch } = await openIcons(async (url) => {
      if (url.includes('domain=context7.com&')) return iconResponse()
      return notFoundResponse()
    })

    await icons.link('https://mcp.context7.com/mcp')

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://www.google.com/s2/favicons?domain=mcp.context7.com&sz=64',
      'https://www.google.com/s2/favicons?domain=context7.com&sz=64',
    ])
    expect(events).toEqual([
      { kind: 'link', origin: 'https://mcp.context7.com', icon: PNG_DATA_URL },
    ])

    // A later ask re-emits the cached icon without contacting the service again.
    await icons.link('https://mcp.context7.com/other')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(events).toHaveLength(2)
  })

  it('falls back across multi-part public suffixes such as .co.uk', async () => {
    const { icons, events, fetch } = await openIcons(async (url) => {
      if (url.includes('domain=example.co.uk&')) return iconResponse()
      return notFoundResponse()
    })

    await icons.link('https://mcp.api.example.co.uk/sse')

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://www.google.com/s2/favicons?domain=mcp.api.example.co.uk&sz=64',
      'https://www.google.com/s2/favicons?domain=example.co.uk&sz=64',
    ])
    expect(events).toEqual([
      { kind: 'link', origin: 'https://mcp.api.example.co.uk', icon: PNG_DATA_URL },
    ])
  })

  it('keeps the full subdomain icon without requesting the registrable domain when available', async () => {
    const { icons, events, fetch } = await openIcons(async () => iconResponse())

    await icons.link('https://api.githubcopilot.com/mcp')

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://www.google.com/s2/favicons?domain=api.githubcopilot.com&sz=64',
    ])
    expect(events).toEqual([
      { kind: 'link', origin: 'https://api.githubcopilot.com', icon: PNG_DATA_URL },
    ])
  })

  it('does not repeat the request for a bare registrable domain when it answers 404', async () => {
    const { icons, events, fetch } = await openIcons(async () => notFoundResponse())

    await icons.link('https://context7.com/')

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://www.google.com/s2/favicons?domain=context7.com&sz=64',
    ])
    expect(events).toEqual([])
  })

  it('emits nothing and backs off when both subdomain and registrable domain fail', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-27T00:00:00Z'))

    let rootAvailable = false
    const { icons, events, fetch } = await openIcons(async (url) => {
      if (rootAvailable && url.includes('domain=noicon.com&')) return iconResponse()
      return notFoundResponse()
    })

    await icons.link('https://mcp.noicon.com/mcp')
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://www.google.com/s2/favicons?domain=mcp.noicon.com&sz=64',
      'https://www.google.com/s2/favicons?domain=noicon.com&sz=64',
    ])
    expect(events).toEqual([])

    // Asking the same subdomain again during backoff sends no request.
    vi.advanceTimersByTime(10_000)
    await icons.link('https://mcp.noicon.com/mcp')
    expect(fetch).toHaveBeenCalledTimes(2)

    // Another subdomain tries only itself and skips the recently failed registrable domain.
    await icons.link('https://api.noicon.com/mcp')
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://www.google.com/s2/favicons?domain=mcp.noicon.com&sz=64',
      'https://www.google.com/s2/favicons?domain=noicon.com&sz=64',
      'https://www.google.com/s2/favicons?domain=api.noicon.com&sz=64',
    ])
    expect(events).toEqual([])

    // Once backoff has elapsed, the registrable domain is retried and succeeds.
    rootAvailable = true
    vi.advanceTimersByTime(25_000)
    await icons.link('https://mcp.noicon.com/mcp')
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://www.google.com/s2/favicons?domain=mcp.noicon.com&sz=64',
      'https://www.google.com/s2/favicons?domain=noicon.com&sz=64',
      'https://www.google.com/s2/favicons?domain=api.noicon.com&sz=64',
      'https://www.google.com/s2/favicons?domain=mcp.noicon.com&sz=64',
      'https://www.google.com/s2/favicons?domain=noicon.com&sz=64',
    ])
    expect(events).toEqual([{ kind: 'link', origin: 'https://mcp.noicon.com', icon: PNG_DATA_URL }])
  })

  it('reuses a fetched registrable domain icon across subdomains without re-fetching it', async () => {
    const { icons, events, fetch } = await openIcons(async (url) => {
      if (url.includes('domain=githubcopilot.com&')) return iconResponse()
      return notFoundResponse()
    })

    await icons.link('https://api.githubcopilot.com/mcp')
    await icons.link('https://mcp.githubcopilot.com/mcp')

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://www.google.com/s2/favicons?domain=api.githubcopilot.com&sz=64',
      'https://www.google.com/s2/favicons?domain=githubcopilot.com&sz=64',
      'https://www.google.com/s2/favicons?domain=mcp.githubcopilot.com&sz=64',
    ])
    expect(events).toEqual([
      { kind: 'link', origin: 'https://api.githubcopilot.com', icon: PNG_DATA_URL },
      { kind: 'link', origin: 'https://mcp.githubcopilot.com', icon: PNG_DATA_URL },
    ])
  })

  it('deduplicates concurrent fallbacks to the same registrable domain', async () => {
    let releaseRoot!: () => void
    const rootGate = new Promise<void>((resolve) => {
      releaseRoot = resolve
    })

    const { icons, events, fetch } = await openIcons(async (url) => {
      if (url.includes('domain=linear.app&')) {
        await rootGate
        return iconResponse()
      }
      return notFoundResponse()
    })

    const first = icons.link('https://mcp.linear.app/sse')
    const second = icons.link('https://api.linear.app/sse')
    releaseRoot()
    await Promise.all([first, second])

    const rootCalls = fetch.mock.calls.filter(([url]) => url.includes('domain=linear.app&'))
    expect(rootCalls).toHaveLength(1)
    expect(events).toHaveLength(2)
    expect(events).toEqual(
      expect.arrayContaining([
        { kind: 'link', origin: 'https://mcp.linear.app', icon: PNG_DATA_URL },
        { kind: 'link', origin: 'https://api.linear.app', icon: PNG_DATA_URL },
      ]),
    )
  })

  it('skips IP addresses and localhost without making any request', async () => {
    const { icons, events, fetch } = await openIcons(async () => iconResponse())

    await icons.link('http://localhost:3000/mcp')
    await icons.link('http://127.0.0.1:8080/mcp')
    await icons.link('https://8.8.8.8/mcp')
    await icons.link('https://[2001:db8::1]/mcp')

    expect(fetch).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it('forgets cached icons and failure backoff on clear', async () => {
    let available = false
    const { icons, events, fetch } = await openIcons(async (url) => {
      if (available && url.includes('domain=notion.com&')) return iconResponse()
      return notFoundResponse()
    })

    await icons.link('https://mcp.notion.com/mcp')
    expect(events).toEqual([])

    await icons.clear()
    available = true
    await icons.link('https://mcp.notion.com/mcp')

    expect(fetch).toHaveBeenCalledTimes(4)
    expect(events).toEqual([
      { kind: 'cleared' },
      { kind: 'link', origin: 'https://mcp.notion.com', icon: PNG_DATA_URL },
    ])
  })
})
