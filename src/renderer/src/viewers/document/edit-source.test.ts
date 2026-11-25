import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { editedSource, mapSource } from './edit-source'

interface FakeText {
  data: string
  parentElement: { closest(selector: string): unknown }
}

/** A rendered block as the text nodes it holds, each plain or inside code. */
function block(...parts: (string | { code: string })[]): { root: Element; nodes: FakeText[] } {
  const nodes = parts.map((part) => ({
    data: typeof part === 'string' ? part : part.code,
    parentElement: { closest: () => (typeof part === 'string' ? null : {}) },
  }))
  return { root: { nodes } as unknown as Element, nodes }
}

beforeEach(() => {
  vi.stubGlobal('NodeFilter', { SHOW_TEXT: 4 })
  vi.stubGlobal('document', {
    createTreeWalker: (root: { nodes: FakeText[] }) => {
      let next = 0
      return { nextNode: () => root.nodes[next++] ?? null }
    },
  })
})

afterEach(() => vi.unstubAllGlobals())

/** The source after `type` changed the rendered nodes. */
function edit(
  source: string,
  parts: (string | { code: string })[],
  type: (nodes: FakeText[]) => void,
  codeBlock = false,
): string | null {
  const { root, nodes } = block(...parts)
  const map = mapSource(root, source, codeBlock)
  type(nodes)
  return editedSource(root, map)
}

describe('typing into a block with links', () => {
  it('writes after a link that ends the paragraph, not into its address', () => {
    const source = 'See [site](https://example.com).'
    expect(edit(source, ['See ', 'site', '.'], (nodes) => (nodes[2]!.data = ', twice.'))).toBe(
      'See [site](https://example.com), twice.',
    )
  })

  it('finds the words after a link when its address holds them too', () => {
    const source = 'Read [the docs](https://docs.example.com/docs) docs first.'
    expect(
      edit(source, ['Read ', 'the docs', ' docs first.'], (nodes) => {
        nodes[2]!.data = ' docs twice.'
      }),
    ).toBe('Read [the docs](https://docs.example.com/docs) docs twice.')
    expect(
      edit('[a](http://x.io/com)com', ['a', 'com'], (nodes) => (nodes[1]!.data = 'come')),
    ).toBe('[a](http://x.io/com)come')
  })

  it('keeps a title and brackets in an address out of reach', () => {
    const source = 'Go [here](<a b.html> "The end.") (b). The end.'
    expect(
      edit(source, ['Go ', 'here', ' (b). The end.'], (nodes) => {
        nodes[2]!.data = ' (b). The start.'
      }),
    ).toBe('Go [here](<a b.html> "The end.") (b). The start.')
    expect(
      edit('[w](https://e.org/a_(b).c).c', ['w', '.c'], (nodes) => (nodes[1]!.data = '.d')),
    ).toBe('[w](https://e.org/a_(b).c).d')
  })

  it('tells two links with the same words apart', () => {
    const source = '[here](https://a.com/here) and [here](https://b.com/here).'
    expect(
      edit(source, ['here', ' and ', 'here', '.'], (nodes) => (nodes[2]!.data = 'there')),
    ).toBe('[here](https://a.com/here) and [there](https://b.com/here).')
  })

  it("changes a link's words where an earlier word repeats them", () => {
    const source = 'The guide: [guide](https://example.com/guide).'
    expect(
      edit(source, ['The guide: ', 'guide', '.'], (nodes) => (nodes[1]!.data = 'guides')),
    ).toBe('The guide: [guides](https://example.com/guide).')
  })

  it('skips an image, whose words are not shown', () => {
    const source = 'Logo ![big logo](logo.png "logo") logo.'
    expect(edit(source, ['Logo ', ' logo.'], (nodes) => (nodes[1]!.data = ' logos.'))).toBe(
      'Logo ![big logo](logo.png "logo") logos.',
    )
    const linked = '[![a.b](i.png)](https://e.com/x.y).'
    expect(edit(linked, ['.'], (nodes) => (nodes[0]!.data = '!'))).toBe(
      '[![a.b](i.png)](https://e.com/x.y)!',
    )
  })

  it('skips the label of a reference link', () => {
    const source = 'Go [site][x.y].y'
    expect(edit(source, ['Go ', 'site', '.y'], (nodes) => (nodes[2]!.data = '.z'))).toBe(
      'Go [site][x.y].z',
    )
  })

  it('still finds code and emphasis beside repeated words', () => {
    const source = 'Run `a.b` then *a.b* and a.b.'
    expect(
      edit(source, ['Run ', { code: 'a.b' }, ' then ', 'a.b', ' and a.b.'], (nodes) => {
        nodes[3]!.data = 'a.c'
      }),
    ).toBe('Run `a.b` then *a.c* and a.b.')
    // What looks like a link inside code is words.
    const code = 'Type `[x](y.z)` here.z'
    expect(
      edit(code, ['Type ', { code: '[x](y.z)' }, ' here.z'], (nodes) => {
        nodes[1]!.data = '[x](y.zz)'
      }),
    ).toBe('Type `[x](y.zz)` here.z')
  })

  it('keeps brackets written as words editable', () => {
    expect(
      edit('As shown in [1][2].', ['As shown in [1][2].'], (nodes) => {
        nodes[0]!.data = 'As seen in [1][2].'
      }),
    ).toBe('As seen in [1][2].')
    expect(
      edit('Use arr[i][j] here.', ['Use arr[i][j] here.'], (nodes) => {
        nodes[0]!.data = 'Use arr[i][j] there.'
      }),
    ).toBe('Use arr[i][j] there.')
    expect(edit('a](b) c', ['a](b) c'], (nodes) => (nodes[0]!.data = 'a](b) d'))).toBe('a](b) d')
  })
})

describe('typing into a list item, heading or quote', () => {
  it('changes words that repeat their mark, not the mark', () => {
    expect(edit('- **-** x', ['-', ' x'], (nodes) => (nodes[0]!.data = '+'))).toBe('- **+** x')
    expect(edit('1. **1.** done', ['1.', ' done'], (nodes) => (nodes[0]!.data = '2.'))).toBe(
      '1. **2.** done',
    )
    expect(edit('# **#** tag', ['#', ' tag'], (nodes) => (nodes[0]!.data = '#1'))).toBe(
      '# **#1** tag',
    )
    expect(
      edit('> - [ ] **[ ]** a\n> - **>** b', ['[ ]', ' a', '\n', '>', ' b'], (nodes) => {
        nodes[3]!.data = '<'
      }),
    ).toBe('> - [ ] **[ ]** a\n> - **\\<** b')
  })

  it("changes a later item's words", () => {
    expect(edit('- one\n- two', ['one', '\n', 'two'], (nodes) => (nodes[2]!.data = 'three'))).toBe(
      '- one\n- three',
    )
  })

  it('keeps what reads as a mark in a code block as words', () => {
    expect(edit('- code', [{ code: '- code' }], (nodes) => (nodes[0]!.data = '+ code'), true)).toBe(
      '+ code',
    )
  })
})
