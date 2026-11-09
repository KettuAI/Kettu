// The directory's parts on affectUI's Integrations: a row with its tile, name, badge, kind and
// line, the round add button that installs, and the button that unfolds a section.

import { useState, type ReactNode } from 'react'
import {
  ArrowRight01Icon,
  CheckmarkBadge01Icon,
  PlusSignIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { CatalogServer, PluginHarness } from '@shared/marketplace'
import { Icon, Popover } from '@renderer/components/affect/app-shell'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { installServer } from './actions'
import { ServerTile } from './brand-marks'
import { useInstalling, useKept } from './hooks'
import { InstallForm } from './install'
import { asksFirst } from './model'

/** The official badge, for what the maker of the service or the harness publishes. */
export function OfficialBadge() {
  const { t } = useTranslation('marketplace')
  return (
    <span className="ui-as-int-row__badge k-mkt-official" title={t('listing.official')}>
      <Icon icon={CheckmarkBadge01Icon} size={14} />
      <span className="sr-only">{t('listing.official')}</span>
    </span>
  )
}

export type ItemKind = 'mcp' | 'plugin' | 'skill'

/** The kind of an item, and for a plugin the harness it belongs to. */
export function KindTag({ kind, harness }: { kind: ItemKind; harness?: PluginHarness }) {
  const { t } = useTranslation('marketplace')
  return (
    <span className="k-mkt-kind">
      {harness && <AgentMark agent={harness} size={11} dot={null} />}
      {t(`kind.${kind}`)}
    </span>
  )
}

/** A row: its tile, name and line open its listing; `end` sits at the row's end. */
export function ItemRow({
  title,
  brand,
  official,
  tag,
  line,
  fresh,
  onOpen,
  end,
}: {
  title: string
  brand: string | null
  official: boolean
  tag?: ReactNode
  line: string | null
  fresh?: boolean
  onOpen: () => void
  end: ReactNode
}) {
  return (
    <div className={fresh ? 'ui-as-int-row ui-as-rise' : 'ui-as-int-row'}>
      <ServerTile brand={brand} name={title} />
      <button type="button" className="ui-as-int-row__text k-mkt-open" onClick={onOpen}>
        <span className="ui-as-int-row__name">
          <span className="ui-as-int-row__label" title={title}>
            {title}
          </span>
          {official && <OfficialBadge />}
          {tag}
        </span>
        {line && (
          <span className="ui-as-int-row__desc" title={line}>
            {line}
          </span>
        )}
      </button>
      {end}
    </div>
  )
}

/**
 * The Integrations screen's add button: a check once installed, which opens the listing; else it
 * opens `form` in a popover, or installs at once with `onAdd` when nothing needs asking.
 */
export function AddControl({
  name,
  state,
  onOpen,
  onAdd,
  form,
}: {
  name: string
  state: 'on' | 'off' | 'busy'
  onOpen: () => void
  onAdd?: () => void
  form?: (close: () => void) => ReactNode
}) {
  const { t } = useTranslation('marketplace')
  const [open, setOpen] = useState(false)
  return (
    <span className="ui-as-anchor">
      <button
        type="button"
        className="ui-as-int-add"
        data-state={state}
        aria-label={
          state === 'on'
            ? t('row.manage', { name })
            : state === 'busy'
              ? t('row.installing', { name })
              : t('row.install', { name })
        }
        aria-expanded={form && state === 'off' ? open : undefined}
        aria-busy={state === 'busy' || undefined}
        title={state === 'on' ? t('row.manageTitle') : t('row.installTitle')}
        onClick={() => {
          if (state === 'busy') return
          if (state === 'on') return onOpen()
          if (form) return setOpen((o) => !o)
          onAdd?.()
        }}
      >
        {state === 'busy' ? (
          <span className="ui-as-spinner" />
        ) : (
          <Icon key={state} icon={state === 'on' ? Tick02Icon : PlusSignIcon} size={15} />
        )}
      </button>
      {form && (
        <Popover
          open={open}
          onClose={() => setOpen(false)}
          align="end"
          className="ui-as-menu k-mkt-install-pop"
        >
          {form(() => setOpen(false))}
        </Popover>
      )}
    </span>
  )
}

/** An MCP server's add button: at once when it asks for nothing, else through the form. */
export function AddButton({ server, onOpen }: { server: CatalogServer; onOpen: () => void }) {
  const kept = useKept(server.id)
  const busy = useInstalling(server.id)
  return (
    <AddControl
      name={server.title}
      state={busy ? 'busy' : kept ? 'on' : 'off'}
      onOpen={onOpen}
      onAdd={() => void installServer(server, 'all', {})}
      form={
        asksFirst(server.spec)
          ? (close) => (
              <InstallForm
                server={server}
                onDone={(agents, values) => {
                  close()
                  void installServer(server, agents, values)
                }}
              />
            )
          : undefined
      }
    />
  )
}

/** "Stripe", "Stripe and Zapier", or "Stripe, Zapier and 3 more". */
export function MoreLabel({ names }: { names: string[] }) {
  const { t } = useTranslation('marketplace')
  const [first = '', second = ''] = names
  if (names.length === 1) return <>{first}</>
  if (names.length === 2) return <>{t('more.two', { first, second })}</>
  return <>{t('more.many', { first, second, count: names.length - 2 })}</>
}

/** The rows a section folds away, behind their first tiles and names. */
export function MoreButton({
  items,
  onClick,
}: {
  items: { key: string; title: string; brand: string | null }[]
  onClick: () => void
}) {
  return (
    <button type="button" className="ui-as-int-more" onClick={onClick}>
      <span className="ui-as-int-more__logos" aria-hidden="true">
        {items.slice(0, 3).map((item) => (
          <ServerTile key={item.key} brand={item.brand} name={item.title} />
        ))}
      </span>
      <MoreLabel names={items.map((item) => item.title)} />
      <Icon icon={ArrowRight01Icon} size={14} />
    </button>
  )
}

/** A section's rows while what fills them is on its way. */
export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className="ui-as-int-grid" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <SkeletonRow key={i} />
      ))}
    </div>
  )
}

export function SkeletonRow() {
  return (
    <div className="ui-as-int-row k-mkt-skeleton" aria-hidden>
      <Skeleton className="k-mkt-skeleton__tile" />
      <span className="ui-as-int-row__text">
        <Skeleton className="k-mkt-skeleton__name" />
        <Skeleton className="k-mkt-skeleton__line" />
      </span>
    </div>
  )
}

/** A loading section: its title, or a title's room, over skeleton rows. */
export function SkeletonSection({ rows, title }: { rows?: number; title?: string }) {
  return (
    <section className="ui-as-int-section" aria-busy>
      {title ? (
        <h2 className="ui-as-int-section__title">{title}</h2>
      ) : (
        <Skeleton className="k-mkt-skeleton__title" />
      )}
      <SkeletonRows rows={rows} />
    </section>
  )
}

/** A quiet note over the sections, such as an agent whose plugins could not be read. */
export function QuietNote({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <p className="k-mkt-stale" role="status">
      <span>{children}</span>
      {action}
    </p>
  )
}
