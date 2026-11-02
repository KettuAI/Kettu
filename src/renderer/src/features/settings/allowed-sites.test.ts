import { describe, expect, it } from 'vitest'
import { allowedByOrigin } from './allowed-sites'

describe('allowedByOrigin', () => {
  it('lists each site once, in the order first allowed, with every project that allows it', () => {
    expect(
      allowedByOrigin([
        { projectPath: '/a', origins: ['http://localhost:3000', 'https://example.com'] },
        { projectPath: '/b', origins: ['https://example.com', 'https://docs.example.org'] },
      ]),
    ).toEqual([
      { origin: 'http://localhost:3000', projects: ['/a'] },
      { origin: 'https://example.com', projects: ['/a', '/b'] },
      { origin: 'https://docs.example.org', projects: ['/b'] },
    ])
  })

  it('is empty when no project allows a site', () => {
    expect(allowedByOrigin([])).toEqual([])
    expect(allowedByOrigin([{ projectPath: '/a', origins: [] }])).toEqual([])
  })
})
