import { describe, expect, it } from 'vitest'
import { linkIconUrl } from './site-icons'

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
