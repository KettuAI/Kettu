import { useContext, type ReactNode } from 'react'
import {
  Alert02Icon,
  AlertCircleIcon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
  InformationCircleIcon,
} from '@hugeicons/core-free-icons'
import { Icon } from '@renderer/components/affect/app-shell'
import { cn } from '@renderer/lib/utils'
import { FlashContext, type GroupDef, type RowDef, type SectionDef } from './model'

/** A section's title and its one line under it, as the settings screens draw a page's head. */
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
    <header className="k-page-head">
      <h1 id={id} className="ui-as-page-title">
        {title}
      </h1>
      {children && <p className="ui-as-page-sub k-page-sub">{children}</p>}
    </header>
  )
}

/** One group's rows on a card, a hairline between rows. */
export function RowGroup({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="ui-sg-card" role={label ? 'group' : undefined} aria-label={label}>
      {children}
    </div>
  )
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
    <div className="k-groups">
      {groups.map(({ group, rows }, i) => (
        <section key={group?.id ?? i} aria-label={group?.label} className="k-group">
          {group && !group.unlabeled && <GroupLabel group={group} />}
          {group?.plain ? (
            <div className="k-plain">
              {rows.map((row) => (
                <RowShell key={row.id} id={row.id}>
                  {row.render(null)}
                </RowShell>
              ))}
            </div>
          ) : (
            <RowGroup>
              {rows.map((row) =>
                row.layout === 'custom' || row.layout === 'bare' ? (
                  <RowShell key={row.id} id={row.id}>
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
  return <p className="ui-sg-hint">{children}</p>
}

/** A group's heading, its count after it and its actions at the end, as affectUI's section heads. */
export function GroupLabel({ group }: { group: GroupDef; first?: boolean }) {
  const title = (
    <h2>
      {group.label}
      {group.count !== undefined && <span className="k-num">· {group.count}</span>}
    </h2>
  )
  if (!group.actions) return <header className="ui-sg-head">{title}</header>
  return (
    <header className="ui-sg-head ui-ss-head">
      <span>{title}</span>
      <span className="k-head-actions">{group.actions}</span>
    </header>
  )
}

/** A group of rows outside the section data: its head, its card and what goes under it. */
export function Group({
  label,
  count,
  actions,
  note,
  children,
}: {
  label?: string
  count?: number
  actions?: ReactNode
  note?: ReactNode
  children: ReactNode
}) {
  return (
    <section aria-label={label} className="k-group">
      {label && <GroupLabel group={{ id: label, label, count, actions }} />}
      <RowGroup>{children}</RowGroup>
      {note}
    </section>
  )
}

function Row({ row }: { row: RowDef }) {
  const text = <RowText name={row.name} description={row.rich ?? row.description} />
  if (row.layout === 'block') {
    return (
      <RowShell id={row.id}>
        <div className="k-block">{row.render(text)}</div>
      </RowShell>
    )
  }
  return (
    <RowShell id={row.id}>
      <RowLine text={text}>{row.render(text)}</RowLine>
    </RowShell>
  )
}

/** A row on a card, with the light a search result leaves on it. */
export function RowShell({
  id,
  children,
}: {
  id?: string
  /** Kept for callers; every row draws its own padding now. */
  plain?: boolean
  bare?: boolean
  children: ReactNode
}) {
  const flash = useContext(FlashContext)
  return (
    <div data-setting-row={id} className="k-row">
      {id && <span aria-hidden className="k-flash" data-on={flash === id || undefined} />}
      {children}
    </div>
  )
}

export function RowText({ name, description }: { name: ReactNode; description?: ReactNode }) {
  return (
    <span className="ui-sg-label">
      <b>{name}</b>
      {description && <small>{description}</small>}
    </span>
  )
}

/** A row's line: its text on the left, its control on the right. */
export function RowLine({ text, children }: { text: ReactNode; children?: ReactNode }) {
  return (
    <div className="ui-sg-row">
      {text}
      {children && <span className="ui-sg-control">{children}</span>}
    </div>
  )
}

/** A block row's first line, for a row that puts more under it. */
export function BlockLine({ text, children }: { text: ReactNode; children?: ReactNode }) {
  return (
    <div className="k-line">
      {text}
      {children && <span className="ui-sg-control">{children}</span>}
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
  return <span aria-hidden className="k-flash" data-on={flash === id || undefined} />
}

/** A thing's mark and its lines: an agent, a host, a device, a server. The mark is 24 px, unframed. */
export function Thing({
  mark,
  name,
  children,
}: {
  mark: ReactNode
  /** The first line, with what follows the name, such as a badge. */
  name: ReactNode
  /** The lines under it. */
  children?: ReactNode
}) {
  return (
    <span className="k-thing">
      <span className="k-mark" aria-hidden>
        {mark}
      </span>
      <span className="ui-sg-label k-lines">
        <b className="k-row-title">{name}</b>
        {children}
      </span>
    </span>
  )
}

/**
 * A row of an item that opens a page of its own, such as an agent's or a server's: its mark, the
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
  /** The state at the row's end, before the arrow. */
  right?: ReactNode
  /** The lines under the name. */
  children?: ReactNode
  onOpen: () => void
}) {
  return (
    <div className="ui-sg-row k-item">
      {/* Buttons cannot nest, so the row opens through a button laid under its content. */}
      <button
        type="button"
        data-item-row={item}
        aria-label={label}
        onClick={onOpen}
        className="k-hit"
      />
      <Thing mark={tile} name={name}>
        {children}
      </Thing>
      <span className="k-end">
        {right}
        <span className="k-chevron">
          <Icon icon={ArrowRight01Icon} size={14} />
        </span>
      </span>
    </div>
  )
}

/** A line under an item row's name, in the quiet small role. */
export function ItemLine({ children }: { children: ReactNode }) {
  return <small>{children}</small>
}

/**
 * An item page's header: the way back to its list, then the item's mark, its title and what it
 * is, its state under that, and its actions at the end.
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
  /** What the item is, such as its harness and how it signs in. */
  subtitle?: ReactNode
  /** The state line under it. */
  children?: ReactNode
  actions?: ReactNode
  /** Kept for callers: the mark always leads the title. */
  iconFirst?: boolean
}) {
  return (
    <>
      <button type="button" onClick={onBack} className="k-back">
        <Icon icon={ArrowLeft01Icon} size={14} />
        {back}
      </button>
      <header data-setting-row={item} className="k-item-head">
        <FlashMark id={item} />
        <span className="k-item-head__mark" aria-hidden>
          {icon}
        </span>
        <div className="k-item-head__text">
          <h1 className="ui-as-page-title">{title}</h1>
          {subtitle && <div className="k-item-head__sub">{subtitle}</div>}
          {children && <div className="k-item-head__state">{children}</div>}
        </div>
        {actions && <div className="k-item-head__actions">{actions}</div>}
      </header>
    </>
  )
}

const NOTICE_ICON = {
  info: InformationCircleIcon,
  success: CheckmarkCircle02Icon,
  warning: Alert02Icon,
  error: AlertCircleIcon,
} as const

/** A notice: its icon and words, an action at its end, more under it, on the settings' gray block. */
export function Notice({
  variant,
  icon,
  title,
  action,
  children,
  more,
  className,
}: {
  variant: 'info' | 'success' | 'warning' | 'error'
  /** In place of the variant's icon, such as a spinner while a task runs. */
  icon?: ReactNode
  title: ReactNode
  action?: ReactNode
  children?: ReactNode
  more?: ReactNode
  className?: string
}) {
  return (
    <div
      role={variant === 'error' ? 'alert' : undefined}
      className={cn('k-notice', className)}
      data-tone={variant}
    >
      <span className="k-notice__icon">
        {icon ?? <Icon icon={NOTICE_ICON[variant]} size={16} />}
      </span>
      <div className="k-notice__body">
        <div className="k-notice__line">
          <div className="k-notice__text">
            <b>{title}</b>
            {children && <div className="k-notice__desc">{children}</div>}
          </div>
          {action && <div className="k-notice__action">{action}</div>}
        </div>
        {more && <div className="k-notice__more">{more}</div>}
      </div>
    </div>
  )
}
