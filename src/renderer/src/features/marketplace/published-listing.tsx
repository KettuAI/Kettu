// One of the account's own listings, as its publisher sees it: its state, New version and the
// rest in ⋯, the facts, daily installs over 30 days with each version's day, its versions with
// where each came from, the current version's checks, and where it was published from.

import { useEffect, useState } from 'react'
import {
  Alert02Icon,
  Delete02Icon,
  File01Icon,
  Message01Icon,
  MinusSignCircleIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { Trans, useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type {
  MarketPublished,
  MineListing,
  MineVersion,
  VersionCheck,
} from '@shared/market-publish'
import { Dropdown, Icon, type MenuItem } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { bytes, count, mediumAgo, monthDay } from '@renderer/lib/format'
import { useHostScope } from '@renderer/stores/host-scope'
import { ListingDialogs, PublishFolderDialog, type ListingDialog } from './publish-dialogs'
import {
  listingMenu,
  useConvertListing,
  useNewVersionItems,
  usePublishedStore,
  useRelist,
  type FolderChoice,
} from './published-hooks'
import { MoreMenu, ReviewPill, SessionLink, StatePill, Visibility } from './published'
import {
  chartScale,
  dayAt,
  folderShown,
  harnessName,
  isClosed,
  isHarness,
  kindOf,
  knownSession,
  openKnownSession,
  refusedDraft,
  releaseDays,
} from './published-model'
import { ListingFrame, ListingSkeleton } from './parts'
import { KindTag } from './rows'
import { ItemTile } from './tiles'
import { listingSubject } from './published-model'

const EVERY_AGENT = ['claude-code', 'codex', 'opencode', 'pi'] as const

export function PublishedListingPage({ id, back }: { id: string; back: () => void }) {
  const { t } = useTranslation('marketplace')
  const store = usePublishedStore()
  const published = store((s) => s.published)
  const loading = store((s) => s.loading)
  useEffect(() => {
    if (!store.getState().published) void store.getState().load()
  }, [store])
  const listing = published?.mine?.listings.find((l) => l.id === id) ?? null
  if (!listing || !published) {
    return (
      <ListingFrame back={back} label={t('published.listing.back')}>
        {loading || !published ? (
          <ListingSkeleton />
        ) : (
          <div className="ui-as-empty">
            <b className="ui-as-empty__title">{t('published.listing.missingTitle')}</b>
            <p className="ui-as-empty__text">{t('published.listing.missingText')}</p>
            <Button size="md" variant="secondary" onClick={back}>
              {t('published.listing.backToPublished')}
            </Button>
          </div>
        )}
      </ListingFrame>
    )
  }
  return <Listing listing={listing} published={published} back={back} />
}

function stateOf(listing: MineListing): {
  tone?: 'success' | 'danger' | 'attention'
  key: 'public' | 'private' | 'unlisted' | 'takenDown' | 'held'
} {
  if (listing.takenDown) return { tone: 'danger', key: 'takenDown' }
  // Nothing of it is listed while its only version waits for review.
  if (listing.current === null && listing.versions.some((v) => v.status === 'held')) {
    return { tone: 'attention', key: 'held' }
  }
  if (listing.visibility === 'public') return { tone: 'success', key: 'public' }
  return { key: listing.visibility }
}

function Listing({
  listing,
  published,
  back,
}: {
  listing: MineListing
  published: MarketPublished
  back: () => void
}) {
  const { t } = useTranslation('marketplace')
  const { t: ts } = useTranslation('session')
  const { hostId } = useHostScope()
  const [dialog, setDialog] = useState<ListingDialog | null>(null)
  const [folder, setFolder] = useState<FolderChoice | null>(null)
  const relist = useRelist()
  const versionItems = useNewVersionItems(listing, published, setFolder)
  const { convert, converting } = useConvertListing(setFolder)
  const closed = isClosed(listing)
  const state = stateOf(listing)
  const current = listing.versions.find((v) => v.version === listing.current) ?? null
  const origin = published.origins[listing.id]
  const shown = origin ? folderShown(hostId, origin.path) : null
  const refused = refusedDraft(published.drafts, listing.id)
  const counted = listing.visibility !== 'private'
  const updated = Date.parse(listing.updatedAt)
  const menu = listingMenu(
    listing,
    t,
    (next) => setDialog(next.kind === 'delete' ? { ...next, onDeleted: back } : next),
    () => relist(listing),
  )
  return (
    <ListingFrame back={back} label={t('published.listing.back')} rise>
      <header className="k-mkt-head">
        <ItemTile subject={listingSubject(listing)} size="big" />
        <span className="k-mkt-head__title">
          <span className="k-mkt-head__name">
            <h1>{listing.name}</h1>
            <KindTag kind={kindOf(listing.kind)} harness={listing.harness} />
          </span>
          <span className="k-mkt-head__pub">
            <span className="k-mkt-mono">@{listing.handle}</span>
            <span className="k-mkt-head__trust">{t('published.listing.you')}</span>
          </span>
          {listing.description && <span className="k-mkt-head__line">{listing.description}</span>}
        </span>
        <span className="k-mkt-head__act">
          <StatePill tone={state.tone}>{t(`published.state.${state.key}`)}</StatePill>
          {!listing.takenDown && closed && (
            <Button
              size="md"
              variant="secondary"
              loading={converting}
              onClick={() => convert(listing)}
            >
              {t('published.menu.convert')}
            </Button>
          )}
          {!listing.takenDown && !closed && (
            <Dropdown
              align="end"
              className="k-mkt-add"
              items={versionItems}
              trigger={({ open, toggle }) => (
                <Button
                  size="md"
                  variant="secondary"
                  aria-expanded={open}
                  aria-haspopup="menu"
                  onClick={toggle}
                >
                  {t('published.menu.newVersion')}
                </Button>
              )}
            />
          )}
          <MoreMenu label={t('published.table.more', { name: listing.name })} items={menu} />
        </span>
      </header>

      {listing.takenDown && (
        <div className="k-pub-alert k-pub-taken" role="status">
          <Icon icon={Alert02Icon} size={15} />
          <span>{t('published.listing.takenDown', { reason: listing.takenDown.reason })}</span>
        </div>
      )}

      {closed && !listing.takenDown && (
        <div className="k-pub-alert" role="status">
          <Icon icon={Alert02Icon} size={15} />
          <span>{t('published.listing.closed')}</span>
        </div>
      )}

      <div className="k-mkt-facts k-pub-facts">
        <span>
          <small>{t('published.listing.facts.installs')}</small>
          <b>{counted ? count(listing.installs.total) : t('published.table.yourComputers')}</b>
        </span>
        {counted && (
          <span>
            <small>{t('published.listing.facts.week')}</small>
            <b>+{count(listing.installs.week)}</b>
          </span>
        )}
        <span>
          <small>{t('published.listing.facts.version')}</small>
          <b className="k-mkt-mono">{listing.current ?? '–'}</b>
        </span>
        <span>
          <small>{t('published.listing.facts.updated')}</small>
          <b>{Number.isNaN(updated) ? '–' : mediumAgo(updated)}</b>
        </span>
        <span>
          <small>{t('published.listing.facts.visibleTo')}</small>
          <b>
            <Visibility listing={listing} />
          </b>
        </span>
      </div>

      <div className="k-mkt-body">
        <div className="k-mkt-body__main">
          {counted && (
            <section>
              <h3>{t('published.listing.installs')}</h3>
              <InstallsChart listing={listing} />
            </section>
          )}
          <section>
            <h3>{t('published.listing.versions')}</h3>
            <div className="k-mkt-list k-pub-versions">
              {refused && (
                <RefusedVersion version={refused.manifest.version} error={refused.error} />
              )}
              {listing.versions.map((version) => (
                <VersionRow
                  key={version.version}
                  listing={listing}
                  version={version}
                  sessionId={origin?.sessions[version.version] ?? null}
                  open={setDialog}
                />
              ))}
            </div>
          </section>
          {current && (
            <section>
              <h3>{t('published.listing.checks', { version: current.version })}</h3>
              <Checks listing={listing} version={current} />
            </section>
          )}
        </div>
        <aside className="k-mkt-side k-pub-side">
          <dl>
            <dt>{t('published.listing.side.publisher')}</dt>
            <dd className="k-mkt-mono">@{listing.handle}</dd>
            <dt>{t('published.listing.side.kind')}</dt>
            <dd>{ts(`marketPublish.kind.${listing.kind}`)}</dd>
            {shown && (
              <>
                <dt>{t('published.listing.side.folder')}</dt>
                <dd className="k-pub-folder">
                  <span className="k-mkt-mono" data-selectable="">
                    {shown.path}
                  </span>
                  {shown.project && (
                    <small>
                      {t('published.listing.side.folderIn', { project: shown.project })}
                    </small>
                  )}
                </dd>
              </>
            )}
            <dt>{t('published.listing.side.worksWith')}</dt>
            <dd>
              {listing.kind === 'plugin' && listing.harness ? (
                <AgentMark agent={listing.harness} size={14} dot={null} />
              ) : listing.kind === 'workflow' ? (
                (['claude-code', 'codex'] as const).map((agent) => (
                  <AgentMark key={agent} agent={agent} size={14} dot={null} />
                ))
              ) : (
                EVERY_AGENT.map((agent) => (
                  <AgentMark key={agent} agent={agent} size={14} dot={null} />
                ))
              )}
            </dd>
          </dl>
          {counted && <p className="k-pub-note">{t('published.listing.countsOnly')}</p>}
        </aside>
      </div>
      <ListingDialogs dialog={dialog} onClose={() => setDialog(null)} />
      <PublishFolderDialog choice={folder} onClose={() => setFolder(null)} />
    </ListingFrame>
  )
}

/** A version the service refused, kept as a draft, above the versions it would follow. */
function RefusedVersion({ version, error }: { version: string; error: string | null }) {
  const { t } = useTranslation('marketplace')
  return (
    <div className="k-pub-vrow">
      <span className="k-mkt-mono k-pub-vrow__v">{version}</span>
      <span className="k-pub-vrow__body">
        <span className="k-pub-vrow__top">
          <StatePill tone="danger">
            <Icon icon={Alert02Icon} size={12} />
            {t('published.needs.needsFix')}
          </StatePill>
        </span>
        {error && (
          <p className="k-pub-vrow__error" data-selectable="">
            {error}
          </p>
        )}
      </span>
    </div>
  )
}

function VersionRow({
  listing,
  version,
  sessionId,
  open,
}: {
  listing: MineListing
  version: MineVersion
  sessionId: string | null
  open: (dialog: ListingDialog) => void
}) {
  const { t } = useTranslation('marketplace')
  const isCurrent = version.version === listing.current
  const live = version.status === 'live'
  const held = version.status === 'held'
  const refused = version.status === 'refused'
  const at = Date.parse(version.publishedAt)
  const agent = harnessName(version.agent)
  const items: MenuItem[] = [
    ...(live
      ? [
          {
            label: t('published.listing.viewFiles'),
            icon: File01Icon,
            onSelect: () => open({ kind: 'files', listing, version: version.version }),
          },
        ]
      : []),
    {
      label: t('published.listing.openSession'),
      icon: Message01Icon,
      disabled: !knownSession(sessionId),
      onSelect: () => openKnownSession(sessionId),
    },
    ...(live && !isCurrent && listing.current
      ? [
          {
            label: t('published.listing.withdraw', { version: version.version }),
            description: t('published.listing.withdrawLine', { current: listing.current }),
            icon: Delete02Icon,
            danger: true,
            divider: true,
            onSelect: () => open({ kind: 'withdraw', listing, version: version.version }),
          },
        ]
      : []),
  ]
  const session = version.session ? (
    <SessionLink sessionId={sessionId} title={version.session} />
  ) : null
  return (
    <div className="k-pub-vrow" data-withdrawn={live || held || refused ? undefined : ''}>
      <span className="k-mkt-mono k-pub-vrow__v">{version.version}</span>
      <span className="k-pub-vrow__body">
        <span className="k-pub-vrow__top">
          {isCurrent && <StatePill tone="success">{t('published.listing.current')}</StatePill>}
          {(held || refused) && <ReviewPill held={held} />}
          {version.status === 'withdrawn' && (
            <StatePill>{t('published.listing.withdrawn')}</StatePill>
          )}
          {!Number.isNaN(at) && (
            <small title={new Date(at).toLocaleString()}>{mediumAgo(at)}</small>
          )}
        </span>
        {held && <p className="k-pub-vrow__note">{t('published.review.heldNote')}</p>}
        {refused && version.refusal && (
          <p className="k-pub-vrow__error" data-selectable="">
            {version.refusal.reason}
          </p>
        )}
        <p data-selectable="">
          {version.notes || <span className="k-pub-faint">{t('published.listing.noNotes')}</span>}
        </p>
        <small className="k-pub-vrow__by">
          {isHarness(version.agent) && <AgentMark agent={version.agent} size={12} dot={null} />}
          <span>
            {agent && session ? (
              <Trans
                t={t}
                i18nKey="published.listing.by"
                values={{ agent, session: version.session }}
                components={{ ref: session }}
              />
            ) : agent ? (
              t('published.listing.byAgent', { agent })
            ) : session ? (
              <Trans
                t={t}
                i18nKey="published.listing.bySession"
                values={{ session: version.session }}
                components={{ ref: session }}
              />
            ) : (
              t('published.listing.byYou')
            )}
          </span>
        </small>
      </span>
      <MoreMenu
        label={t('published.listing.versionMore', { version: version.version })}
        items={items}
      />
    </div>
  )
}

function checkText(
  check: VersionCheck,
  version: MineVersion,
  listing: MineListing,
  t: TFunction<'marketplace'>,
): { title: string; detail: string } {
  const detail = check.result === 'skipped' && check.note
  switch (check.check) {
    case 'paths':
      return {
        title: t('published.checks.paths.title'),
        detail: t('published.checks.paths.detail'),
      }
    case 'skill':
      return {
        title: check.target ?? t('published.checks.skill.title'),
        detail: t('published.checks.skill.detail'),
      }
    case 'plugin':
      return {
        title: t('published.checks.plugin.title'),
        detail: t('published.checks.plugin.detail', {
          harness: harnessName(check.target ?? listing.harness) ?? '',
        }),
      }
    case 'secrets':
      return {
        title: t('published.checks.secrets.title'),
        detail: t('published.checks.secrets.detail', { count: version.files }),
      }
    case 'package':
    case 'remote':
      return {
        title: t(`published.checks.${check.check}.title`),
        detail: detail ? t('published.checks.skipped', { note: check.note }) : (check.target ?? ''),
      }
    default:
      return {
        title: check.check,
        detail: detail ? t('published.checks.skipped', { note: check.note }) : (check.target ?? ''),
      }
  }
}

/** The checks the service ran on the version, then its size. */
function Checks({ listing, version }: { listing: MineListing; version: MineVersion }) {
  const { t } = useTranslation(['marketplace', 'session'])
  const rows = [
    ...version.checks.map((check) => ({ ...checkText(check, version, listing, t), check })),
    ...(version.files > 0
      ? [
          {
            title: t('published.checks.size.title'),
            detail: t('session:marketPublish.filesSize', {
              count: version.files,
              size: bytes(version.bytes),
            }),
            check: null,
          },
        ]
      : []),
  ]
  return (
    <div className="k-mkt-list k-pub-checks">
      {rows.map((row, i) => (
        <div
          key={i}
          className="k-mkt-item"
          data-skipped={row.check?.result === 'skipped' || undefined}
        >
          <Icon
            icon={row.check?.result === 'skipped' ? MinusSignCircleIcon : Tick02Icon}
            size={15}
          />
          <span>
            <b>{row.title}</b>
            {row.detail && (
              <small
                className={
                  row.check?.check === 'package' || row.check?.check === 'remote'
                    ? 'k-mkt-mono'
                    : undefined
                }
              >
                {row.detail}
              </small>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}

/** Daily installs over the last 30 days, each version's day marked, the day's count on hover. */
function InstallsChart({ listing }: { listing: MineListing }) {
  const { t } = useTranslation('marketplace')
  const [hover, setHover] = useState<number | null>(null)
  const days = listing.installs.days
  const length = days.length
  const { step, max } = chartScale(Math.max(0, ...days))
  const releases = releaseDays(listing, length)
  const label = (i: number) =>
    i === length - 1 ? t('published.listing.today') : monthDay(dayAt(i, length))
  const height = (value: number) => `${(value / max) * 100}%`
  return (
    <div className="k-mkt-list k-pub-chart">
      <div className="k-pub-chart__head">
        <b>{count(listing.installs.week)}</b>
        <span>{t('published.listing.chartWeek')}</span>
        <span className="k-pub-chart__range">{t('published.listing.chartRange')}</span>
      </div>
      <div
        className="k-pub-chart__plot"
        role="img"
        aria-label={t('published.listing.chartLabel')}
        onMouseLeave={() => setHover(null)}
      >
        {[step, step * 2].map((line) => (
          <span key={line} className="k-pub-chart__grid" style={{ bottom: height(line) }}>
            <small>{count(line)}</small>
          </span>
        ))}
        {days.map((value, i) => (
          <span
            key={i}
            className="k-pub-chart__col"
            data-hover={hover === i || undefined}
            data-today={i === length - 1 || undefined}
            onMouseEnter={() => setHover(i)}
          >
            {releases.has(i) && (
              <>
                <span className="k-pub-chart__rel">{releases.get(i)}</span>
                <span
                  className="k-pub-chart__tick"
                  style={{ height: `calc(100% - ${height(value)})` }}
                />
              </>
            )}
            <i style={{ height: height(value) }} />
            {hover === i && (
              <span className="k-pub-chart__tip" style={{ bottom: height(value) }}>
                <b>{count(value)}</b> {label(i)}
              </span>
            )}
          </span>
        ))}
      </div>
      {length > 0 && (
        <div className="k-pub-chart__x">
          <span>{label(0)}</span>
          <span>{label(Math.floor(length / 2))}</span>
          <span>{label(length - 1)}</span>
        </div>
      )}
    </div>
  )
}
