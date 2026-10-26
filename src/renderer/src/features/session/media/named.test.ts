import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Streamdown, type ExtraProps } from 'streamdown'
import { describe, expect, it } from 'vitest'
import type { ToolEntry } from '@shared/thread'
import { remarkPlugins } from '@renderer/features/session/markdown/remark'
import { mediaReference, NamedMedia, namedMedia, toolMedia } from './named'

/** What `namedMedia` finds in each paragraph, list item and table Streamdown renders. */
function found(markdown: string): string[][] {
  const blocks: string[][] = []
  const collect =
    (tag: 'p' | 'li' | 'table') =>
    ({ node, children }: { children?: ReactNode } & ExtraProps) => {
      blocks.push(namedMedia(node))
      return createElement(tag, null, children)
    }
  renderToStaticMarkup(
    createElement(Streamdown, {
      mode: 'static',
      skipHtml: true,
      remarkPlugins,
      components: { p: collect('p'), li: collect('li'), table: collect('table') },
      children: markdown,
    }),
  )
  return blocks.filter((paths) => paths.length > 0)
}

describe('mediaReference', () => {
  it('takes paths that end in a media file', () => {
    for (const path of [
      'out/demo.mp4',
      './out/beep.mp3',
      'demo.webm',
      '/Users/me/Application Support/x/shot.png',
      '~/Desktop/clip.mov',
      'C:\\Users\\me\\a b.wav',
      'file:///tmp/a.flac',
    ]) {
      expect(mediaReference(path), path).toBe(path)
    }
  })

  it('leaves other text', () => {
    for (const text of [
      'src/app.ts',
      'ffmpeg -i in.mov out.mp4',
      'https://example.com/a.mp4',
      '//host/a.mp4',
      '#a.mp4',
      'a\nb.mp4',
      '',
    ]) {
      expect(mediaReference(text), text).toBeNull()
    }
  })
})

describe('namedMedia', () => {
  it('finds the files inline code and links name, in order and each once', () => {
    const markdown =
      'Rendered `out/demo.mp4` and [the sound](out/beep.mp3), see `out/demo.mp4` and `src/a.ts`.'
    expect(found(markdown)).toEqual([['out/demo.mp4', 'out/beep.mp3']])
  })

  it('leaves the files of a nested list or a code block to them', () => {
    expect(found('- `a.mp4`\n  - `b.mp4`\n- `c.mp3`')).toEqual([['a.mp4'], ['b.mp4'], ['c.mp3']])
    expect(found('```\nout/demo.mp4\n```')).toEqual([])
  })

  it('finds a table as one block', () => {
    expect(found('| clip | sound |\n| - | - |\n| `a.mp4` | `b.wav` |')).toEqual([
      ['a.mp4', 'b.wav'],
    ])
  })
})

describe('NamedMedia', () => {
  const order = ['first', 'second', 'third']
  const media = () => new NamedMedia<string>((a, b) => order.indexOf(a) < order.indexOf(b))

  it('shows a file under the first block that names it', () => {
    const named = media()
    const second = { at: 'second', paths: ['out/demo.mp4', 'b.mp3'] }
    const first = { at: 'first', paths: ['./out/demo.mp4'] }
    named.claim(second)
    expect(named.shown(second)).toEqual(['out/demo.mp4', 'b.mp3'])
    const unclaim = named.claim(first)
    expect(named.shown(first)).toEqual(['./out/demo.mp4'])
    expect(named.shown(second)).toEqual(['b.mp3'])
    unclaim()
    expect(named.shown(second)).toEqual(['out/demo.mp4', 'b.mp3'])
  })

  it('leaves out a file a Markdown image of the message shows', () => {
    const named = media()
    const block = { at: 'first', paths: ['out/demo.mp4'] }
    named.claim(block)
    const drop = named.image('out/demo.mp4')
    expect(named.shown(block)).toEqual([])
    drop()
    expect(named.shown(block)).toEqual(['out/demo.mp4'])
  })

  it('tells its listeners of each change', () => {
    const named = media()
    let calls = 0
    named.subscribe(() => calls++)
    const before = named.getVersion()
    named.claim({ at: 'first', paths: ['a.mp4'] })()
    expect(calls).toBe(2)
    expect(named.getVersion()).toBe(before + 2)
  })
})

describe('toolMedia', () => {
  const call = (changes: Partial<ToolEntry>): ToolEntry => ({
    kind: 'tool',
    id: 't1',
    title: 'Edit',
    toolKind: 'edit',
    status: 'completed',
    content: [],
    locations: [],
    permission: null,
    permissionResult: null,
    ...changes,
  })

  it('takes the media files of its diffs, then of its locations, each once', () => {
    const entry = call({
      content: [
        { type: 'diff', path: '/p/art/logo.svg', oldText: null, newText: '<svg/>' },
        { type: 'diff', path: '/p/src/app.ts', oldText: 'a', newText: 'b' },
      ],
      locations: [
        { path: '/p/out/clip.mp4' },
        { path: '/p/art/logo.svg', line: 1 },
        { path: '/p/notes.md', line: 3 },
        { path: '/p/Application Support/shot one.png' },
      ],
    })
    expect(toolMedia(entry)).toEqual([
      '/p/art/logo.svg',
      '/p/out/clip.mp4',
      '/p/Application Support/shot one.png',
    ])
  })

  it('reads no path from its command or its output', () => {
    const entry = call({
      toolKind: 'execute',
      rawInput: 'ffmpeg -i in.mov out/clip.mp4',
      content: [{ type: 'markdown', markdown: 'Saved `out/shot.png` and ![x](out/shot.png)' }],
    })
    expect(toolMedia(entry)).toEqual([])
  })

  it('shows none beside a picture of its own, nor for a deletion', () => {
    const picture = {
      type: 'ref' as const,
      ref: { kind: 'image' as const, mimeType: 'image/png', data: 'AAAA' },
    }
    expect(
      toolMedia(
        call({ toolKind: 'read', content: [picture], locations: [{ path: '/p/shot.png' }] }),
      ),
    ).toEqual([])
    expect(toolMedia(call({ toolKind: 'delete', locations: [{ path: '/p/old.png' }] }))).toEqual([])
  })
})
