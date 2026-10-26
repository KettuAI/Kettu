import { describe, expect, it } from 'vitest'
import type { CatalogTheme } from '@shared/themes'
import { catalogView, matchingThemes } from './catalog-view'

const theme = (name: string, id = name.toLowerCase()): CatalogTheme => ({
  id,
  name,
  author: 'Someone',
  version: '1.0.0',
  license: 'MIT',
  preview: { light: {}, dark: {} },
  action: 'install',
})

const themes = [theme('Nord'), theme('Rosé Pine', 'rose-pine'), theme('Tokyo Night', 'tokyo-night')]

describe('matchingThemes', () => {
  it('finds a name by any part of it, whatever its case and accents', () => {
    expect(matchingThemes(themes, 'ROSE').map((t) => t.id)).toEqual(['rose-pine'])
    expect(matchingThemes(themes, ' night ').map((t) => t.id)).toEqual(['tokyo-night'])
    expect(matchingThemes(themes, '')).toEqual(themes)
  })
})

describe('catalogView', () => {
  it('loads, then lists the themes that match', () => {
    expect(catalogView(null, '')).toEqual({ kind: 'loading' })
    expect(catalogView({ status: 'ok', themes }, 'nord')).toEqual({
      kind: 'themes',
      themes: [themes[0]],
    })
  })

  it('says when nothing matches, and when the catalog lists nothing', () => {
    expect(catalogView({ status: 'ok', themes }, ' gruv ')).toEqual({
      kind: 'no-match',
      query: 'gruv',
    })
    expect(catalogView({ status: 'ok', themes: [] }, 'gruv')).toEqual({ kind: 'none' })
  })

  it('says why the catalog cannot be read', () => {
    for (const status of ['unreachable', 'invalid', 'newer-format'] as const) {
      expect(catalogView({ status }, '')).toEqual({ kind: 'failed', error: status })
    }
    expect(catalogView({ status: 'error', message: 'boom' }, '')).toEqual({
      kind: 'error',
      message: 'boom',
    })
  })
})
