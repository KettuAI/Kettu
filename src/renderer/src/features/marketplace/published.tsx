// Marketplace › Published: who the account publishes as, the drafts that need the user, and a
// table of what it published, each opening its page; Publish asks an agent or checks a folder.

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import {
  Add01Icon,
  Alert02Icon,
  Folder01Icon,
  Message01Icon,
  MoreHorizontalIcon,
  Note01Icon,
  RefreshIcon,
  Store01Icon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { Trans, useTranslation } from 'react-i18next'
import {
  reviewVersions,
  type MarketAccount,
  type MarketPublished,
  type MineListing,
  type MineVersion,
  type PublishDraft,
} from '@shared/market-publish'
import { Dropdown, Icon, type MenuItem } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { toast } from '@renderer/components/ui/toast'
import { AccountAvatar } from '@renderer/features/account/avatar'
import { identityOf, type Identity } from '@renderer/features/account/model'
import { count, mediumAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { currentLocale } from '@renderer/lib/i18n'
import { isWeb } from '@renderer/lib/platform'
import { useAccountStore } from '@renderer/stores/account'
import { useHostScope } from '@renderer/stores/host-scope'
import type { PublishedStoreHook } from '@renderer/stores/market-published'
import { openMarketplace } from '@renderer/stores/view'
import { PublishFolderDialog, ListingDialogs, type ListingDialog } from './publish-dialogs'
import {
  convertItem,
  listingMenu,
  useConvertListing,
  useNewVersionItems,
  usePickFolder,
  usePublishedStore,
  useRelist,
  type FolderChoice,
} from './published-hooks'
import {
  askAgent,
  folderShown,
  harnessName,
  isClosed,
  isHarness,
  KETTU_ITEM,
  kindOf,
  knownSession,
  listingName,
  listingSubject,
  openKnownSession,
  publishedItem,
  refusedDraft,
  VISIBILITY_ICON,
} from './published-model'
import { KindTag, QuietNote } from './rows'
import { ItemTile } from './tiles'
import './published.css'

/** The toolbar's Publish: ask an agent in a new session, or check a folder and confirm it here. */
export function PublishMenu() {
  const { t } = useTranslation('marketplace')
  const pick = usePickFolder()
  const [folder, setFolder] = useState<FolderChoice | null>(null)
  return (
    <>
      <Dropdown
        align="end"
        className="k-mkt-add"
        items={[
          {
            label: t('published.ask'),
            description: t('published.askLine'),
            icon: Message01Icon,
            onSelect: () => askAgent(t('published.askPrompt'), null),
          },
          ...(isWeb
            ? []
            : [
                {
                  label: t('published.folder'),
                  description: t('published.folderLine'),
                  icon: Folder01Icon,
                  onSelect: () =>
                    void pick().then((path) => path && setFolder({ path, draftId: null })),
                },
              ]),
        ]}
        trigger={({ open, toggle }) => (
          <Button
            size="md"
            icon={<Icon icon={Add01Icon} size={15} />}
            aria-expanded={open}
            aria-haspopup="menu"
            onClick={toggle}
          >
            {t('published.publish')}
          </Button>
        )}
      />
      <PublishFolderDialog choice={folder} onClose={() => setFolder(null)} />
    </>
  )
}

function matches(text: (string | null | undefined)[], query: string): boolean {
  const q = query.trim().toLocaleLowerCase()
  return !q || text.some((part) => part?.toLocaleLowerCase().includes(q))
}

export function PublishedView({ query }: { query: string }) {
  const store = usePublishedStore()
  const published = store((s) => s.published)
  const error = store((s) => s.error)
  useEffect(() => {
    void store.getState().load()
  }, [store])

  if (!published) {
    return error ? <ReadFailed error={error} store={store} /> : <PublishedSkeleton />
  }
  const listings = published.mine?.listings ?? []
  const drafts = published.drafts
  if (published.mine && listings.length === 0 && drafts.length === 0) return <PublishedEmpty />
  const shownListings = listings.filter((l) =>
    matches([l.name, l.slug, l.description, listingName(l)], query),
  )
  const shownDrafts = drafts.filter((d) =>
    matches([d.manifest.name, d.manifest.slug, d.manifest.description], query),
  )
  const shownReviews = shownListings.flatMap((listing) =>
    reviewVersions(listing).map((version) => ({ listing, version })),
  )
  return (
    <>
      {(published.error ?? error) && (
        <ReadFailed error={published.error ?? error!} store={store} quiet />
      )}
      {published.mine && <PublisherCard published={published} />}
      {(shownDrafts.length > 0 || shownReviews.length > 0) && (
        <NeedsYou drafts={shownDrafts} reviews={shownReviews} listings={listings} />
      )}
      {published.mine && (
        <MineTable
          listings={shownListings}
          all={listings.length}
          drafts={drafts}
          published={published}
          query={query}
        />
      )}
    </>
  )
}

function ReadFailed({
  error,
  store,
  quiet,
}: {
  error: string
  store: PublishedStoreHook
  quiet?: boolean
}) {
  const { t } = useTranslation(['marketplace', 'common'])
  const [busy, setBusy] = useState(false)
  return (
    <div className={quiet ? 'k-mkt-notes' : 'k-mkt-notes k-pub-failed'}>
      <QuietNote
        action={
          <Button
            size="md"
            variant="ghost"
            loading={busy}
            icon={<Icon icon={RefreshIcon} size={14} />}
            onClick={() => {
              setBusy(true)
              void store
                .getState()
                .load()
                .finally(() => setBusy(false))
            }}
          >
            {t('common:actions.retry')}
          </Button>
        }
      >
        {t('published.readFailed', { error })}
      </QuietNote>
    </div>
  )
}

function PublishedSkeleton() {
  return (
    <div aria-busy className="k-pub-skeleton">
      <Skeleton className="k-pub-skeleton__card" />
      <Skeleton className="k-mkt-skeleton__title" />
      <Skeleton className="k-pub-skeleton__table" />
    </div>
  )
}

/** Who the account is: this computer's own sign-in, or another host's name and email. */
function useIdentity(account: MarketAccount): Identity {
  const { hostId } = useHostScope()
  const local = useAccountStore((s) => s.status)
  if (hostId === null && local?.state === 'signed-in') return identityOf(local)
  const name = account.name?.trim() || account.email
  return {
    signedIn: true,
    name,
    email: account.email,
    initial: name.charAt(0).toUpperCase() || null,
    avatar: null,
  }
}

function monthYear(at: string): string {
  const time = Date.parse(at)
  if (Number.isNaN(time)) return ''
  return new Intl.DateTimeFormat(currentLocale(), { month: 'short', year: 'numeric' }).format(time)
}

/** The account's picture and name, its publisher name, and its totals. */
function PublisherCard({ published }: { published: MarketPublished }) {
  const { t } = useTranslation('marketplace')
  const [editing, setEditing] = useState<ListingDialog | null>(null)
  const identity = useIdentity(published.account!)
  const mine = published.mine!
  const counted = mine.listings.filter((l) => l.visibility !== 'private')
  const installs = counted.reduce((sum, l) => sum + l.installs.total, 0)
  const week = counted.reduce((sum, l) => sum + l.installs.week, 0)
  const publisher = mine.publisher
  return (
    <div className="k-pub-me ui-as-rise">
      <AccountAvatar identity={identity} size={32} />
      <span className="k-pub-me__who">
        <b>{identity.name}</b>
        <span>
          {publisher ? (
            <>
              <span className="k-mkt-mono">@{publisher.handle}</span>
              {' · '}
              {t('published.me.since', { date: monthYear(publisher.since) })}
            </>
          ) : (
            t('published.me.noHandle')
          )}
          {' · '}
          <button
            type="button"
            className="k-pub-link"
            onClick={() => setEditing({ kind: 'profile', handle: publisher?.handle ?? '' })}
          >
            {t('published.me.editProfile')}
          </button>
        </span>
      </span>
      <span className="k-pub-me__stats">
        <span>
          <small>{t('published.me.published')}</small>
          <b>{count(mine.listings.length)}</b>
        </span>
        <span>
          <small>{t('published.me.installs')}</small>
          <b>{count(installs)}</b>
        </span>
        <span>
          <small>{t('published.me.week')}</small>
          <b>+{count(week)}</b>
        </span>
      </span>
      <ListingDialogs dialog={editing} onClose={() => setEditing(null)} />
    </div>
  )
}

/** A session's title as a link back to it, while the window still lists it. */
export function SessionLink({
  sessionId,
  title,
}: {
  sessionId: string | null | undefined
  title: string
}) {
  if (!knownSession(sessionId)) return <span className="k-pub-session">{title}</span>
  return (
    <button type="button" className="k-pub-link" onClick={() => openKnownSession(sessionId)}>
      {title}
    </button>
  )
}

interface Review {
  listing: MineListing
  version: MineVersion
}

/**
 * Drafts put off or left unanswered, versions the service refused, and versions held for review
 * or not approved.
 */
function NeedsYou({
  drafts,
  reviews,
  listings,
}: {
  drafts: PublishDraft[]
  reviews: Review[]
  listings: MineListing[]
}) {
  const { t } = useTranslation('marketplace')
  return (
    <section className="ui-as-int-section ui-as-rise">
      <h2 className="ui-as-int-section__title">{t('published.needs.title')}</h2>
      <div className="k-mkt-list k-pub-needs">
        {reviews.map(({ listing, version }) => (
          <ReviewRow key={`${listing.id}@${version.version}`} listing={listing} version={version} />
        ))}
        {drafts.map((draft) => (
          // By folder, as a refused publish keeps a new draft of it and its open dialog stays.
          <NeedRow
            key={draft.path}
            draft={draft}
            listing={listings.find((l) => l.id === draft.listingId) ?? null}
          />
        ))}
      </div>
    </section>
  )
}

/** A version that waits for review or was not approved, which its page tells more of. */
function ReviewRow({ listing, version }: Review) {
  const { t } = useTranslation('marketplace')
  const held = version.status === 'held'
  const stays = listing.current ? t('published.needs.stays', { version: listing.current }) : null
  const line = held
    ? t('published.review.heldLine', { version: version.version })
    : version.refusal?.reason
      ? t('published.review.refusedLine', {
          version: version.version,
          reason: version.refusal.reason,
        })
      : t('published.review.refusedBare', { version: version.version })
  return (
    <div className="k-pub-need">
      <ItemTile subject={listingSubject(listing)} />
      <span className="k-pub-need__text">
        <span className="k-pub-need__name">
          <b>{`${listing.name} ${version.version}`}</b>
          <KindTag kind={kindOf(listing.kind)} harness={listing.harness} />
          <ReviewPill held={held} />
        </span>
        <small data-selectable="">{line}</small>
        {stays && <small>{stays}</small>}
      </span>
      <span className="k-pub-need__act">
        <Button
          size="md"
          variant="secondary"
          onClick={() => openMarketplace({ item: publishedItem(listing.id), tab: 'published' })}
        >
          {t('published.review.open')}
        </Button>
      </span>
    </div>
  )
}

/** Waiting for review, or not approved. */
export function ReviewPill({ held }: { held: boolean }) {
  const { t } = useTranslation('marketplace')
  return held ? (
    <StatePill tone="attention">{t('published.review.waiting')}</StatePill>
  ) : (
    <StatePill tone="danger">
      <Icon icon={Alert02Icon} size={12} />
      {t('published.review.refused')}
    </StatePill>
  )
}

function NeedRow({ draft, listing }: { draft: PublishDraft; listing: MineListing | null }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const store = usePublishedStore()
  const [folder, setFolder] = useState<FolderChoice | null>(null)
  const [busy, setBusy] = useState(false)
  const { manifest } = draft
  const refused = draft.error !== null
  const agent = harnessName(manifest.agent ?? draft.agentId?.split('~')[0])
  const discard = async () => {
    setBusy(true)
    try {
      await scope.request('market.discardPublishDraft', { id: draft.id })
      toast(t('published.toast.discarded', { name: manifest.name }))
      await store.getState().load()
    } catch (error) {
      toast(errorMessage(error), undefined, { tone: 'warning' })
    } finally {
      setBusy(false)
    }
  }
  const review = () => setFolder({ path: draft.path, draftId: draft.id })
  const problem = draft.problems[0]
  const line = refused ? (
    <small data-selectable="">
      {[
        draft.error,
        problem
          ? problem.path
            ? `${problem.path}: ${problem.text ?? problem.message}`
            : (problem.text ?? problem.message)
          : null,
        listing?.current ? t('published.needs.stays', { version: listing.current }) : null,
      ]
        .filter(Boolean)
        .join(' ')}
    </small>
  ) : (
    <small className="k-pub-need__by">
      {isHarness(manifest.agent) && <AgentMark agent={manifest.agent} size={12} dot={null} />}
      <span>
        {agent && draft.sessionTitle ? (
          <Trans
            t={t}
            i18nKey="published.needs.asked"
            values={{ agent, version: manifest.version, session: draft.sessionTitle }}
            components={{
              ref: <SessionLink sessionId={draft.sessionId} title={draft.sessionTitle} />,
            }}
          />
        ) : agent ? (
          t('published.needs.askedNoSession', { agent, version: manifest.version })
        ) : (
          t('published.needs.kept', {
            version: manifest.version,
            folder: folderShown(scope.hostId, draft.path).path,
          })
        )}
      </span>
    </small>
  )
  return (
    <div className="k-pub-need">
      <ItemTile subject={listingSubject({ ...manifest, id: draft.listingId })} />
      <span className="k-pub-need__text">
        <span className="k-pub-need__name">
          <b>{refused ? `${manifest.name} ${manifest.version}` : manifest.name}</b>
          <KindTag kind={kindOf(manifest.kind)} harness={manifest.harness} />
          {refused ? (
            <span className="k-pub-state" data-tone="danger">
              <Icon icon={Alert02Icon} size={12} />
              {t('published.needs.needsFix')}
            </span>
          ) : (
            <span className="k-pub-state">{t('published.needs.notPublished')}</span>
          )}
        </span>
        {line}
      </span>
      <span className="k-pub-need__act">
        <Button size="md" variant="secondary" loading={busy} onClick={() => void discard()}>
          {refused
            ? t('published.needs.withdraw', { version: manifest.version })
            : t('published.needs.discard')}
        </Button>
        {!isWeb && (
          <Button size="md" onClick={review}>
            {refused ? t('published.needs.checkAgain') : t('published.needs.review')}
          </Button>
        )}
      </span>
      <PublishFolderDialog choice={folder} onClose={() => setFolder(null)} />
    </div>
  )
}

export function Visibility({
  listing,
}: {
  listing: Pick<MineListing, 'visibility' | 'takenDown'>
}) {
  const { t } = useTranslation('marketplace')
  if (listing.takenDown) {
    return (
      <span className="k-pub-vis" data-v="taken-down">
        <Icon icon={Alert02Icon} size={13} />
        {t('published.visibility.takenDown')}
      </span>
    )
  }
  return (
    <span className="k-pub-vis" data-v={listing.visibility}>
      <Icon icon={VISIBILITY_ICON[listing.visibility]} size={13} />
      {t(`published.visibility.${listing.visibility}`)}
    </span>
  )
}

/** The table of what the account published; a row opens its page. */
function MineTable({
  listings,
  all,
  drafts,
  published,
  query,
}: {
  listings: MineListing[]
  all: number
  drafts: PublishDraft[]
  published: MarketPublished
  query: string
}) {
  const { t } = useTranslation('marketplace')
  return (
    <section className="ui-as-int-section ui-as-rise" style={{ '--i': 1 } as CSSProperties}>
      <h2 className="ui-as-int-section__title">
        {t('published.table.title')}
        <span className="k-mkt-count">{all}</span>
      </h2>
      {listings.length === 0 ? (
        <p className="k-mkt-section-note">{t('published.table.noMatch', { query })}</p>
      ) : (
        <div
          className="k-mkt-list k-pub-table"
          role="table"
          aria-label={t('published.table.label')}
        >
          <div className="k-pub-tr" role="row" data-head="">
            <span role="columnheader">{t('published.table.name')}</span>
            <span role="columnheader">{t('published.table.visibleTo')}</span>
            <span role="columnheader">{t('published.table.version')}</span>
            <span role="columnheader" className="k-pub-num">
              {t('published.table.installs')}
            </span>
            <span role="columnheader">{t('published.table.updated')}</span>
            <span role="columnheader" />
          </div>
          {listings.map((listing) => (
            <MineRow
              key={listing.id}
              listing={listing}
              refused={refusedDraft(drafts, listing.id)}
              published={published}
            />
          ))}
        </div>
      )}
      <p className="k-pub-foot">
        {t('published.foot')}{' '}
        <button
          type="button"
          className="k-pub-link"
          onClick={() => openMarketplace({ item: KETTU_ITEM, tab: 'published' })}
        >
          {t('published.seeTools')}
        </button>
      </p>
    </section>
  )
}

function MineRow({
  listing,
  refused,
  published,
}: {
  listing: MineListing
  refused: PublishDraft | null
  published: MarketPublished
}) {
  const { t } = useTranslation('marketplace')
  const [dialog, setDialog] = useState<ListingDialog | null>(null)
  const [folder, setFolder] = useState<FolderChoice | null>(null)
  const relist = useRelist()
  const versionItems = useNewVersionItems(listing, published, setFolder)
  const { convert, converting } = useConvertListing(setFolder)
  const open = () => openMarketplace({ item: publishedItem(listing.id), tab: 'published' })
  const updated = Date.parse(listing.updatedAt)
  const review = reviewVersions(listing)[0] ?? null
  const reviewTitle = review
    ? t(review.status === 'held' ? 'published.table.waiting' : 'published.table.refused', {
        version: review.version,
      })
    : ''
  const [details, ...rest] = listingMenu(listing, t, setDialog, () => relist(listing))
  // New version's two ways sit under a heading, as a submenu would open past the window's edge.
  const items: MenuItem[] = [
    ...(listing.takenDown
      ? []
      : isClosed(listing)
        ? [convertItem(t, () => convert(listing), converting)]
        : [{ label: t('published.menu.newVersionHeading'), heading: true }, ...versionItems]),
    { ...details!, divider: !listing.takenDown },
    ...rest,
  ]
  // The dialogs sit outside the row, whose click opens the page: a portal's clicks bubble to it.
  return (
    <>
      <div
        className="k-pub-tr"
        role="row"
        data-dim={listing.visibility === 'unlisted' || listing.takenDown ? '' : undefined}
        onClick={open}
      >
        <span role="cell" className="k-pub-td-name">
          <ItemTile subject={listingSubject(listing)} />
          <span>
            <span className="k-pub-td-name__top">
              <button
                type="button"
                className="k-pub-open"
                onClick={(event) => {
                  event.stopPropagation()
                  open()
                }}
              >
                {listing.name}
              </button>
              <KindTag kind={kindOf(listing.kind)} harness={listing.harness} />
            </span>
            {listing.description && (
              <small title={listing.description}>{listing.description}</small>
            )}
          </span>
        </span>
        <span role="cell">
          <Visibility listing={listing} />
        </span>
        <span role="cell" className="k-mkt-mono k-pub-ver">
          {listing.current ?? '–'}
          {refused ? (
            <i
              className="k-pub-dot"
              data-tone="danger"
              title={t('published.table.needsFix', { version: refused.manifest.version })}
              aria-label={t('published.table.needsFix', { version: refused.manifest.version })}
            />
          ) : (
            review && (
              <i
                className="k-pub-dot"
                data-tone={review.status === 'held' ? 'attention' : 'danger'}
                title={reviewTitle}
                aria-label={reviewTitle}
              />
            )
          )}
        </span>
        <span role="cell" className="k-pub-num">
          {listing.visibility === 'private' ? (
            <span className="k-pub-faint">{t('published.table.yourComputers')}</span>
          ) : (
            <>
              <b>{count(listing.installs.total)}</b>
              <small>
                {listing.installs.week > 0
                  ? t('published.table.week', { count: listing.installs.week })
                  : t('published.table.noNew')}
              </small>
            </>
          )}
        </span>
        <span role="cell" className="k-pub-faint">
          {Number.isNaN(updated) ? '' : mediumAgo(updated)}
        </span>
        <span role="cell" onClick={(event) => event.stopPropagation()}>
          <MoreMenu label={t('published.table.more', { name: listing.name })} items={items} />
        </span>
      </div>
      <ListingDialogs dialog={dialog} onClose={() => setDialog(null)} />
      <PublishFolderDialog choice={folder} onClose={() => setFolder(null)} />
    </>
  )
}

/** The ⋯ button and its menu. */
export function MoreMenu({ label, items }: { label: string; items: MenuItem[] }) {
  return (
    <Dropdown
      align="end"
      className="k-mkt-add"
      items={items}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className="k-mkt-icon-btn"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={toggle}
        >
          <Icon icon={MoreHorizontalIcon} size={16} />
        </button>
      )}
    />
  )
}

