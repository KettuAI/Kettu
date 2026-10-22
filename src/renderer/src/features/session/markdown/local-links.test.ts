import { describe, expect, it } from 'vitest'
import { localLinks, localTarget } from './local-links'

const link = (url: string) => ({ type: 'link', url, children: [] })

function run(url: string) {
  const node = link(url)
  localLinks()({ type: 'root', children: [{ type: 'paragraph', children: [node] }] })
  return node
}

describe('localLinks', () => {
  it('carries the target of a link to a local path in a fragment', () => {
    for (const url of ['src/long.ts', './src/a.ts', '../b.md', '/Users/me/x y.ts', 'C:\\x\\y.ts']) {
      const node = run(url)
      expect(node.url.startsWith('#local:')).toBe(true)
      // What the hardening lets through as a fragment: the URL's own hash is the same text.
      expect(new URL(node.url, 'http://example.com').hash).toBe(node.url)
      expect(localTarget(node.url)).toBe(url)
    }
  })

  it('leaves web links, fragments and other schemes alone', () => {
    for (const url of ['https://example.com', 'mailto:a@b.c', '#heading', '//cdn.example.com/x']) {
      expect(run(url)).toEqual(link(url))
      expect(localTarget(url)).toBeNull()
    }
  })
})
