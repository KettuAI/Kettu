import { describe, expect, it } from 'vitest'
import { isBranchName, sameFolder } from './switcher-model'

describe('isBranchName', () => {
  it('takes the names git takes', () => {
    for (const name of ['main', 'fix/usage-day-key', 'feat/123-a.b', 'v1.2', 'a@b']) {
      expect(isBranchName(name), name).toBe(true)
    }
  })

  it('refuses names git refuses or that read as an option', () => {
    for (const name of [
      '',
      '@',
      '-f',
      '/a',
      'a/',
      'a.',
      'a.lock',
      'a..b',
      'a@{1}',
      'a//b',
      'a b',
      'a~1',
      'a^',
      'a:b',
      'a?',
      'a*',
      'a[b',
      'a\\b',
      '.hidden',
      'feat/.x',
      'tab\there',
    ]) {
      expect(isBranchName(name), name).toBe(false)
    }
  })
})

describe('sameFolder', () => {
  it('ignores a trailing slash', () => {
    expect(sameFolder('/Users/me/repo/', '/Users/me/repo')).toBe(true)
  })

  it('tells folders apart by case on macOS and Linux paths', () => {
    expect(sameFolder('/Users/me/Repo', '/Users/me/repo')).toBe(false)
  })

  it('ignores case and slash direction on Windows paths', () => {
    expect(sameFolder('C:\\Code\\Repo', 'c:/code/repo')).toBe(true)
  })

  it('tells a folder from another inside it', () => {
    expect(sameFolder('/a/repo', '/a/repo/sub')).toBe(false)
  })
})
