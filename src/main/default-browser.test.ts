import { describe, expect, it } from 'vitest'
import { browserName, readDefaultBrowser, type BrowserSource } from './default-browser'

const PNG = 'data:image/png;base64,iVBORw0KGgo='

function source(
  info: (() => Promise<{ name: string; empty?: boolean; data?: string }>) | null,
  name = '',
): BrowserSource {
  return {
    getApplicationInfoForProtocol: async () => {
      if (!info) throw new Error('unsupported')
      const read = await info()
      return {
        name: read.name,
        icon: {
          isEmpty: () => read.empty ?? false,
          resize: () => ({ toDataURL: () => read.data ?? PNG }),
        },
      }
    },
    getApplicationNameForProtocol: () => name,
  }
}

describe('browserName', () => {
  it.each([
    ['Google Chrome', 'Google Chrome'],
    ['Safari.app', 'Safari'],
    ['firefox.exe', 'firefox'],
    ['google-chrome.desktop', 'Google Chrome'],
    ['org.mozilla.firefox.desktop', 'Firefox'],
    ['brave-browser.desktop', 'Brave Browser'],
    ['  Arc  ', 'Arc'],
  ])('reads %j as %j', (raw, name) => {
    expect(browserName(raw)).toBe(name)
  })

  it.each(['', '   ', '.desktop', '.app'])('has no name for %j', (raw) => {
    expect(browserName(raw)).toBeNull()
  })
})

describe('readDefaultBrowser', () => {
  it("takes the handler's name and icon", async () => {
    expect(await readDefaultBrowser(source(async () => ({ name: 'Google Chrome' })))).toEqual({
      name: 'Google Chrome',
      icon: PNG,
    })
  })

  it('leaves out an empty icon', async () => {
    const read = await readDefaultBrowser(source(async () => ({ name: 'Safari', empty: true })))
    expect(read).toEqual({ name: 'Safari', icon: null })
  })

  it('leaves out an icon that is not a PNG data URL', async () => {
    const read = await readDefaultBrowser(
      source(async () => ({ name: 'Safari', data: 'https://example.com/x.png' })),
    )
    expect(read).toEqual({ name: 'Safari', icon: null })
  })

  it('falls back to the name alone where the info is unsupported', async () => {
    expect(await readDefaultBrowser(source(null, 'firefox.desktop'))).toEqual({
      name: 'Firefox',
      icon: null,
    })
  })

  it('knows no browser when the system names none', async () => {
    expect(await readDefaultBrowser(source(null, ''))).toEqual({ name: null, icon: null })
  })
})
