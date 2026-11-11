// The directory's parts on affectUI's Integrations: a row with its tile, name, badge, kind and
// line, the round add button that installs, and the button that unfolds a section.

import { useState, type ReactNode } from 'react'
import { ArrowRight01Icon, CheckmarkBadge01Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { CatalogServer, PluginHarness } from '@shared/marketplace'
import { Icon, Popover } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { useHostScope } from '@renderer/stores/host-scope'
import { installServer } from './actions'
import { ConnectButton } from './connect'
import { useConnectFlow, useInstalling, useKept } from './hooks'
import { InstallForm } from './install'
import { asksFirst, oauthFlow } from './model'
import type { TileSubject } from './tile-art'
import { ItemTile } from './tiles'

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

/**
 * A row: its tile, name and line open its listing, when it has one; `end` sits at the row's end.
 * `icon` stands in for the item's tile, such as an agent's mark.
 */
export function ItemRow({
  title,
  subject,
  icon,
  quiet,
  official = false,
  tag,
  line,
  lineTitle,
  fresh,
  onOpen,
  end,
}: {
  title: string
  subject?: TileSubject
  icon?: ReactNode
  /** For what an agent keeps itself. */
  quiet?: boolean
  official?: boolean
  tag?: ReactNode
  line: string | null
  /** The line's tooltip when it says more than the line. */
  lineTitle?: string
  fresh?: boolean
  onOpen?: () => void
  end?: ReactNode
}) {
  const text = (
    <>
      <span className="ui-as-int-row__name">
        <span className="ui-as-int-row__label" title={title}>
          {title}
        </span>
        {official && <OfficialBadge />}
        {tag}
      </span>
      {line && (
        <span className="ui-as-int-row__desc" title={lineTitle ?? line}>
          {line}
        </span>
      )}
    </>
  )
  return (
    <div className={fresh ? 'ui-as-int-row ui-as-rise' : 'ui-as-int-row'}>
      {icon ?? (subject && <ItemTile subject={subject} quiet={quiet} />)}
      {onOpen ? (
        <button type="button" className="ui-as-int-row__text k-mkt-open" onClick={onOpen}>
          {text}
        </button>
      ) : (
        <span className="ui-as-int-row__text">{text}</span>
      )}
      {end}
    </div>
  )
}

/** The Integrations screen's check once installed, which opens the listing to manage it. */
export function InstalledCheck({ name, onOpen }: { name: string; onOpen: () => void }) {
  const { t } = useTranslation('marketplace')
  return (
    <button
      type="button"
      className="ui-as-int-add"
      data-state="on"
      aria-label={t('row.manage', { name })}
      title={t('row.manageTitle')}
      onClick={onOpen}
    >
      <Icon icon={Tick02Icon} size={15} />
    </button>
  )
}

/**
 * A row's action: a small button that says what it does, Install, Set up or Add, which opens
 * `form` in a popover, or acts at once with `onAdd` when nothing needs asking; the check once
 * installed.
 */
export function AddControl({
  name,
  label,
  state,
  onOpen,
  onAdd,
  form,
}: {
  name: string
  label: string
  state: 'on' | 'off' | 'busy'
  onOpen: () => void
  onAdd?: () => void
  form?: (close: () => void) => ReactNode
}) {
  const { t } = useTranslation('marketplace')
  const [open, setOpen] = useState(false)
  if (state === 'on') return <InstalledCheck name={name} onOpen={onOpen} />
  return (
    <span className="ui-as-anchor">
      <Button
        size="sm"
        variant="secondary"
        loading={state === 'busy'}
        aria-label={t('row.action', { action: label, name })}
        aria-expanded={form ? open : undefined}
        onClick={() => {
          if (form) return setOpen((o) => !o)
          onAdd?.()
        }}
      >
        {label}
      </Button>
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

/**
 * An MCP server's action: Connect for one that signs in, Set up for one that asks for values,
 * Install at once for one that asks for nothing.
 */
export function AddButton({ server, onOpen }: { server: CatalogServer; onOpen: () => void }) {
  const { t } = useTranslation('marketplace')
  const kept = useKept(server.id)
  const scope = useHostScope()
  const busy = useInstalling(server.id)
  const flow = useConnectFlow(server.id)
  // A Connect that installs it keeps its button, and the popover with it, until it ends.
  if (kept && !flow?.fresh) return <InstalledCheck name={server.title} onOpen={onOpen} />
  if (oauthFlow(server.spec)) return <ConnectButton server={server} />
  return (
    <AddControl
      name={server.title}
      label={asksFirst(server.spec) ? t('row.setUp') : t('row.install')}
      state={busy ? 'busy' : 'off'}
      onOpen={onOpen}
      onAdd={() => void installServer(scope, server, 'all', {})}
      form={
        asksFirst(server.spec)
          ? (close) => (
              <InstallForm
                server={server}
                onDone={(agents, values) => {
                  close()
                  void installServer(scope, server, agents, values)
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
  quiet,
  onClick,
}: {
  items: { key: string; title: string; subject: TileSubject }[]
  quiet?: boolean
  onClick: () => void
}) {
  return (
    <button type="button" className="ui-as-int-more" onClick={onClick}>
      <span className="ui-as-int-more__logos" aria-hidden="true">
        {items.slice(0, 3).map((item) => (
          <ItemTile key={item.key} subject={item.subject} size="small" quiet={quiet} />
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
