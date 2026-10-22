import { useContext, type ReactNode } from 'react'
import { cn } from '@renderer/lib/utils'
import { FlashContext, type GroupDef, type RowDef, type SectionDef } from './model'

/** A section's rows, each run of rows that share a group under its label. */
export function SectionBody({ section }: { section: SectionDef }) {
  const groups: { group: GroupDef | undefined; rows: RowDef[] }[] = []
  for (const row of section.rows) {
    const last = groups.at(-1)
    if (last && last.group?.id === row.group?.id) last.rows.push(row)
    else groups.push({ group: row.group, rows: [row] })
  }
  return (
    <div className="flex flex-col gap-7">
      {groups.map(({ group, rows }, i) => (
        <section key={group?.id ?? i} aria-label={group?.label} className="flex flex-col">
          {group && <GroupLabel group={group} />}
          {rows.map((row) =>
            row.layout === 'custom' ? (
              <RowShell key={row.id} id={row.id} plain>
                {row.render(null)}
              </RowShell>
            ) : (
              <Row key={row.id} row={row} />
            ),
          )}
        </section>
      ))}
    </div>
  )
}

/** A group's label in the caption role, with its count and actions at the end. */
export function GroupLabel({ group }: { group: GroupDef }) {
  return (
    <div
      className={cn(
        'flex h-7.5 items-center gap-1.5 px-1 text-xs font-medium',
        group.tone === 'danger' ? 'text-destructive' : 'text-muted-foreground',
      )}
    >
      <h3>{group.label}</h3>
      {group.count !== undefined && <span className="font-normal tabular">{group.count}</span>}
      {group.actions && (
        <span className="ml-auto flex items-center gap-1 font-normal">{group.actions}</span>
      )}
    </div>
  )
}

function Row({ row }: { row: RowDef }) {
  const text = <RowText name={row.name} description={row.description} />
  if (row.layout === 'block') {
    return (
      <RowShell id={row.id}>
        <div className="py-3">{row.render(text)}</div>
      </RowShell>
    )
  }
  return (
    <RowShell id={row.id}>
      <RowLine text={text}>{row.render(text)}</RowLine>
    </RowShell>
  )
}

/**
 * Every row draws the hairline above it, so the first one also underlines its group's label.
 * `plain` rows draw their own padding, as an agent's row does.
 */
export function RowShell({
  id,
  plain,
  children,
}: {
  id?: string
  plain?: boolean
  children: ReactNode
}) {
  const flash = useContext(FlashContext)
  return (
    <div
      data-setting-row={id}
      className={cn('relative border-t border-border-soft', !plain && 'px-1')}
    >
      {id && (
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute -inset-x-2 inset-y-0 rounded-lg bg-mark opacity-0 transition-opacity duration-(--duration-slower)',
            flash === id && 'opacity-100',
          )}
        />
      )}
      <div className="relative">{children}</div>
    </div>
  )
}

export function RowText({ name, description }: { name: ReactNode; description?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-ui font-medium">{name}</span>
      {description && (
        <span className="text-xs leading-normal text-pretty text-muted-foreground">
          {description}
        </span>
      )}
    </div>
  )
}

/** A row's first line: its text on the left, its control on the right. */
export function RowLine({ text, children }: { text: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center gap-6 py-3">
      <div className="min-w-0 flex-1">{text}</div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  )
}

/** A row of its own outside the section data, such as a fact on an agent's page. */
export function RowFrame({ text, children }: { text: ReactNode; children?: ReactNode }) {
  return (
    <RowShell>
      <RowLine text={text}>{children}</RowLine>
    </RowShell>
  )
}
