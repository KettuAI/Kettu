import { describe, expect, it } from 'vitest'
import { numericColumns, tableSize } from './table-columns'

type Cell = string | { text: string; align?: string }

function cell(tag: 'th' | 'td', value: Cell) {
  const text = typeof value === 'string' ? value : value.text
  const properties = typeof value === 'string' || !value.align ? {} : { align: value.align }
  return { type: 'element', tagName: tag, properties, children: [{ type: 'text', value: text }] }
}

function table(head: string[], rows: Cell[][]) {
  return {
    type: 'element',
    tagName: 'table',
    children: [
      {
        type: 'element',
        tagName: 'thead',
        children: [{ type: 'element', tagName: 'tr', children: head.map((h) => cell('th', h)) }],
      },
      {
        type: 'element',
        tagName: 'tbody',
        children: rows.map((row) => ({
          type: 'element',
          tagName: 'tr',
          children: row.map((value) => cell('td', value)),
        })),
      },
    ],
  }
}

describe('numericColumns', () => {
  it('finds columns of counts and signed changes', () => {
    const t = table(
      ['Function', 'File', 'Added', 'Removed', 'Status'],
      [
        ['dayKey', 'src/usage/usage-store.ts', '+12', '−4', 'Fixed'],
        ['weekKey', 'src/usage/usage-store.ts', '+6', '−2', 'Fixed'],
        ['day-key.test', 'src/usage/day-key.test.ts', '+34', '−0', 'New'],
      ],
    )
    expect(numericColumns(t)).toEqual([2, 3])
  })

  it('takes amounts, percentages and measures, and skips empty cells', () => {
    const t = table(
      ['Cost', 'Cache', 'Time', 'Size'],
      [
        ['$3.50', '98.1%', '41ms', '2.1 KB'],
        ['$1,140', '', '1.4s', '6 MB'],
      ],
    )
    expect(numericColumns(t)).toEqual([0, 1, 2, 3])
  })

  it('leaves a column with any text alone', () => {
    const t = table(['Version'], [['1.2'], ['next']])
    expect(numericColumns(t)).toEqual([])
  })

  it('leaves a column the Markdown aligns itself', () => {
    const t = table(['Count'], [[{ text: '4', align: 'center' }], [{ text: '5', align: 'center' }]])
    expect(numericColumns(t)).toEqual([])
  })

  it('needs a number somewhere in the column', () => {
    expect(numericColumns(table(['A'], [[''], ['']]))).toEqual([])
    expect(numericColumns(undefined)).toEqual([])
  })
})

describe('tableSize', () => {
  it('counts body rows and columns', () => {
    expect(
      tableSize(
        table(
          ['A', 'B', 'C'],
          [
            ['1', '2', '3'],
            ['4', '5', '6'],
          ],
        ),
      ),
    ).toEqual({
      rows: 2,
      columns: 3,
    })
    expect(tableSize(undefined)).toEqual({ rows: 0, columns: 0 })
  })
})