/** Nothing published yet: how to, a message to start a session with, and a folder of one's own. */
function PublishedEmpty() {
  const { t } = useTranslation('marketplace')
  const pick = usePickFolder()
  const [folder, setFolder] = useState<FolderChoice | null>(null)
  const prompt = t('published.askPrompt')
  const facts: [typeof Store01Icon, string, string][] = [
    [VISIBILITY_ICON.public, t('published.empty.who'), t('published.empty.whoLine')],
    [Tick02Icon, t('published.empty.checked'), t('published.empty.checkedLine')],
    [Note01Icon, t('published.empty.versions'), t('published.empty.versionsLine')],
  ]
  return (
    <div className="k-pub-empty ui-as-rise">
      <span className="k-pub-empty__mark" aria-hidden>
        <Icon icon={Store01Icon} size={20} />
      </span>
      <b>{t('published.empty.title')}</b>
      <p>{t('published.empty.text')}</p>
      <div className="k-pub-empty__try">
        <span className="k-pub-empty__prompt" title={prompt}>
          {prompt}
        </span>
        <Button size="md" onClick={() => askAgent(prompt, null)}>
          {t('published.empty.start')}
        </Button>
      </div>
      {!isWeb && (
        <span className="k-pub-empty__or">
          <Trans
            t={t}
            i18nKey="published.empty.or"
            components={{
              ref: (
                <button
                  type="button"
                  className="k-pub-link"
                  onClick={() =>
                    void pick().then((path) => path && setFolder({ path, draftId: null }))
                  }
                />
              ),
            }}
          />
        </span>
      )}
      <div className="k-pub-empty__facts">
        {facts.map(([icon, title, line]) => (
          <span key={title}>
            <Icon icon={icon} size={15} />
            <b>{title}</b>
            <small>{line}</small>
          </span>
        ))}
      </div>
      <PublishFolderDialog choice={folder} onClose={() => setFolder(null)} />
    </div>
  )
}

/** A state pill, such as Listed or Not published. */
export function StatePill({
  tone,
  children,
}: {
  tone?: 'success' | 'danger' | 'attention'
  children: ReactNode
}) {
  return (
    <span className="k-pub-state" data-tone={tone}>
      {children}
    </span>
  )
}
