import { createContext, useContext, type ReactNode } from 'react'
import { ArrowLeftIcon, ChevronRightIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'
import { FlashContext, type GroupDef, type RowDef, type SectionDef } from './model'

const CardContext = createContext(false)

/** One group's rows on a card, divided by separators inset to the text. */
export function RowGroup({ children }: { children: ReactNode }) {
  return (
    <CardContext.Provider value>
      <div className="rounded-xl bg-card shadow-card">{children}</div>
    </CardContext.Provider>
  )
}

/** A section's rows, each run of rows that share a group under its label. */
export function SectionBody({ section }: { section: SectionDef }) {
  const groups: { group: GroupDef | undefined; rows: RowDef[] }[] = []
  for (const row of section.rows) {
    if (row.searchOnly) continue
    const last = groups.at(-1)
    if (last && last.group?.id === row.group?.id) last.rows.push(row)
    else groups.push({ group: row.group, rows: [row] })
  }
  return (
    <div className="flex flex-col gap-7">
      {groups.map(({ group, rows }, i) => (
        <section key={group?.id ?? i} aria-label={group?.label} className="flex flex-col">
          {group && <GroupLabel group={group} />}
          {group?.plain ? (
            rows.map((row) => (
              <RowShell key={row.id} id={row.id} bare>
                {row.render(null)}
              </RowShell>
            ))
          ) : (
            <RowGroup>
              {rows.map((row) =>
                row.layout === 'custom' ? (
                  <RowShell key={row.id} id={row.id} plain>
                    {row.render(null)}
                  </RowShell>
                ) : (
                  <Row key={row.id} row={row} />
                ),
              )}
            </RowGroup>
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
        'flex min-h-7.5 items-center gap-2 px-1 text-xs font-medium',
        group.tone === 'danger' ? 'text-danger' : 'text-tertiary',
      )}
    >
      <h3>
        {group.label}
        {group.count !== undefined && (
          <span className="ml-1 font-normal tabular">{group.count}</span>
        )}
      </h3>
      {group.actions && (
        <span className="-mr-1.5 ml-auto flex items-center gap-1 font-normal">{group.actions}</span>
      )}
    </div>
  )
}

function Row({ row }: { row: RowDef }) {
  const text = <RowText name={row.name} description={row.rich ?? row.description} />
  if (row.layout === 'block') {
    return (
      <RowShell id={row.id}>
        <div className="py-2.5">{row.render(text)}</div>
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
 * Outside a card, every row draws the hairline above it, so the first one also underlines its
 * group's label. On a card, a separator starts at the text's inset and the first row has none.
 * `plain` rows draw their own padding, as an agent's row does; `bare` ones draw everything.
 */
export function RowShell({
  id,
  plain,
  bare,
  children,
}: {
  id?: string
  plain?: boolean
  bare?: boolean
  children: ReactNode
}) {
  const flash = useContext(FlashContext)
  const card = useContext(CardContext)
  return (
    <div
      data-setting-row={id}
      className={cn(
        'relative',
        bare
          ? 'rounded-xl'
          : card
            ? cn(
                'before:absolute before:top-0 before:right-0 before:left-4 before:h-(--hairline) before:bg-border-soft first:rounded-t-xl first:before:hidden last:rounded-b-xl',
                plain ? 'px-3' : 'pr-3 pl-4',
              )
            : cn('border-t border-subtle', !plain && 'px-1'),
      )}
    >
      {id && (
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-y-0 rounded-[inherit] bg-mark opacity-0 transition-opacity duration-(--duration-slower)',
            bare ? '-inset-2' : card ? 'inset-x-0' : '-inset-x-2 rounded-lg',
            flash === id && 'opacity-100',
          )}
        />
      )}
      <div className="relative rounded-[inherit]">{children}</div>
    </div>
  )
}

export function RowText({ name, description }: { name: ReactNode; description?: ReactNode }) {
  const card = useContext(CardContext)
  return (
    <div className={cn('flex min-w-0 flex-col', !card && 'gap-0.5')}>
      <span className="text-ui font-medium">{name}</span>
      {description && (
        <span
          className={cn(
            'text-xs text-pretty text-secondary',
            card ? 'mt-0.5 leading-4' : 'leading-normal',
          )}
        >
          {description}
        </span>
      )}
    </div>
  )
}

/** A row's first line: its text on the left, its control on the right. */
export function RowLine({
  text,
  compact,
  children,
}: {
  text: ReactNode
  compact?: boolean
  children?: ReactNode
}) {
  const card = useContext(CardContext)
  return (
    <div
      className={cn(
        'flex items-center',
        card ? cn('gap-4 py-2.5', compact ? 'min-h-12' : 'min-h-15') : 'min-h-7 gap-6 py-3',
      )}
    >
      <div className="min-w-0 flex-1">{text}</div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  )
}

/** A row of its own outside the section data, such as a fact on an agent's page. */
export function RowFrame({
  text,
  compact,
  children,
}: {
  text: ReactNode
  compact?: boolean
  children?: ReactNode
}) {
  return (
    <RowShell>
      <RowLine text={text} compact={compact}>
        {children}
      </RowLine>
    </RowShell>
  )
}

/** The light a search result leaves on what it led to, for a part of a page outside the rows. */
export function FlashMark({ id }: { id: string }) {
  const flash = useContext(FlashContext)
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute -inset-2 rounded-xl bg-mark opacity-0 transition-opacity duration-(--duration-slower)',
        flash === id && 'opacity-100',
      )}
    />
  )
}

/**
 * A row of an item that opens a page of its own, such as an agent's or a server's: its tile, the
 * name with what follows it, the lines under it and what sits at its end. The whole row opens it.
 */
export function ItemRow({
  item,
  label,
  tile,
  name,
  right,
  children,
  onOpen,
}: {
  item: string
  label: string
  tile: ReactNode
  /** The name line's content, before the row's end. */
  name: ReactNode
  /** The state and the chevron at the row's end. */
  right?: ReactNode
  /** The lines under the name. */
  children?: ReactNode
  onOpen: () => void
}) {
  return (
    <div className="relative -mx-3 flex items-start gap-3 rounded-[inherit] py-3 pr-3 pl-4">
      {/* Buttons cannot nest, so the row opens through a button laid under its content. */}
      <button
        type="button"
        data-item-row={item}
        aria-label={label}
        onClick={onOpen}
        className="absolute inset-0 rounded-[inherit] outline-none transition-colors duration-(--duration-fast) hover:bg-hover focus-visible:shadow-[inset_0_0_0_2px_var(--focus)]"
      />
      <span className="pointer-events-none relative">{tile}</span>
      <div className="pointer-events-none relative flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-h-5.5 min-w-0 items-center gap-2">
          <span className="truncate text-ui font-medium">{name}</span>
        </div>
        {children}
      </div>
      <div className="pointer-events-none relative flex h-5.5 shrink-0 items-center gap-2">
        {right}
        <ChevronRightIcon className="size-4 text-icon" />
      </div>
    </div>
  )
}

/** An item page's header: the way back to its list, a 40 px tile and the title with its line. */
export function ItemPageHeader({
  back,
  onBack,
  item,
  icon,
  title,
  children,
  actions,
}: {
  back: string
  onBack: () => void
  item: string
  icon: ReactNode
  title: ReactNode
  /** The line under the title. */
  children?: ReactNode
  actions?: ReactNode
}) {
  return (
    <>
      <Button
        variant="quiet"
        size="sm"
        className="-mt-1 mb-3.5 -ml-2 w-max gap-1.5 pr-2.5 pl-2 text-secondary"
        onClick={onBack}
      >
        <ArrowLeftIcon data-icon="inline-start" />
        {back}
      </Button>
      <header data-setting-row={item} className="relative mb-6 flex items-center gap-3.5">
        <FlashMark id={item} />
        <span className="relative grid size-10 shrink-0 place-items-center rounded-code bg-surface shadow-card">
          {icon}
        </span>
        <div className="relative flex min-w-0 flex-1 flex-col gap-0.75">
          <h2 className="flex min-w-0 font-heading text-title font-medium">{title}</h2>
          {children && <div className="flex min-w-0 items-center gap-1.75">{children}</div>}
        </div>
        {actions && <div className="relative flex shrink-0 items-center gap-1.5">{actions}</div>}
      </header>
    </>
  )
}

/** A notice under an item's title: its icon and words, an action at its end, more under it. */
export function Notice({
  variant,
  icon,
  title,
  action,
  children,
  more,
}: {
  variant: 'info' | 'success' | 'warning' | 'error'
  icon: ReactNode
  title: ReactNode
  action?: ReactNode
  children?: ReactNode
  more?: ReactNode
}) {
  return (
    <Alert variant={variant}>
      {icon}
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <AlertTitle>{title}</AlertTitle>
          {children && <AlertDescription>{children}</AlertDescription>}
        </div>
        {action && <div className="-my-1 flex shrink-0 items-center gap-1.5">{action}</div>}
      </div>
      {more && <div className="col-start-2 mt-2.5 flex flex-col gap-2.5">{more}</div>}
    </Alert>
  )
}
