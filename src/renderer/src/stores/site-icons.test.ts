import { describe, expect, it } from 'vitest'
import { iconFor } from './site-icons'

const ICON = 'data:image/png;base64,AA=='

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
