import { createElement, type ComponentProps, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Streamdown, type Components, type ExtraProps } from 'streamdown'
import { describe, expect, it } from 'vitest'
import type { Attachment, ThreadEntry, ThreadState, ToolEntry } from '@shared/thread'
import type { DraftAttachment } from '@renderer/stores/attachments'
import { localImageTarget, spacedImages } from '../markdown/local-images'
import { remarkPlugins } from '../markdown/remark'
import { NamedMedia, namedMedia, sameFile } from './named'
import { draftItems, markdownFiles, threadItems } from './viewer-items'

/**
 * The files the thread's renderer shows for a message, in order and each once: its Markdown
 * images where they are, and under each paragraph, list item and table what `NamedMedia` gives it.
 */
function rendered(markdown: string): string[] {
  const events: ({ image: string } | { claim: { at: number; paths: string[] } })[] = []
  const named = new NamedMedia<number>((a, b) => a < b)
  const block =
    (tag: 'p' | 'li' | 'table') =>
    ({ node, children }: { children?: ReactNode } & ExtraProps) => {
      const paths = namedMedia(node)
      // Rendered after the block's own content, as the media under a block is.
      const Under = () => {
        const claim = { at: events.length, paths }
        events.push({ claim })
        named.claim(claim)
        return null
      }
      return createElement(tag, null, children, createElement(Under))
    }
  const img = ({ src }: ComponentProps<'img'> & ExtraProps) => {
    const local = typeof src === 'string' ? localImageTarget(src) : null
    if (local !== null) {
      events.push({ image: local })
      named.image(local)
    }
    return null
  }
  const components: Components = { p: block('p'), li: block('li'), table: block('table'), img }
  renderToStaticMarkup(
    createElement(Streamdown, {
      mode: 'streaming',
      parseIncompleteMarkdown: false,
      skipHtml: true,
      remarkPlugins,
      components,
      children: spacedImages(markdown),
    }),
  )
  const files: string[] = []
  const show = (path: string) => {
    if (!files.some((file) => sameFile(file) === sameFile(path))) files.push(path)
  }
  for (const event of events) {
    if ('image' in event) show(event.image)
    else named.shown(event.claim).forEach(show)
  }
  return files
}

const MESSAGES = [
  'A shot ![one](/tmp/a.png) and `out/b.png`, then ![two](c.png).',
  'See `clip.mp4` and [the chart](./chart.png).\n\nAgain `clip.mp4` and ![](chart.png)',
  '- first `a.png`\n  - nested `b.png`\n- second ![c](c.png) `d.png`',
  '- loose `a.png`\n\n  - nested `b.png`\n\n- second `c.png`',
  '- one `a.png`\n\n  more `b.png`\n- two `c.png`',
  '1. one\n2. two `x.webm`\n\n| a | b |\n| - | - |\n| `t.png` | ![u](u.png) [v](v.mov) |',
  '> quoted `q.png`\n>\n> - in a list `l.png`\n\n# Heading `h.png` ![hi](hi.png)',
  '```\n![no](no.png) `no.png`\n```\n\n    ![indented](i.png)\n\nafter `ok.png`',
  '![spaced](/Users/me/Application Support/shot one.png) and ![win](C:\\Users\\me\\a b.png)',
  '![remote](https://example.com/a.png) ![data](data:image/png;base64,AAAA) ![file](file:///tmp/f.png)',
  '`ffmpeg -i a.mp4 out.mp4` and `~/Desktop/clip.mov` and [`code.png`](code.png) and [x](#a.png)',
  '- [ ] task `task.png`\n- [x] done ![d](d.png)',
  'Escaped ![a](a\\_b.png) and an entity ![e](e&amp;f.png) and `./a_b.png`',
  'Sound ![s](beep.mp3) and `song.wav` and `./out/x.png` then `out/x.png`',
  '- tight `a.png`\n  ## heading `h.png`\n- next',
  'No media here, `src/app.ts` and [a link](https://example.com/x.png).',
]

describe('markdownFiles', () => {
  it.each(MESSAGES)('shows what the thread renders, in its order: %s', (markdown) => {
    expect(markdownFiles(markdown).map((file) => file.path)).toEqual(rendered(markdown))
  })

  it('keeps an image alt text', () => {
    expect(markdownFiles('![a *b* \\[c\\]](x.png)')).toEqual([{ path: 'x.png', alt: 'a *b* [c]' }])
  })
})

const attachment = (id: string, type: Attachment['type'] = 'image'): Attachment => ({
  id,
  type,
  name: `${type} ${id}`,
  uri: null,
  mimeType: type === 'image' ? 'image/png' : 'text/plain',
  size: 10,
  sent: 'image',
  thumb: null,
  blob: 'hash',
})

const picture = { kind: 'image' as const, mimeType: 'image/png', data: 'AAAA' }

function tool(id: string, content: ToolEntry['content']): ToolEntry {
  return {
    kind: 'tool',
    id,
    title: id,
    toolKind: 'execute',
    status: 'completed',
    content,
    locations: [],
    permission: null,
    permissionResult: null,
  }
}

