import { describe, expect, it } from 'vitest'
import {
  anchorBlocks,
  blockTag,
  blockWords,
  findDocumentAnchor,
  plainWords,
} from './artifact-document-anchors'

const doc = [
  '# Streak bug',
  '',
  'Between Nov 3 and Nov 12, **1,284 people** lost a [streak](https://example.com).',
  '',
  '- 41 tickets',
  '- No data lost',
  '',
  '| Case | Before |',
  '| --- | --- |',
  '| Midnight | Reset |',
  '',
  '```js',
  'const a = 1',
  '```',
  '',
  'The fix ships on Nov 15.',
  '',
].join('\n')

const anchorAt = (markdown: string, index: number) => {
  const block = anchorBlocks(markdown)[index]!
  return {
    offset: block.from,
    tag: blockTag(block.kind),
    text: blockWords(markdown.slice(block.from, block.to)),
  }
}

describe("a document's anchors", () => {
  it('name each block by its element and its words without Markdown marks', () => {
    const blocks = anchorBlocks(doc)
    expect(blocks.map((b) => blockTag(b.kind))).toEqual(['h1', 'p', 'ul', 'table', 'pre', 'p'])
    expect(blocks.map((b) => blockWords(doc.slice(b.from, b.to)))).toEqual([
      'Streak bug',
      'Between Nov 3 and Nov 12, 1,284 people lost a streak.',
      '41 tickets No data lost',
      'Case Before Midnight Reset',
      'const a = 1',
      'The fix ships on Nov 15.',
    ])
  })

  it('keep words to one line of at most 120 characters', () => {
    const words = blockWords(`${'word '.repeat(60)}\nnext line`)
    expect(Array.from(words).length).toBeLessThanOrEqual(120)
    expect(words).not.toContain('\n')
  })

  it('drop marks without cutting the words or a name with underscores', () => {
    const long = `**Bold** ${'word '.repeat(40)}and \`snake_case\` _end_.`
    expect(plainWords(long)).toBe(`Bold ${'word '.repeat(40)}and snake_case end.`)
  })

  it('find their block again after the text before it moved', () => {
    const anchor = anchorAt(doc, 5)
    const later = `Intro added above.\n\n${doc}`
    expect(findDocumentAnchor(later, anchor)).toBe(later.indexOf('The fix ships'))
  })

  it('find a block whose words changed after its start', () => {
    const anchor = anchorAt(doc, 1)
    const later = doc.replace('lost a [streak](https://example.com)', 'lost their streaks')
    expect(findDocumentAnchor(later, anchor)).toBe(later.indexOf('Between'))
  })

  it('find a block whose first words changed while most stayed', () => {
    const anchor = anchorAt(doc, 1)
    const later = doc.replace('Between Nov 3 and Nov 12,', 'From Nov 3 to Nov 12,')
    expect(findDocumentAnchor(later, anchor)).toBe(later.indexOf('From Nov 3'))
    const rewritten = doc.replace(/Between.*\)\./, 'Nobody lost anything this time.')
    expect(findDocumentAnchor(rewritten, anchor)).toBeNull()
  })

  it('take the nearest of two alike blocks', () => {
    const twice = `${doc}\nThe fix ships on Nov 15.\n`
    const anchor = anchorAt(twice, 6)
    expect(findDocumentAnchor(twice, anchor)).toBe(twice.lastIndexOf('The fix ships'))
  })

  it('find nothing once the block or its element is gone', () => {
    const anchor = anchorAt(doc, 5)
    expect(findDocumentAnchor(doc.replace('The fix ships on Nov 15.', ''), anchor)).toBeNull()
    expect(findDocumentAnchor(doc, { ...anchor, tag: 'ul' })).toBeNull()
  })

  it('keep a block without words only while one of its element stays at its place', () => {
    const rule = 'One.\n\n---\n\nTwo.\n'
    const anchor = { offset: rule.indexOf('---'), tag: 'hr', text: '' }
    expect(findDocumentAnchor(rule, anchor)).toBe(anchor.offset)
    expect(findDocumentAnchor(`Moved.\n\n${rule}`, anchor)).toBeNull()
  })
})
