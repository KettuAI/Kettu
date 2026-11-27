import { describe, expect, it } from 'vitest'
import { servedInProject } from './mcp-insight'

describe('servedInProject', () => {
  it('serves every project when unset, the listed ones for only, the others for except', () => {
    expect(servedInProject(undefined, '/a')).toBe(true)
    expect(servedInProject({ mode: 'only', paths: ['/a'] }, '/a')).toBe(true)
    expect(servedInProject({ mode: 'only', paths: ['/a'] }, '/b')).toBe(false)
    expect(servedInProject({ mode: 'only', paths: [] }, '/a')).toBe(false)
    expect(servedInProject({ mode: 'except', paths: ['/a'] }, '/a')).toBe(false)
    expect(servedInProject({ mode: 'except', paths: ['/a'] }, '/b')).toBe(true)
  })

  it('compares whole paths, so a folder inside a listed project is another project', () => {
    expect(servedInProject({ mode: 'only', paths: ['/work/app'] }, '/work/app-2')).toBe(false)
  })
})
