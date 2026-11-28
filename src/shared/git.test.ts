import { describe, expect, it } from 'vitest'
import {
  githubReferenceFromLink,
  githubReferenceOf,
  githubShortReferenceLinks,
  githubTextReferences,
  inlineCodeSpans,
  qualifiedGitHubRefUrl,
  schemelessGitHubLinks,
  schemelessGitHubUrl,
} from './git'

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

describe('GitHub stacked pull request links (#2844)', () => {
  it('parses canonical and extended /stacks/<number> links', () => {
    expect(githubReferenceOf('https://github.com/KettuAI/Kettu/stacks/42')).toEqual({
      kind: 'stack',
      owner: 'KettuAI',
      repo: 'Kettu',
      number: 42,
      url: 'https://github.com/KettuAI/Kettu/stacks/42',
    })
    expect(
      githubReferenceFromLink('https://www.github.com/KettuAI/Kettu/stacks/042?tab=prs#top'),
    ).toEqual({
      kind: 'stack',
      owner: 'KettuAI',
      repo: 'Kettu',
      number: 42,
      url: 'https://github.com/KettuAI/Kettu/stacks/42',
    })
    expect(githubReferenceFromLink('https://github.com/KettuAI/Kettu/stacks/7/')).toEqual({
      kind: 'stack',
      owner: 'KettuAI',
      repo: 'Kettu',
      number: 7,
      url: 'https://github.com/KettuAI/Kettu/stacks/7',
    })
  })

  it('finds schemeless /stacks/<number> links and rejects malformed stack paths', () => {
    expect(
      urls(
        'Check github.com/KettuAI/Kettu/stacks/12 and www.github.com/o/r/stacks/9?foo=1, then merge.',
      ),
    ).toEqual([
      'https://github.com/KettuAI/Kettu/stacks/12',
      'https://www.github.com/o/r/stacks/9?foo=1',
    ])
    expect(urls('看一下github.com/o/r/stacks/8，里面有三个 PR')).toEqual([
      'https://github.com/o/r/stacks/8',
    ])
    expect(schemelessGitHubUrl('github.com/o/r/stacks/15')).toBe('https://github.com/o/r/stacks/15')

    for (const invalid of [
      'https://github.com/o/r/stacks/0',
      'https://github.com/o/r/stacks/new',
      'https://github.com/o/r/stacks/12abc',
      'https://github.com/o/r/stacks/',
      'https://github.com/o/r/stack/12',
      'http://github.com/o/r/stacks/12',
      'https://github.com:8443/o/r/stacks/12',
      'https://user@github.com/o/r/stacks/12',
      'https://github.example.com/o/r/stacks/12',
      'https://github.com/-bad/r/stacks/12',
      'https://github.com/o/../stacks/12',
    ]) {
      expect(githubReferenceFromLink(invalid), invalid).toBeNull()
      expect(githubReferenceOf(invalid), invalid).toBeNull()
    }

    for (const text of [
      'src/github.com/o/r/stacks/12',
      'gist.github.com/o/r/stacks/12',
      'github.com.evil.com/o/r/stacks/12',
      'me@github.com/o/r/stacks/12',
      'github.com/o/r/stacks/0',
      'github.com/o/r/stacks/new',
      'github.com/o/r/stacks/12abc',
      'github.com/o/r/stack/12',
    ]) {
      expect(schemelessGitHubLinks(text), text).toEqual([])
    }
  })
})

describe('inlineCodeSpans and GitHub short #123 references (#2600)', () => {
  const repo = { owner: 'KettuAI', repo: 'Kettu' }

  it('finds matching single- and multi-backtick inline code spans without matching stray backticks', () => {
    expect(inlineCodeSpans('Check `#123` and ``#456`` then #789')).toEqual([
      { from: 6, to: 12 },
      { from: 17, to: 25 },
    ])
    expect(inlineCodeSpans('it`s #123 and not closed')).toEqual([])
    expect(inlineCodeSpans('`first\n\n#123`')).toEqual([])
  })

  it('resolves #123 and owner/repo#456 only when linked to a GitHub repository', () => {
    const text = 'See #2600, other/proj#42, and 查看#123。'
    expect(githubShortReferenceLinks(text, null)).toEqual([])
    expect(githubShortReferenceLinks(text, repo)).toEqual([
      { from: 4, to: 9, url: 'https://github.com/KettuAI/Kettu/issues/2600' },
      { from: 11, to: 24, url: 'https://github.com/other/proj/issues/42' },
      { from: 32, to: 36, url: 'https://github.com/KettuAI/Kettu/issues/123' },
    ])
  })

  it('excludes inline code, line anchors, hex colors, zero numbers, and non-boundary tokens', () => {
    const text = [
      '`#123`',
      '``#456``',
      '#0',
      '#000',
      '#000000',
      '#L10',
      '#L10-L20',
      '#ff0000',
      '#fff',
      '#123abc',
      '#123-foo',
      'foo#123',
      'a.b#123',
      'a-b#123',
      '&#123;',
      '##123',
      'a/b/c#123',
      'user@owner/repo#123',
    ].join(' ')
    expect(githubShortReferenceLinks(text, repo)).toEqual([])
    expect(githubTextReferences(text, { skipInlineCode: true })).toEqual([])
  })

  it('parses a standalone owner/repo#123 string via qualifiedGitHubRefUrl', () => {
    expect(qualifiedGitHubRefUrl('KettuAI/Kettu#2600')).toBe(
      'https://github.com/KettuAI/Kettu/issues/2600',
    )
    expect(qualifiedGitHubRefUrl('#2600')).toBeNull()
    expect(qualifiedGitHubRefUrl('KettuAI/Kettu#0')).toBeNull()
    expect(qualifiedGitHubRefUrl('See KettuAI/Kettu#2600')).toBeNull()
  })
})
