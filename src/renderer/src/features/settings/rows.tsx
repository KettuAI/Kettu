import type { ReactNode } from 'react'
import { cn } from '@renderer/lib/utils'
import type { RowDef, SectionDef } from './model'

/** A section's rows, with a heading and count over each run of rows that share a group. */
export function SectionBody({ section }: { section: SectionDef }) {
  const groups: { name: string | undefined; rows: RowDef[] }[] = []
  for (const row of section.rows) {
    const last = groups.at(-1)
    if (last && last.name === row.group) last.rows.push(row)
    else groups.push({ name: row.group, rows: [row] })
  }
  return (
    <div className="flex flex-col gap-5">
      {groups.map((group, i) => (
        <div key={group.name ?? i} className="flex flex-col">
          {group.name && (
            <h3 className="flex gap-1.5 px-1 pb-1 text-xs font-medium text-muted-foreground">
              {group.name}
              <span className="font-normal tabular">{group.rows.length}</span>
            </h3>
          )}
          {group.rows.map((row, j) =>
            row.layout === 'custom' ? (
              <div key={row.id} className={cn(j > 0 && 'border-t border-border-soft')}>
                {row.render(null)}
              </div>
            ) : (
              <Row key={row.id} row={row} first={j === 0} />
            ),
          )}
        </div>
      ))}
    </div>
  )
}

function Row({ row, first }: { row: RowDef; first: boolean }) {
  const text = <RowText name={row.name} description={row.description} />
  if (row.layout === 'block') {
    return (
      <div className={cn('px-1 py-3', !first && 'border-t border-border-soft')}>
        {row.render(text)}
      </div>
    )
  }
  return (
    <RowFrame text={text} first={first}>
      {row.render(text)}
    </RowFrame>
  )
}

export function RowText({ name, description }: { name: ReactNode; description?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-ui font-medium">{name}</span>
      {description && (
        <span className="text-xs leading-normal text-muted-foreground">{description}</span>
      )}
    </div>
  )
}

/** One settings row: its text on the left, its control on the right, a hairline above. */
export function RowFrame({
  text,
  first,
  children,
}: {
  text: ReactNode
  first: boolean
  children?: ReactNode
}) {
  return (
    <div className={cn('px-1 py-3', !first && 'border-t border-border-soft')}>
      <div className="flex min-h-[28px] items-center gap-6">
        <div className="min-w-0 flex-1">{text}</div>
        {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
      </div>
    </div>
  )
}
