import { useContext, type ReactNode } from 'react'
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { cn } from '@renderer/lib/utils'
import { FlashContext, type GroupDef, type RowDef, type SectionDef } from './model'

/** A section's title in the display face and its one line under it. */
export function PageHeader({
  id,
  title,
  children,
}: {
  id?: string
  title: ReactNode
  children?: ReactNode
}) {
  return (
    <header className="flex flex-col">
      <h2 id={id} className="font-display text-section font-bold text-balance">
        {title}
      </h2>
      {children && <p className="mt-1.5 mb-1 text-lede text-pretty text-tertiary">{children}</p>}
    </header>
  )
}

// A run of rows between hairlines: one above the first, one under each.
const LINE_TOP = 'shadow-[inset_0_var(--hairline)_0_var(--border-subtle)]'
const LINE_UNDER = 'shadow-[inset_0_calc(-1*var(--hairline))_0_var(--border-subtle)]'

/** One group's rows, under a hairline, each row with its own hairline under it. */
export function RowGroup({ children }: { children: ReactNode }) {
  return <div className={LINE_TOP}>{children}</div>
}

/** A section's rows, each run of rows that share a group under its heading. */
export function SectionBody({ section }: { section: SectionDef }) {
  const groups: { group: GroupDef | undefined; rows: RowDef[] }[] = []
  for (const row of section.rows) {
    if (row.searchOnly) continue
    const last = groups.at(-1)
    if (last && last.group?.id === row.group?.id) last.rows.push(row)
    else groups.push({ group: row.group, rows: [row] })
  }
  return (
    <div className="flex flex-col">
      {groups.map(({ group, rows }, i) => (
        <section key={group?.id ?? i} aria-label={group?.label} className="flex flex-col">
          {group && !group.unlabeled ? (
            <GroupLabel group={group} first={i === 0} />
          ) : (
            <div className="h-4" />
          )}
          {group?.plain ? (
            rows.map((row) => (
              <RowShell key={row.id} id={row.id} bare>
                {row.render(null)}
              </RowShell>
            ))
          ) : (
            <RowGroup>
              {rows.map((row) =>
                row.layout === 'custom' || row.layout === 'bare' ? (
                  <RowShell key={row.id} id={row.id} plain bare={row.layout === 'bare'}>
                    {row.render(
                      row.layout === 'bare' ? (
                        <RowText name={row.name} description={row.rich ?? row.description} />
                      ) : null,
                    )}
                  </RowShell>
                ) : (
                  <Row key={row.id} row={row} />
                ),
              )}
            </RowGroup>
          )}
          {group?.note}
        </section>
      ))}
    </div>
  )
}

/** A line under a group's rows, as `GroupDef.note` takes it. */
export function GroupNote({ children }: { children: ReactNode }) {
  return <p className="mt-2.5 text-hint text-pretty text-tertiary">{children}</p>
}

/** A group's heading, with its count after it and its actions at the end. */
/** `first`: right under the page's description, whose 4 px below it count toward the 32 above. */
export function GroupLabel({ group, first }: { group: GroupDef; first?: boolean }) {
  return (
    <div className={cn('mb-1 flex min-h-7.5 items-center gap-2', first ? 'mt-7' : 'mt-8')}>
      <h3 className="text-subheading font-semibold">{group.label}</h3>
      {group.count !== undefined && (
        <span className="text-group text-tertiary tabular">{group.count}</span>
      )}
      {group.actions && (
        <span className="ml-auto flex items-center gap-1 font-normal">{group.actions}</span>
      )}
    </div>
  )
}

function Row({ row }: { row: RowDef }) {
  const text = <RowText name={row.name} description={row.rich ?? row.description} />
  if (row.layout === 'block') {
    return (
      <RowShell id={row.id}>
        <div className="py-3.75">{row.render(text)}</div>
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
 * A row with its hairline under it. `plain` rows draw their own padding, as an item's row does;
 * `bare` ones draw everything, the line included.
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
  return (
    <div data-setting-row={id} className={cn('relative', !bare && LINE_UNDER)}>
      {id && (
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute -inset-x-2 inset-y-0 rounded-lg bg-mark opacity-0 transition-opacity duration-(--duration-slower)',
            bare && '-inset-2 rounded-xl',
            flash === id && 'opacity-100',
          )}
        />
      )}
      <div className={cn('relative', plain && 'rounded-[inherit]')}>{children}</div>
    </div>
  )
}

export function RowText({ name, description }: { name: ReactNode; description?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-label leading-[normal]">{name}</span>
      {description && (
        <span className="mt-0.75 text-group leading-normal text-pretty text-tertiary">
          {description}
        </span>
      )}
    </div>
  )
}

/** A row's first line: its text on the left, its control on the right. */
export function RowLine({ text, children }: { text: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-x-7 gap-y-3 py-3.75">
      <div className="min-w-0 flex-[1_1_280px]">{text}</div>
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
    <div className="relative flex items-center gap-3.5 py-3.25">
      {/* Buttons cannot nest, so the row opens through a button laid under its content. */}
      <button
        type="button"
        data-item-row={item}
        aria-label={label}
        onClick={onOpen}
        className="absolute -inset-x-2 inset-y-px rounded-lg outline-none transition-colors duration-(--duration-fast) hover:bg-hover focus-ring"
      />
      <span className="pointer-events-none relative">{tile}</span>
      <div className="pointer-events-none relative flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2 text-label leading-[normal]">{name}</div>
        {children}
      </div>
      <div className="pointer-events-none relative flex shrink-0 items-center gap-2">
        {right}
        <ChevronRightIcon strokeWidth={1.6} className="size-3.5 text-tertiary" />
      </div>
    </div>
  )
}

/** A line under an item row's name, in the quiet small role. */
export function ItemLine({ children }: { children: ReactNode }) {
  return <span className="truncate text-group leading-[normal] text-tertiary">{children}</span>
}

/**
 * An item page's header: the way back to its list, the title, then a 40 px tile with what the item
 * is and its state beside it.
 */
export function ItemPageHeader({
  back,
  onBack,
  item,
  icon,
  title,
  subtitle,
  children,
  actions,
}: {
  back: string
  onBack: () => void
  item: string
  icon: ReactNode
  title: ReactNode
  /** What the item is, beside the tile, such as its harness and how it signs in. */
  subtitle?: ReactNode
  /** The state line under it. */
  children?: ReactNode
  actions?: ReactNode
}) {
  return (
    <>
      <button
        type="button"
        onClick={onBack}
        className="mb-3 inline-flex w-max items-center gap-1 rounded-md text-group leading-[normal] text-tertiary outline-none transition-colors duration-(--duration-fast) hover:text-primary focus-ring"
      >
        <ChevronLeftIcon className="size-3.5" />
        {back}
      </button>
      <header data-setting-row={item} className="relative flex flex-col">
        <FlashMark id={item} />
        <h2 className="relative flex min-w-0 font-display text-section font-bold">{title}</h2>
        {/* 10 px: a page title's 6 px and the 4 px its description would leave below. */}
        <div className="relative mt-2.5 flex items-center gap-3.5">
          <span className="relative grid size-10 shrink-0 place-items-center">{icon}</span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            {subtitle && (
              <div className="flex min-w-0 items-center gap-1.5 text-label">{subtitle}</div>
            )}
            {children && (
              <div className="flex min-w-0 items-center gap-1.75 text-hint text-secondary">
                {children}
              </div>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </div>
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
      {more && <div className="col-start-2 mt-2.5 flex min-w-0 flex-col gap-2.5">{more}</div>}
    </Alert>
  )
}