function state(entries: ThreadEntry[]): ThreadState {
  return {
    session: { id: 's1' } as ThreadState['session'],
    order: entries.map((entry) => entry.id),
    byId: Object.fromEntries(entries.map((entry) => [entry.id, entry])),
  }
}

describe('threadItems', () => {
  it('holds the images and videos in thread order, attachments and folded runs included', () => {
    const thread = state([
      {
        kind: 'user',
        id: 'u1',
        content: [
          { type: 'text', text: 'Look at these' },
          { type: 'ref', ref: { kind: 'attachment', attachment: attachment('a1') } },
          { type: 'ref', ref: { kind: 'link', uri: 'file:///x.txt', name: 'x.txt' } },
          { type: 'ref', ref: picture },
          { type: 'ref', ref: { kind: 'attachment', attachment: attachment('a2', 'file') } },
          { type: 'ref', ref: { kind: 'attachment', attachment: attachment('a3') } },
        ],
      },
      { kind: 'thought', id: 'h1', markdown: 'Checking ![t](shots/thought.png)', streaming: false },
      tool('t1', [
        { type: 'markdown', markdown: 'took a screenshot' },
        { type: 'ref', ref: picture },
      ]),
      tool('t2', [{ type: 'ref', ref: { kind: 'unsupported', label: 'Audio' } }]),
      {
        kind: 'agent',
        id: 'a1',
        markdown:
          'Here: ![shot](out/shot.png), the clip `out/demo.mp4` and the sound `out/beep.wav`.',
        attachments: [{ kind: 'link', uri: 'file:///y', name: 'y' }, picture],
        streaming: false,
      },
      { kind: 'turn_end', id: 'e1', stopReason: 'end_turn' } as ThreadEntry,
    ])
    expect(threadItems(thread).map((item) => [item.key, item.name])).toEqual([
      ['u1:attachment:a1', 'image a1'],
      ['u1:attachment:a3', 'image a3'],
      ['u1:ref:1', null],
      ['h1:file:shots/thought.png', 'thought.png'],
      ['t1:ref:1', null],
      ['a1:file:out/shot.png', 'shot.png'],
      ['a1:file:out/demo.mp4', 'demo.mp4'],
      ['a1:ref:1', null],
    ])
  })

  it("takes the files a tool call's diffs and locations name, after its pictures", () => {
    const thread = state([
      {
        ...tool('t1', [
          { type: 'markdown', markdown: 'Wrote `out/x.png` and ![y](out/y.png)' },
          { type: 'diff', path: 'art/logo.svg', oldText: '<svg/>', newText: '<svg></svg>' },
        ]),
        toolKind: 'edit',
        locations: [{ path: './art/logo.svg' }, { path: 'out/clip.mp4' }, { path: 'out/beep.mp3' }],
      },
    ])
    expect(threadItems(thread).map((item) => [item.key, item.name])).toEqual([
      ['t1:file:art/logo.svg', 'logo.svg'],
      ['t1:file:out/clip.mp4', 'clip.mp4'],
    ])
  })

  it('takes the clips the thread carries, by their names, and leaves its sounds out', () => {
    const clip = {
      kind: 'video' as const,
      mimeType: 'video/mp4',
      data: 'AAAA',
      size: 3,
      name: 'demo.mp4',
    }
    const sound = {
      kind: 'audio' as const,
      mimeType: 'audio/wav',
      data: 'AAAA',
      size: 3,
      name: null,
    }
    const thread = state([
      tool('t1', [
        { type: 'ref', ref: sound },
        { type: 'ref', ref: clip },
      ]),
      {
        kind: 'agent',
        id: 'a1',
        markdown: 'Here',
        attachments: [{ ...clip, name: null }],
        streaming: false,
      },
    ])
    const bytes = { kind: 'bytes', media: 'video', mimeType: 'video/mp4', data: 'AAAA' }
    expect(threadItems(thread).map((item) => [item.key, item.name, item.source])).toEqual([
      ['t1:ref:1', 'demo.mp4', bytes],
      ['a1:ref:0', null, bytes],
    ])
  })

  it('counts a forwarded message by all its refs, attachments shown as chips', () => {
    const thread = state([
      {
        kind: 'session_message',
        id: 'm1',
        senderId: null,
        content: [
          { type: 'ref', ref: { kind: 'attachment', attachment: attachment('a1') } },
          { type: 'ref', ref: picture },
        ],
      },
    ])
    expect(threadItems(thread).map((item) => item.key)).toEqual(['m1:ref:1'])
  })
})

describe('draftItems', () => {
  const draft = (key: string, kind: DraftAttachment['kind'], status: DraftAttachment['status']) =>
    ({
      key,
      name: key,
      kind,
      status,
      attachment: status === 'ready' ? attachment(key, kind) : null,
    }) as DraftAttachment

  it('holds the images added to the draft, in the order of its tiles', () => {
    const items = draftItems('s1', [
      draft('k1', 'image', 'ready'),
      draft('k2', 'image', 'adding'),
      draft('k3', 'text', 'ready'),
      draft('k4', 'image', 'ready'),
    ])
    expect(items.map((item) => item.key)).toEqual(['draft:s1:k1', 'draft:s1:k4'])
  })
})
