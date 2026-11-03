import { beforeEach, describe, expect, it, vi } from 'vitest'
import { iconFor, requestSiteIcon, useSiteIconsStore } from './site-icons'

const ICON = 'data:image/png;base64,AA=='

const loadSiteIcon = vi.fn()
vi.stubGlobal('window', { kettu: { browser: { loadSiteIcon } } })

describe('iconFor', () => {
  it("takes the icon of the link's own origin", () => {
    expect(iconFor({ 'https://docs.kettu.sh': ICON }, 'https://docs.kettu.sh/remote')).toBe(ICON)
  })

  it('tells a site opened without an icon from one never opened', () => {
    expect(iconFor({ 'https://kettu.sh': null }, 'https://kettu.sh/')).toBeNull()
    expect(iconFor({ 'https://kettu.sh': ICON }, 'https://example.com/')).toBeUndefined()
  })

  it("falls back to the same host's icon over the other scheme", () => {
    expect(iconFor({ 'https://kettu.sh': ICON }, 'http://kettu.sh/a')).toBe(ICON)
    expect(iconFor({ 'http://site.example:8080': ICON }, 'https://site.example:8080/')).toBe(ICON)
  })

  it('keeps an origin from another port or host apart', () => {
    expect(iconFor({ 'https://kettu.sh:8443': ICON }, 'https://kettu.sh/')).toBeUndefined()
    expect(iconFor({ 'https://docs.kettu.sh': ICON }, 'https://kettu.sh/')).toBeUndefined()
  })

  it('has nothing for an address that is not a web one, or keys from the object prototype', () => {
    expect(iconFor({}, 'mailto:a@b.c')).toBeUndefined()
    expect(iconFor({}, 'http://constructor/')).toBeUndefined()
  })
})

describe('requestSiteIcon', () => {
  beforeEach(() => {
    loadSiteIcon.mockReset()
    loadSiteIcon.mockResolvedValue(undefined)
    useSiteIconsStore.setState({ sites: {}, linked: {} })
  })

  it('asks once for a site with no icon yet, however many links it has', () => {
    requestSiteIcon('https://first.example/a')
    requestSiteIcon('https://first.example/b')
    expect(loadSiteIcon).toHaveBeenCalledTimes(1)
    expect(loadSiteIcon).toHaveBeenCalledWith('https://first.example/a')
  })

  it('asks for a site opened without an icon', () => {
    useSiteIconsStore.setState({ sites: { 'https://second.example': null } })
    requestSiteIcon('https://second.example/a')
    expect(loadSiteIcon).toHaveBeenCalledWith('https://second.example/a')
  })

  it('asks nothing for a site whose icon it has', () => {
    useSiteIconsStore.setState({ sites: { 'https://third.example': ICON } })
    requestSiteIcon('https://third.example/a')
    expect(loadSiteIcon).not.toHaveBeenCalled()
  })

  it('asks nothing for a site whose icon a link already loaded', () => {
    useSiteIconsStore.setState({ linked: { 'https://fifth.example': ICON } })
    requestSiteIcon('https://fifth.example/a')
    expect(loadSiteIcon).not.toHaveBeenCalled()
  })

  it('asks nothing for an address that is not a web one', () => {
    requestSiteIcon('mailto:a@b.c')
    requestSiteIcon('file:///etc/passwd')
    expect(loadSiteIcon).not.toHaveBeenCalled()
  })

  it('keeps a failed ask from reaching the window', async () => {
    loadSiteIcon.mockRejectedValueOnce(new Error('offline'))
    requestSiteIcon('https://fourth.example/a')
    await Promise.resolve()
    expect(loadSiteIcon).toHaveBeenCalledTimes(1)
  })
})
