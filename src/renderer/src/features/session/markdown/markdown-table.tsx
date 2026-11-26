import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { Download01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import {
  extractTableDataFromElement,
  tableDataToCSV,
  tableDataToMarkdown,
  type ExtraProps,
} from 'streamdown'
import { BlockAction, BlockCopy } from './block-frame'
import { downloadText } from './download'
import { numericColumns, proseColumns, tableSize } from './table-columns'

type Overflow = { left: boolean; right: boolean }

const tableMeasures = new Map<Element, () => void>()
let sharedTableObserver: ResizeObserver | null = null

function observeTable(targets: Element[], onResize: () => void): () => void {
  sharedTableObserver ??= new ResizeObserver((entries) => {
    const callbacks = new Set<() => void>()
    for (const entry of entries) {
      const cb = tableMeasures.get(entry.target)
      if (cb) callbacks.add(cb)
    }
    for (const cb of callbacks) cb()
  })
  for (const target of targets) {
    tableMeasures.set(target, onResize)
    sharedTableObserver.observe(target)
  }
  return () => {
    for (const target of targets) {
      sharedTableObserver?.unobserve(target)
      tableMeasures.delete(target)
    }
    if (tableMeasures.size === 0 && sharedTableObserver) {
      sharedTableObserver.disconnect()
      sharedTableObserver = null
    }
  }
}

/**
 * Which sides of a scrolled box hide content, so they fade. Defers initial measurement to the
 * shared ResizeObserver callback (which runs after layout before paint) instead of reading
 * scrollWidth synchronously inside useLayoutEffect, preventing layout thrashing when many tables
 * mount in one commit.
 */
function useOverflow(ref: React.RefObject<HTMLElement | null>): Overflow {
  const [overflow, setOverflow] = useState<Overflow>({ left: false, right: false })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let frame = 0
    const measure = () => {
      const max = el.scrollWidth - el.clientWidth
      const next = { left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 }
      setOverflow((o) => (o.left === next.left && o.right === next.right ? o : next))
    }
    const onScroll = () => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        measure()
      })
    }
    const targets: Element[] = [el]
    if (el.firstElementChild) targets.push(el.firstElementChild)
    const stopObserving = observeTable(targets, measure)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      stopObserving()
      el.removeEventListener('scroll', onScroll)
    }
  }, [ref])
  return overflow
}

/**
 * A table in a thin frame: numeric columns line up on the right, a hovered row tints, a table
 * wider than the reply scrolls sideways with its hidden edge fading, and the footer counts rows
 * and columns and copies it as Markdown or saves it as CSV.
 */
export function MarkdownTable({ node, children, className }: ComponentProps<'table'> & ExtraProps) {
  const { t } = useTranslation('session')
  const table = useRef<HTMLTableElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const overflow = useOverflow(scroller)
  const numeric = useMemo(() => numericColumns(node), [node])
  const prose = useMemo(() => proseColumns(node), [node])
  const size = useMemo(() => tableSize(node), [node])

  // Streamdown draws the cells, so the column marks go on them once they are in the page.
  useLayoutEffect(() => {
    const el = table.current
    if (!el) return
    const numericSet = new Set(numeric)
    const proseSet = new Set(prose)
    for (const row of el.rows) {
      const cells = row.cells
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i]!
        const isNum = numericSet.has(i)
        if (cell.hasAttribute('data-numeric') !== isNum) cell.toggleAttribute('data-numeric', isNum)
        const isProse = proseSet.has(i)
        if (cell.hasAttribute('data-prose') !== isProse) cell.toggleAttribute('data-prose', isProse)
      }
    }
  }, [numeric, prose, children])

  const data = () => (table.current ? extractTableDataFromElement(table.current) : null)
  return (
    <div data-table-frame="">
      <div
        ref={scroller}
        data-table-scroll=""
        data-fade-left={overflow.left || undefined}
        data-fade-right={overflow.right || undefined}
      >
        <table ref={table} data-streamdown="table" className={className}>
          {children}
        </table>
      </div>
      <div data-table-footer="">
        <span className="flex-1 tabular">
          {t('block.tableSize', {
            rows: t('block.rows', { count: size.rows }),
            columns: t('block.columns', { count: size.columns }),
          })}
        </span>
        <BlockCopy
          label={t('block.copyMarkdown')}
          text={() => {
            const d = data()
            return d ? tableDataToMarkdown(d) : ''
          }}
        />
        <BlockAction
          label={t('block.downloadCsv')}
          onClick={() => {
            const d = data()
            if (d) downloadText(tableDataToCSV(d), 'table.csv', 'text/csv')
          }}
        >
          <HugeiconsIcon icon={Download01Icon} strokeWidth={1.9} aria-hidden />
        </BlockAction>
      </div>
    </div>
  )
}
