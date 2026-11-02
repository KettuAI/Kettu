// Which of a Markdown table's columns hold numbers, so they line up on the right.

interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

// A count, an amount or a measure: an optional sign or currency, digits with separators, a
// fraction, and a short unit such as %, ms, KB or x.
const NUMBER = /^[+\-−±~≈]?\s?[$€£¥]?\d[\d,_\u2009 ]*(?:\.\d+)?\s?(?:%|[a-zA-Zµ]{1,3}|×)?$/

function textOf(node: HastNode): string {
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(textOf).join('')
}

function elements(node: HastNode | undefined, tag: string): HastNode[] {
  return (node?.children ?? []).filter((child) => child.tagName === tag)
}

function alignOf(cell: HastNode): unknown {
  const props = cell.properties ?? {}
  if (props.align) return props.align
  const style = typeof props.style === 'string' ? props.style : ''
  return /text-align\s*:/.test(style) ? style : null
}

/** How many body rows and columns the table has. */
export function tableSize(table: HastNode | undefined): { rows: number; columns: number } {
  const rows = elements(table, 'tbody').flatMap((body) => elements(body, 'tr'))
  const header = elements(table, 'thead').flatMap((head) => elements(head, 'tr'))[0]
  const columns = Math.max(
    elements(header, 'th').length,
    ...rows.map((row) => elements(row, 'td').length),
  )
  return { rows: rows.length, columns }
}

/**
 * The indexes of the columns whose body cells are all numbers, empty cells aside, leaving out a
 * column the Markdown aligns itself.
 */
export function numericColumns(table: HastNode | undefined): number[] {
  const rows = elements(table, 'tbody').flatMap((body) => elements(body, 'tr'))
  const width = tableSize(table).columns
  const numeric: number[] = []
  for (let column = 0; column < width; column++) {
    const cells = rows.map((row) => elements(row, 'td')[column]).filter(Boolean)
    if (cells.some((cell) => alignOf(cell))) continue
    const values = cells.map((cell) => textOf(cell).trim()).filter((value) => value !== '')
    if (values.length > 0 && values.every((value) => NUMBER.test(value))) numeric.push(column)
  }
  return numeric
}
