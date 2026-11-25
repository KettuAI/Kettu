import { describe, expect, it } from 'vitest'
import { githubReferenceFromLink, schemelessGitHubLinks, schemelessGitHubUrl } from './git'

const urls = (text: string) => schemelessGitHubLinks(text).map((link) => link.url)

describe('schemelessGitHubLinks', () => {
  it('finds issue and pull request links written without https://', () => {
    const text = 'See github.com/KettuAI/Kettu/issues/123 and github.com/KettuAI/Kettu/pull/45.'
    expect(schemelessGitHubLinks(text)).toEqual([
      { from: 4, to: 39, url: 'https://github.com/KettuAI/Kettu/issues/123' },
      { from: 44, to: 76, url: 'https://github.com/KettuAI/Kettu/pull/45' },
    ])
  })

  it('keeps www. and the part of the pull request or issue a link points into', () => {
    expect(
      urls('www.github.com/o/r/pull/45/files and github.com/o/r/issues/1#issuecomment-9'),
    ).toEqual([
      'https://www.github.com/o/r/pull/45/files',
      'https://github.com/o/r/issues/1#issuecomment-9',
    ])
  })

  it('leaves out the punctuation and brackets of the sentence around a link', () => {
    expect(
      urls('(github.com/o/r/pull/7), github.com/o/r/issues/8? github.com/o/r/pull/9/files.'),
    ).toEqual([
      'https://github.com/o/r/pull/7',
      'https://github.com/o/r/issues/8',
      'https://github.com/o/r/pull/9/files',
    ])
  })

  it('finds a link next to Chinese text and inside a Markdown link target', () => {
    expect(urls('看一下github.com/o/r/issues/3，然后合并')).toEqual([
      'https://github.com/o/r/issues/3',
    ])
    expect(urls('[the fix](github.com/o/r/pull/4)')).toEqual(['https://github.com/o/r/pull/4'])
  })

  it('finds nothing in paths, other hosts, emails or other links', () => {
    for (const text of [
      'src/github.com/o/r/issues/1',
      'gist.github.com/o/r/issues/1',
      'github.com.evil.com/o/r/issues/1',
      'evilgithub.com/o/r/issues/1',
      'me@github.com/o/r/issues/1',
      'https://github.com/o/r/issues/1',
      'http://github.com/o/r/pull/1',
      'https://example.com/?next=github.com/o/r/pull/1',
      'github.com/o/r/issues/12abc',
      'github.com/o/r/issues/',
      'github.com/o/r/commits/1',
      'github.com/o/r/issues/0',
    ]) {
      expect(schemelessGitHubLinks(text), text).toEqual([])
    }
  })
})

describe('schemelessGitHubUrl', () => {
  it('gives the full link for text that is all one link', () => {
    expect(schemelessGitHubUrl('github.com/o/r/issues/123')).toBe(
      'https://github.com/o/r/issues/123',
    )
    expect(schemelessGitHubUrl('www.github.com/o/r/pull/45')).toBe(
      'https://www.github.com/o/r/pull/45',
    )
  })

  it('gives null for anything else', () => {
    expect(schemelessGitHubUrl('docs/github.com/o/r/issues/1')).toBeNull()
    expect(schemelessGitHubUrl('github.com/o/r/issues/1 and more')).toBeNull()
    expect(schemelessGitHubUrl('github.com/o/r')).toBeNull()
    expect(schemelessGitHubUrl('./notes.md')).toBeNull()
  })

  it('names the same reference as the full link', () => {
    const url = schemelessGitHubUrl('www.github.com/KettuAI/Kettu/pull/45/files')
    expect(url && githubReferenceFromLink(url)).toEqual(
      githubReferenceFromLink('https://github.com/KettuAI/Kettu/pull/45'),
    )
  })
})
