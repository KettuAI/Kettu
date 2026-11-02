import { describe, expect, it } from 'vitest'
import { afterRemoval, allowedByOrigin } from './allowed-sites'

describe('allowedByOrigin', () => {
  it('lists each site once, in the order first allowed, with every project that allows it', () => {
    expect(
      allowedByOrigin([
        { projectPath: '/a', origins: ['http://localhost:3000', 'https://example.com'] },
        { projectPath: '/b', origins: ['https://example.com', 'https://docs.example.org'] },
      ]),
    ).toEqual([
      { origin: 'http://localhost:3000', projects: ['/a'], removing: false },
      { origin: 'https://example.com', projects: ['/a', '/b'], removing: false },
      { origin: 'https://docs.example.org', projects: ['/b'], removing: false },
    ])
  })

  it('is empty when no project allows a site', () => {
    expect(allowedByOrigin([])).toEqual([])
    expect(allowedByOrigin([{ projectPath: '/a', origins: [] }])).toEqual([])
  })

  it('marks each site being removed, however many are', () => {
    const list = [
      { projectPath: '/a', origins: ['https://a.dev', 'https://b.dev', 'https://c.dev'] },
    ]
    expect(
      allowedByOrigin(list, new Set(['https://a.dev', 'https://c.dev'])).map((s) => s.removing),
    ).toEqual([true, false, true])
  })
})

describe('afterRemoval', () => {
  const list = [
    { projectPath: '/a', origins: ['https://example.com', 'http://localhost:3000'] },
    { projectPath: '/b', origins: ['https://example.com'] },
    { projectPath: '/c', origins: ['https://docs.example.org'] },
  ]
  const done: PromiseSettledResult<void> = { status: 'fulfilled', value: undefined }
  const failed: PromiseSettledResult<void> = { status: 'rejected', reason: new Error('EACCES') }

  it('takes the site from the projects whose removal went through, and keeps it where it failed', () => {
    const after = afterRemoval(list, 'https://example.com', ['/a', '/b'], [done, failed])
    expect(after).toEqual([
      { projectPath: '/a', origins: ['http://localhost:3000'] },
      { projectPath: '/b', origins: ['https://example.com'] },
      { projectPath: '/c', origins: ['https://docs.example.org'] },
    ])
    expect(allowedByOrigin(after)).toContainEqual({
      origin: 'https://example.com',
      projects: ['/b'],
      removing: false,
    })
  })

  it('drops a project left with no site once every removal went through', () => {
    expect(afterRemoval(list, 'https://example.com', ['/a', '/b'], [done, done])).toEqual([
      { projectPath: '/a', origins: ['http://localhost:3000'] },
      { projectPath: '/c', origins: ['https://docs.example.org'] },
    ])
  })

  it('changes nothing when every removal failed', () => {
    expect(afterRemoval(list, 'https://example.com', ['/a', '/b'], [failed, failed])).toEqual(list)
  })

  it('leaves the projects it did not remove the site from as they are', () => {
    const allowedAgain = [...list, { projectPath: '/d', origins: ['https://example.com'] }]
    expect(afterRemoval(allowedAgain, 'https://example.com', ['/a', '/b'], [done, done])).toEqual([
      { projectPath: '/a', origins: ['http://localhost:3000'] },
      { projectPath: '/c', origins: ['https://docs.example.org'] },
      { projectPath: '/d', origins: ['https://example.com'] },
    ])
  })
})
