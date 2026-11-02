import { useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { ArrowDownToLineIcon } from 'lucide-react'
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

/** Which sides of a scrolled box hide content, so they fade. */
function useOverflow(ref: React.RefObject<HTMLElement | null>): Overflow {
  const [overflow, setOverflow] = useState<Overflow>({ left: false, right: false })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const max = el.scrollWidth - el.clientWidth
      const next = { left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 }
      setOverflow((o) => (o.left === next.left && o.right === next.right ? o : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    if (el.firstElementChild) observer.observe(el.firstElementChild)
    el.addEventListener('scroll', measure, { passive: true })
    return () => {
      observer.disconnect()
      el.removeEventListener('scroll', measure)
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
    for (const row of el.rows) {
      for (const [i, cell] of [...row.cells].entries()) {
        cell.toggleAttribute('data-numeric', numeric.includes(i))
        cell.toggleAttribute('data-prose', prose.includes(i))
      }
    }
  })

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
          <ArrowDownToLineIcon />
        </BlockAction>
      </div>
    </div>
  )
}
