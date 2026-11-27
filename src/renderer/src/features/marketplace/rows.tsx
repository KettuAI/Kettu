// The directory's parts on affectUI's Integrations: a row with its tile, name, kind, publisher
// and description, the button that installs, and the button that unfolds a section.

import { useState, type ReactNode } from 'react'
import {
  ArrowRight01Icon,
  CheckmarkBadge01Icon,
  Flowchart01Icon,
  PlugSocketIcon,
  PuzzleIcon,
  SparklesIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { CatalogServer, PluginHarness } from '@shared/marketplace'
import { Icon, Popover } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { ConnectButton } from './connect'
import { useConnectFlow, useInstalling, useKept } from './hooks'
import { CatalogInstallConfirmation } from './install'
import { asksFirst, oauthFlow } from './model'
import type { TileSubject } from './tile-art'
import { ItemTile } from './tiles'

/**
 * The official badge, for what the maker of the service or the harness publishes; `label` names
 * another level it stands for, such as a verified publisher.
 */
export function OfficialBadge({ label }: { label?: string }) {
  const { t } = useTranslation('marketplace')
  const text = label ?? t('listing.official')
  return (
    <span className="ui-as-int-row__badge k-mkt-official" title={text}>
      <Icon icon={CheckmarkBadge01Icon} size={14} />
      <span className="sr-only">{text}</span>
    </span>
  )
}

/** The Kettu mark, after the name of the publisher Kettu publishes its own listings as. */
export function KettuMark() {
  const { t } = useTranslation('marketplace')
  return <OfficialBadge label={t('community.kettu')} />
}

export type ItemKind = 'mcp' | 'plugin' | 'skill' | 'workflow'

const KIND_ICON: Record<ItemKind, IconSvgElement> = {
  mcp: PlugSocketIcon,
  plugin: PuzzleIcon,
  skill: SparklesIcon,
  workflow: Flowchart01Icon,
}

/** The kind of an item behind its kind's glyph; a plugin's behind the mark of its harness. */
export function KindTag({ kind, harness }: { kind: ItemKind; harness?: PluginHarness }) {
  const { t } = useTranslation('marketplace')
  return (
    <span className="k-mkt-kind" data-kind={kind}>
      {harness ? (
        <AgentMark agent={harness} size={11} dot={null} />
      ) : (
        <Icon icon={KIND_ICON[kind]} size={12} />
      )}
      {t(`kind.${kind}`)}
    </span>
  )
}

/** Who publishes an item, in a row's facts; the Kettu mark after Kettu's own publisher. */
export function Publisher({ name, kettu }: { name: string; kettu?: boolean }) {
  return (
    <span className="k-mkt-publisher" title={name}>
      <span>{name}</span>
      {kettu && <KettuMark />}
    </span>
  )
}

/**
 * A row: its tile, name, facts and line open its listing, when it has one; `end` sits at the
 * row's end. The same parts make a card of Featured, where the line has room for three lines.
 * `icon` stands in for the item's tile, such as an agent's mark. The official badge shows on the
 * listing only, since every row carrying one crowds the list; the Kettu mark, rare, is the exception.
 */
export function ItemRow({
  title,
  subject,
  icon,
  quiet,
  tag,
  meta,
  line,
  lineTitle,
  extra,
  fresh,
  card,
  oneLine,
  onOpen,
  end,
}: {
  title: string
  subject?: TileSubject
  icon?: ReactNode
  /** For what an agent keeps itself. */
  quiet?: boolean
  /** After the name: a state that cannot wait for the facts under it. */
  tag?: ReactNode
  /** The facts under the name, a dot between them: its kind, who publishes it, how many use it. */
  meta?: ReactNode
  line: string | null
  /** The line's tooltip when it says more than the line. */
  lineTitle?: string
  /** Under the line, such as a workflow's steps. */
  extra?: ReactNode
  fresh?: boolean
  card?: boolean
  /** Keeps the line to one line, for a path or an address that reads no better on two. */
  oneLine?: boolean
  onOpen?: () => void
  end?: ReactNode
}) {
  const text = (
    <>
      <span className="ui-as-int-row__name">
        <span className="ui-as-int-row__label" title={title}>
          {title}
        </span>
        {tag}
      </span>
      {meta && <span className="k-mkt-meta">{meta}</span>}
      {line && (
        <span
          className="ui-as-int-row__desc"
          data-one={oneLine ? '' : undefined}
          title={lineTitle ?? line}
        >
          {line}
        </span>
      )}
      {extra}
    </>
  )
  return (
    <div
      className={fresh ? 'ui-as-int-row ui-as-rise' : 'ui-as-int-row'}
      data-card={card ? '' : undefined}
    >
      {icon ?? (subject && <ItemTile subject={subject} quiet={quiet} />)}
      {onOpen ? (
        <button type="button" className="ui-as-int-row__text k-mkt-open" onClick={onOpen}>
          {text}
        </button>
      ) : (
        <span className="ui-as-int-row__text">{text}</span>
      )}
      {end && <span className="k-mkt-row-end">{end}</span>}
    </div>
  )
}

/** "6 steps": with the line of steps, what tells a workflow from the other kinds in a list. */
export function StepsCount({ count }: { count: number }) {
  const { t } = useTranslation('marketplace')
  return <span>{t('workflow.row.steps', { count })}</span>
}

/** A workflow's steps in order on one line, those that wait for the user marked. */
export function StepsLine({ names, waits }: { names: string[]; waits: string[] }) {
  const { t } = useTranslation('marketplace')
  return (
    <span className="k-mkt-steps" title={names.join(' \u2192 ')}>
      {names.map((name, i) => (
        <span
          key={i}
          className="k-mkt-steps__step"
          data-you={waits.includes(name) ? '' : undefined}
        >
          {i > 0 && <Icon icon={ArrowRight01Icon} size={11} />}
          <span title={waits.includes(name) ? t('workflow.row.waitsHere') : undefined}>{name}</span>
        </span>
      ))}
    </span>
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
        size="md"
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
  const busy = useInstalling(server.id)
  const flow = useConnectFlow(server.id)
  const [open, setOpen] = useState(false)
  if (kept && !flow?.fresh) return <InstalledCheck name={server.title} onOpen={onOpen} />
  if (oauthFlow(server.spec)) return <ConnectButton server={server} />
  const label = asksFirst(server.spec) ? t('row.setUp') : t('row.install')
  return (
    <>
      <Button
        size="md"
        variant="secondary"
        loading={busy}
        aria-label={t('row.action', { action: label, name: server.title })}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      <CatalogInstallConfirmation server={server} open={open} setOpen={setOpen} />
    </>
  )
}

/** "Stripe", "Stripe and Zapier", or "Stripe, Zapier and 3 more". */
export function MoreLabel({ names, open }: { names: string[]; open?: boolean }) {
  const { t } = useTranslation('marketplace')
  const [first = '', second = ''] = names
  // Open: the service has more pages, so how many is not known.
  if (open) {
    if (names.length === 0) return <>{t('more.load')}</>
    if (names.length === 1) return <>{t('more.oneOpen', { first })}</>
    return <>{t('more.twoOpen', { first, second })}</>
  }
  if (names.length === 1) return <>{first}</>
  if (names.length === 2) return <>{t('more.two', { first, second })}</>
  return <>{t('more.many', { first, second, count: names.length - 2 })}</>
}

/** The rows a section folds away, behind their first tiles and names. */
export function MoreButton({
  items,
  quiet,
  open,
  loading,
  onClick,
}: {
  items: { key: string; title: string; subject: TileSubject }[]
  quiet?: boolean
  /** More is still to be read from the service. */
  open?: boolean
  loading?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="ui-as-int-more"
      onClick={onClick}
      disabled={loading}
      aria-busy={loading || undefined}
    >
      {items.length > 0 && (
        <span className="ui-as-int-more__logos" aria-hidden="true">
          {items.slice(0, 3).map((item) => (
            <ItemTile key={item.key} subject={item.subject} size="small" quiet={quiet} />
          ))}
        </span>
      )}
      <MoreLabel names={items.map((item) => item.title)} open={open} />
      {loading ? <Spinner className="size-3.5" /> : <Icon icon={ArrowRight01Icon} size={14} />}
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

export function SkeletonRow({ card }: { card?: boolean }) {
  return (
    <div className="ui-as-int-row k-mkt-skeleton" data-card={card ? '' : undefined} aria-hidden>
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
