import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  Delete02Icon,
  File01Icon,
  Folder01Icon,
  Search01Icon,
  SlidersHorizontalIcon,
  Upload04Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { NO_SESSION, type ArtifactSummary } from '@shared/artifacts'
import type { AgentId } from '@shared/thread'
import {
  Dropdown,
  FilterButton,
  FolderClosedMark,
  Icon,
  SearchField,
  SectionHead,
  Tabs,
} from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Notice } from '@renderer/features/routines/kit'
import { basename, longAgo } from '@renderer/lib/format'
import { useHostContext } from '@renderer/lib/host-features'
import { hostOfPath } from '@renderer/lib/host-paths'
import { artifactHost } from '@renderer/lib/host'
import { NO_PROJECT_ICON } from '@renderer/features/shell/no-project-icon'
import { AwayContent, WindowHostAway } from '@renderer/features/shell/window-host-away'
import { useHostName, useNamesHosts, useWindowHost } from '@renderer/stores/window-host'
import { useWindowArtifacts } from './window-artifacts'
import { isMac, isMod, isWeb } from '@renderer/lib/platform'
import { useNow } from '@renderer/lib/use-now'
import { agentName, useAgentsStore } from '@renderer/stores/agents'
import {
  artifactListShown,
  dismissImportFailure,
  importArtifact,
  retryArtifacts,
  setArtifactsAgentFilter,
  setArtifactsFilter,
  setArtifactsKindFilter,
  setArtifactsOnlyChanged,
  setArtifactsProjectFilter,
  setArtifactsStatusFilter,
  useArtifactsStore,
  type ImportFailure,
} from '@renderer/stores/artifacts'
import { useProjectsStore } from '@renderer/stores/projects'
import { localSharing } from '@renderer/stores/sharing'
import { useSessionsStore } from '@renderer/stores/sessions'
import { openArtifact, setArtifactsView, useViewStore } from '@renderer/stores/view'
import { artifactSharing } from './artifact-host'
import { ArtifactCard, CardSkeleton } from './artifact-card'
import type { OpenAt } from './artifact-tile'
import { askForArtifact } from './ask'
import { growInto, shrinkFrom } from './glide'
import { isEditable } from './keys'
import { KIND_ICON } from './kinds'
import {
  agentsOf,
  ARRANGEMENTS,
  ARTIFACT_KINDS,
  ARTIFACT_STATUSES,
  artifactKind,
  filterArtifacts,
  groupArtifacts,
  NO_PROJECT,
  projectsOf,
  type ArtifactArrange,
  type ArtifactKind,
  type ArtifactStatus,
  type Group,
} from './model'
import { KindSketch } from './sketch'
import { readWaitingReplies, useWaitingCounts } from './waiting-replies'
import './artifacts.css'

interface SessionInfo {
  title: string | null
  updatedAt: number
  projectPath: string
  agentId: AgentId
}

/** Where the list was scrolled when the viewer opened, for Back. */
let scrolledTo = 0

/** The area the viewer takes, which the page's own scroller covers. */
function viewerArea(): DOMRect | null {
  return document.querySelector<HTMLElement>('.k-arts-scroll')?.getBoundingClientRect() ?? null
}

function pageOf(id: string): HTMLElement | null {
  return (
    document
      .querySelector(`[data-artifact-card="${CSS.escape(id)}"]`)
      ?.querySelector<HTMLElement>('.k-art__page') ?? null
  )
}

/** Opens the viewer from a card, its page growing into it; Back returns to the card. */
function openFromPage(id: string, { history = false, at }: { history?: boolean; at?: OpenAt }) {
  useArtifactsStore.setState({ opened: id })
  growInto(pageOf(id), viewerArea(), () =>
    openArtifact(id, { history, page: at?.page, slide: at?.slide }),
  )
}

/** In the tooltip only, so it reads the time as it opens. */
function VersionTime({ artifact }: { artifact: ArtifactSummary }) {
  const { t } = useTranslation('artifacts')
  const now = useNow()
  return (
    <span>
      {t('card.when', { version: artifact.version, time: longAgo(artifact.updatedAt, now) })}
    </span>
  )
}

/** Changed since the owner last opened it, on a host that keeps that; never while being written. */
function isUnseen(artifact: ArtifactSummary): boolean {
  const seen = artifact.seen
  return (
    seen !== undefined &&
    artifact.deletedAt === null &&
    artifact.editing.length === 0 &&
    (seen === null || seen < artifact.version)
  )
}

/** Published so that someone else can open it, by its code or its link. */
function isPublished(id: string): boolean {
  const pages = artifactSharing(id).useSharingStore.getState().status?.published ?? []
  return pages.some(
    (page) => page.id === id && (page.access === 'public' || page.access === 'code'),
  )
}

/**
 * Every artifact as a card, the most recently opened first or as the user arranges them, under
 * its search and filters, with what changed since the user last opened it; Recently deleted is a
 * row at the foot, open with `deleted`.
 */
export default function ArtifactsPage({ deleted }: { deleted: boolean }) {
  const { t, i18n } = useTranslation(['artifacts', 'common'])
  const { list, deleted: trash, away, read } = useWindowArtifacts()
  const windowHost = useWindowHost()
  const namesHosts = useNamesHosts()
  const hostName = useHostName()
  // Every host side by side: each card of another host says which one it is on.
  const hostOf = (id: string): string | null => {
    const hostId = artifactHost(id)
    return namesHosts && windowHost.kind === 'all' && hostId !== null ? hostName(hostId) : null
  }
  const error = useArtifactsStore((s) => s.error)
  const filter = useArtifactsStore((s) => s.filter)
  const kindFilter = useArtifactsStore((s) => s.kindFilter)
  const projectFilter = useArtifactsStore((s) => s.projectFilter)
  const agentFilter = useArtifactsStore((s) => s.agentFilter)
  const statusFilter = useArtifactsStore((s) => s.statusFilter)
  const onlyChanged = useArtifactsStore((s) => s.onlyChanged)
  const openedAt = useArtifactsStore((s) => s.openedAt)
  const importFailed = useArtifactsStore((s) => s.importFailed)
  const arrange = useViewStore((s) => s.artifactsView.arrange)
  const projects = useProjectsStore((s) => s.projects)
  const sessions = useSessionInfo(list, trash)
  const scroller = useRef<HTMLDivElement>(null)
  const bin = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState<string | null>(null)
  const [binOpen, setBinOpen] = useState(deleted)
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set())
  const replies = useWaitingCounts()
  // Published pages change what the filter keeps; this computer's are read here.
  const published = localSharing.useSharingStore((s) => s.status?.published)

  useEffect(() => {
    artifactListShown(true)
    return () => artifactListShown(false)
  }, [])

  // Recently deleted from elsewhere, such as Back to it: open, and in view.
  const [deletedWas, setDeletedWas] = useState(deleted)
  if (deleted !== deletedWas) {
    setDeletedWas(deleted)
    if (deleted) setBinOpen(true)
  }
  useEffect(() => {
    if (!deleted) return
    requestAnimationFrame(() => bin.current?.scrollIntoView({ block: 'start' }))
  }, [deleted])

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.defaultPrevented || useViewStore.getState().settings.open) return
      // Not while a menu or tooltip of the page takes the key.
      const onPage =
        event.target === document.body || scroller.current?.contains(event.target as Node)
      if (isMod(event) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        const field = scroller.current?.querySelector<HTMLInputElement>('.ui-as-search input')
        field?.focus()
        field?.select()
      } else if (
        event.key === 'Escape' &&
        useArtifactsStore.getState().filter &&
        onPage &&
        !isEditable(event.target)
      ) {
        event.preventDefault()
        setArtifactsFilter('')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Back from the viewer: the same scroll, the card it opened focused, its page shrinking into it.
  const ready = list !== null
  useLayoutEffect(() => {
    const view = scroller.current
    if (!view) return
    const { opened } = useArtifactsStore.getState()
    if (!ready || !opened) {
      if (!deleted) view.scrollTop = 0
      return
    }
    view.scrollTop = scrolledTo
    const card = view.querySelector<HTMLElement>(`[data-artifact-card="${CSS.escape(opened)}"]`)
    // Its focus event makes it the cards' Tab stop.
    card?.focus({ preventScroll: true })
    shrinkFrom(
      card?.querySelector<HTMLElement>('.k-art__page') ?? null,
      view.getBoundingClientRect(),
    )
    useArtifactsStore.setState({ opened: null })
  }, [ready, deleted])

  // Needs your reply counts every artifact once it is picked; cards in view count their own.
  const wantsReplies = statusFilter.includes('reply')
  useEffect(() => {
    if (wantsReplies && list) readWaitingReplies(list.map((a) => a.id))
  }, [wantsReplies, list])

  const collator = useMemo(
    () => new Intl.Collator(i18n.language, { numeric: true, sensitivity: 'base' }),
    [i18n.language],
  )
  const agentOf = useMemo(() => {
    return (id: string): AgentId | null => sessions.get(id)?.agentId ?? null
  }, [sessions])
  const hasStatus = useMemo(
    () =>
      (artifact: ArtifactSummary, status: ArtifactStatus): boolean =>
        status === 'updated'
          ? isUnseen(artifact)
          : status === 'reply'
            ? (replies.get(artifact.id) ?? 0) > 0
            : isPublished(artifact.id),
    // Published pages are read when the filter runs; this keeps it in step with them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [replies, published],
  )
  // The search's count is out of what the other filters keep.
  const filtered = useMemo(
    () =>
      list
        ? filterArtifacts(list, {
            title: '',
            kind: kindFilter,
            project: projectFilter,
            agent: agentFilter,
            agentOf,
            status: statusFilter,
            hasStatus,
          }).filter((artifact) => !onlyChanged || isUnseen(artifact))
        : [],
    [list, kindFilter, projectFilter, agentFilter, agentOf, statusFilter, hasStatus, onlyChanged],
  )
  const shown = useMemo(
    () =>
      filter.trim()
        ? filterArtifacts(filtered, { title: filter, kind: null, project: [] })
        : filtered,
    [filtered, filter],
  )
  const groups = useMemo(
    () => groupArtifacts(shown, arrange, { projects, collator, opened: openedAt }),
    [shown, arrange, projects, collator, openedAt],
  )
  const changedCount = useMemo(() => (list ? list.filter(isUnseen).length : 0), [list])

  const projectName = (artifact: ArtifactSummary): string =>
    artifact.scratch
      ? t('page.noProject')
      : (projects.find((p) => p.path === artifact.project)?.name ?? basename(artifact.project))
  const sessionName = (id: string): string => {
    if (id === NO_SESSION) return t('page.imported')
    const info = sessions.get(id)
    if (!info) return t('page.deletedSession')
    return info.title ?? t('common:untitledSession')
  }
  // The time the line ends with: when it was opened here or written, whichever is later.
  const timeOf = (artifact: ArtifactSummary): number => {
    const opened = openedAt[artifact.id] ?? 0
    return opened > artifact.updatedAt ? opened : artifact.updatedAt
  }
  const query = filter.trim()
  const card = (artifact: ArtifactSummary, tabbable: string | null, i: number) => (
    <div
      key={artifact.id}
      className="k-arts__cell"
      style={{ '--i': Math.min(i, 8) } as CSSProperties}
    >
      <ArtifactCard
        id={artifact.id}
        title={artifact.title}
        summary={artifact}
        standing={artifact.deletedAt === null ? 'live' : 'deleted'}
        form="tile"
        still={artifact.version}
        agent={agentOf(artifact.sessionId)}
        agentHost={hostOfPath(sessions.get(artifact.sessionId)?.projectPath ?? '')}
        what={t('card.kindVersion', {
          kind: t(`page.kinds.${artifactKind(artifact)}`),
          version: artifact.version,
        })}
        at={timeOf(artifact)}
        host={hostOf(artifact.id)}
        current
        onOpen={(at) => openFromPage(artifact.id, { at })}
        menu={{
          onOpen: () => openFromPage(artifact.id, {}),
          onVersionHistory: () => openFromPage(artifact.id, { history: true }),
        }}
        page={{
          tabbable: artifact.id === tabbable,
          query,
          tip: (
            <>
              <span>{projectName(artifact)}</span>
              <span>{sessionName(artifact.sessionId)}</span>
              <VersionTime artifact={artifact} />
            </>
          ),
        }}
      />
    </div>
  )
  const cardsProps = {
    onKeyDown: moveCardFocus,
    onFocus: (event: React.FocusEvent) => {
      const id = (event.target as HTMLElement).dataset.artifactCard
      if (id) setActive(id)
    },
  }
  const clearFilters = () => {
    setArtifactsFilter('')
    setArtifactsKindFilter(null)
    setArtifactsProjectFilter([])
    setArtifactsAgentFilter([])
    setArtifactsStatusFilter([])
    setArtifactsOnlyChanged(false)
  }

  const projectChoices = useMemo(
    () => (list ? projectsOf(list, { projects, collator }) : []),
    [list, projects, collator],
  )
  const agentChoices = useAgentChoices(list, agentOf)
  const filterGroups = [
    {
      id: 'agent',
      label: t('page.agent'),
      options: agentChoices.map((id) => ({ id, label: agentName(id) })),
    },
    {
      id: 'project',
      label: t('page.project'),
      options: projectChoices.map((of) =>
        of.kind === 'project'
          ? { id: of.path, label: of.name }
          : { id: NO_PROJECT, label: t('page.noProject') },
      ),
    },
    {
      id: 'status',
      label: t('page.status'),
      options: ARTIFACT_STATUSES.map((id) => ({ id, label: t(`page.statuses.${id}`) })),
    },
  ]
  const chips = filterGroups.flatMap((group) => {
    const picked: readonly string[] =
      group.id === 'agent' ? agentFilter : group.id === 'project' ? projectFilter : statusFilter
    return group.options
      .filter((option) => picked.includes(option.id))
      .map((option) => ({ group, option }))
  })
  const removeChip = (group: string, id: string) => {
    if (group === 'agent') setArtifactsAgentFilter(agentFilter.filter((a) => a !== id))
    else if (group === 'project') setArtifactsProjectFilter(projectFilter.filter((p) => p !== id))
    else setArtifactsStatusFilter(statusFilter.filter((s) => s !== id))
  }

  let body: ReactNode
  const cards = groups.flatMap((g) => (folded.has(g.key) ? [] : g.artifacts))
  const tabbable = cards.some((a) => a.id === active) ? active : (cards[0]?.id ?? null)
  const any = list !== null && list.length > 0
  const binTabbable = trash?.some((a) => a.id === active) ? active : (trash?.[0]?.id ?? null)
  if (away && !read) body = null
  else if (list === null && error) body = <ListError error={error} />
  else if (list === null) body = <LoadingList />
  else if (list.length === 0) body = away ? null : <NoArtifacts />
  else if (shown.length === 0) body = <NoMatch query={filter} onClear={clearFilters} />
  else {
    let i = 0
    body = (
      <>
        {error && <ListError error={error} />}
        <div {...cardsProps} className="k-arts__cards">
          {groups.map((g) =>
            g.of.kind === 'all' ? (
              <div key={g.key} className="k-arts__grid">
                {g.artifacts.map((artifact) => card(artifact, tabbable, i++))}
              </div>
            ) : (
              <GroupView
                key={g.key}
                group={g}
                info={g.of.kind === 'session' ? sessions.get(g.of.sessionId) : undefined}
                projectName={(path) =>
                  projects.find((p) => p.path === path)?.name ?? basename(path)
                }
                folded={folded.has(g.key)}
                onFold={() =>
                  setFolded((was) => {
                    const next = new Set(was)
                    if (next.has(g.key)) next.delete(g.key)
                    else next.add(g.key)
                    return next
                  })
                }
              >
                {g.artifacts.map((artifact) => card(artifact, tabbable, i++))}
              </GroupView>
            ),
          )}
        </div>
      </>
    )
  }

  const kindTabs = [ALL, ...ARTIFACT_KINDS] as const
  const tabLabel = (kind: (typeof kindTabs)[number]) =>
    kind === ALL ? t('page.allKinds') : t(`page.kindsPlural.${kind}`)
  const strip = !query && changedCount > 0 && !statusFilter.includes('updated')

  return (
    <div
      ref={scroller}
      onScroll={(event) => (scrolledTo = event.currentTarget.scrollTop)}
      className="k-arts-scroll"
    >
      <div aria-hidden className="k-arts-drag app-region-drag" />
      <div className="ui-as-page k-arts">
        <h1 className="ui-as-page-title">{t('page.title')}</h1>
        <p className="ui-as-page-sub">
          {!namesHosts
            ? t('page.description')
            : windowHost.kind === 'all'
              ? t('page.descriptionAll')
              : windowHost.hostId === null
                ? t(isMac ? 'page.descriptionThisMac' : 'page.descriptionThisComputer')
                : t('page.descriptionOn', { host: hostName(windowHost.hostId) })}
        </p>
        {any && <MakeRow />}
        {any && (
          <SectionHead
            title={t('page.title')}
            count={shown.length}
            left={
              <Tabs
                items={kindTabs.map(tabLabel)}
                value={tabLabel(kindFilter ?? ALL)}
                onChange={(label) =>
                  setArtifactsKindFilter(
                    ARTIFACT_KINDS.find((kind) => tabLabel(kind) === label) ?? null,
                  )
                }
              />
            }
            right={
              <>
                <FilterButton
                  label={t('page.filterLabel')}
                  groups={filterGroups}
                  value={{
                    agent: [...agentFilter],
                    project: [...projectFilter],
                    status: [...statusFilter],
                  }}
                  onChange={(value) => {
                    setArtifactsAgentFilter(agentChoices.filter((id) => value.agent?.includes(id)))
                    setArtifactsProjectFilter(value.project ?? [])
                    setArtifactsStatusFilter(
                      ARTIFACT_STATUSES.filter((s) => value.status?.includes(s)),
                    )
                  }}
                />
                <ArrangeMenu arrange={arrange} />
                <SearchField
                  placeholder={t('page.filter')}
                  width={172}
                  value={filter}
                  onChange={setArtifactsFilter}
                />
                {!isWeb && <ImportMenu />}
              </>
            }
          />
        )}
        {any && chips.length > 0 && (
          <div className="k-arts__chips">
            {chips.map(({ group, option }) => (
              <span key={`${group.id}:${option.id}`} className="k-arts__chip">
                <span className="k-arts__chip-group">{group.label}</span>
                {option.label}
                <button
                  type="button"
                  aria-label={t('page.removeFilter', { value: option.label })}
                  onClick={() => removeChip(group.id, option.id)}
                >
                  <Icon icon={Cancel01Icon} size={11} />
                </button>
              </span>
            ))}
            <button
              type="button"
              className="k-arts__link"
              onClick={() => {
                setArtifactsAgentFilter([])
                setArtifactsProjectFilter([])
                setArtifactsStatusFilter([])
              }}
            >
              {t('page.clearAll')}
            </button>
          </div>
        )}
        {any && query && (
          <p className="k-arts__line" aria-live="polite">
            {t('page.matchCount', { shown: shown.length, count: filtered.length, query })}
          </p>
        )}
        {any && strip && (
          <p className="k-arts__line" key={onlyChanged ? 'only' : 'all'}>
            <i className="k-art__dot" aria-hidden />
            {onlyChanged
              ? t('page.showingChanged', { count: changedCount })
              : t('page.changedLine', { count: changedCount })}
            <button
              type="button"
              className="k-arts__link"
              onClick={() => setArtifactsOnlyChanged(!onlyChanged)}
            >
              {onlyChanged ? t('page.showAll') : t('page.showChanged')}
            </button>
          </p>
        )}
        {importFailed && <ImportError failure={importFailed} />}
        <WindowHostAway read={read} className="mt-4" />
        <AwayContent away={away}>{body}</AwayContent>
        {list !== null && trash !== null && trash.length > 0 && (
          <div ref={bin} className="k-arts__bin-box" data-open={binOpen || undefined}>
            <button
              type="button"
              className="k-arts__bin"
              aria-expanded={binOpen}
              onClick={() => setBinOpen((open) => !open)}
            >
              <Icon icon={Delete02Icon} size={14} />
              {t('page.recentlyDeleted')}
              <span className="k-num">{trash.length}</span>
              <span className="k-arts__bin-chevron">
                <Icon icon={ArrowRight01Icon} size={13} />
              </span>
            </button>
            {binOpen && (
              <div className="k-arts__bin-body">
                <p className="k-arts__bin-note">{t('page.deletedNote')}</p>
                <div {...cardsProps} className="k-arts__grid">
                  {trash.map((artifact, i) => card(artifact, binTabbable, i))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** A project's or a session's heading, which folds its cards, over them. */
function GroupView({
  group,
  info,
  projectName,
  folded,
  onFold,
  children,
}: {
  group: Group
  info: SessionInfo | undefined
  projectName: (path: string) => string
  folded: boolean
  onFold: () => void
  children: ReactNode
}) {
  const { t } = useTranslation(['artifacts', 'common'])
  const of = group.of
  let mark: ReactNode
  let label: string
  let where: string | null = null
  if (of.kind === 'project') {
    mark = <FolderClosedMark />
    label = of.name
  } else if (of.kind === 'no-project') {
    mark = <Icon icon={NO_PROJECT_ICON} size={16} />
    label = t('page.noProject')
  } else if (of.kind === 'session') {
    mark = info ? (
      <AgentMark agent={info.agentId} size={14} hostId={hostOfPath(info.projectPath)} />
    ) : null
    label =
      of.sessionId === NO_SESSION
        ? t('page.imported')
        : info
          ? (info.title ?? t('common:untitledSession'))
          : t('page.deletedSession')
    where = info ? projectName(info.projectPath) : null
  } else {
    return children
  }
  return (
    <section aria-label={label} className="k-arts__group" data-folded={folded || undefined}>
      <button type="button" className="k-arts__group-head" aria-expanded={!folded} onClick={onFold}>
        {mark}
        <span className="k-arts__group-name">{label}</span>
        <small className="k-num">{group.artifacts.length}</small>
        {where && <small className="k-arts__group-where">{where}</small>}
        <span className="k-arts__group-fold">
          <Icon icon={ArrowDown01Icon} size={13} />
        </span>
      </button>
      <div className="k-arts__group-body">
        <div className="k-arts__group-inner">
          {!folded && <div className="k-arts__grid">{children}</div>}
        </div>
      </div>
    </section>
  )
}

const ALL = 'all'

/** The agents whose sessions made the artifacts, in the sidebar's order. */
function useAgentChoices(
  list: ArtifactSummary[] | null,
  agentOf: (sessionId: string) => AgentId | null,
): AgentId[] {
  const order = useAgentsStore((s) => s.order)
  return useMemo(() => (list ? agentsOf(list, agentOf, order) : []), [list, agentOf, order])
}

/** Recent, By project, By session or Name, named on its button. */
function ArrangeMenu({ arrange }: { arrange: ArtifactArrange }) {
  const { t } = useTranslation('artifacts')
  return (
    <Dropdown
      align="end"
      className="k-arts__menu"
      items={[
        { label: t('page.arrange'), heading: true },
        ...ARRANGEMENTS.map((a) => ({
          label: t(`page.arrangements.${a}`),
          checked: a === arrange,
          onSelect: () => setArtifactsView({ arrange: a }),
        })),
      ]}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className="ui-as-tool ui-as-tool--label"
          aria-label={t('page.arrangeMenu', { value: t(`page.arrangements.${arrange}`) })}
          aria-expanded={open}
          aria-haspopup="menu"
          data-active={arrange !== 'recent' || undefined}
          onClick={toggle}
        >
          <Icon icon={SlidersHorizontalIcon} size={15} />
          {t(`page.arrangements.${arrange}`)}
        </button>
      )}
    />
  )
}

/** One tile for each kind, which opens New session asking for it. */
function MakeRow() {
  const { t } = useTranslation('artifacts')
  return (
    <div className="k-arts__make">
      <span className="k-arts__make-label">{t('page.askLabel')}</span>
      <div className="k-arts__make-row">
        {ARTIFACT_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            className="k-arts__make-tile"
            data-kind={kind}
            onClick={() => askForArtifact(kind)}
          >
            <span className="k-arts__make-mark">
              <Icon icon={KIND_ICON[kind]} size={15} />
            </span>
            <span className="k-arts__make-text">
              <b>{t(`page.askKinds.${kind}.name`)}</b>
              <small>{t(`page.askKinds.${kind}.line`)}</small>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** No artifacts yet: the four kinds fill the page, each a card that asks an agent for one. */
function NoArtifacts() {
  const { t } = useTranslation('artifacts')
  return (
    <div className="k-arts__empty">
      <h2>{t('page.askLabel')}</h2>
      <p>{t('page.askHint')}</p>
      <div className="k-arts__empty-grid">
        {ARTIFACT_KINDS.map((kind: ArtifactKind, i) => (
          <div
            key={kind}
            className="k-art k-arts__cell"
            data-kind={kind}
            data-form="tile"
            style={{ '--i': i } as CSSProperties}
          >
            <button type="button" className="k-art__open" onClick={() => askForArtifact(kind)}>
              <span className="k-art__head">
                <b className="k-art__name k-arts__empty-name">
                  <span className="k-arts__make-mark" data-kind={kind}>
                    <Icon icon={KIND_ICON[kind]} size={13} />
                  </span>
                  {t(`page.askKinds.${kind}.name`)}
                </b>
                <span className="ui-as-meta k-art__meta">
                  <span>{t(`page.askKinds.${kind}.line`)}</span>
                </span>
              </span>
              <span className="k-art__panel">
                <span aria-hidden className="k-art__glow">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="k-art__page">
                  <KindSketch kind={kind} title={t(`page.askKinds.${kind}.name`)} />
                </span>
              </span>
            </button>
          </div>
        ))}
      </div>
      {!isWeb && (
        <div className="k-arts__empty-import">
          <span>{t('page.importLine')}</span>
          <ImportMenu
            align="start"
            trigger={
              <Button size="md" variant="secondary" icon={<Icon icon={Upload04Icon} size={14} />}>
                {t('page.importEllipsis')}
              </Button>
            }
          />
        </div>
      )}
    </div>
  )
}

/**
 * The cards are one Tab stop: `←` `→` move through them in reading order, `↑` `↓` to the nearest
 * card in the row above or below, `Home` and `End` to the first and last.
 */
function moveCardFocus(event: KeyboardEvent<HTMLElement>): void {
  const from = event.target as HTMLElement
  if (!from.dataset.artifactCard || event.altKey || event.metaKey || event.ctrlKey) return
  const cards = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>('[data-artifact-card]'),
  )
  const at = cards.indexOf(from)
  let to: HTMLElement | undefined
  switch (event.key) {
    case 'ArrowLeft':
      to = cards[at - 1]
      break
    case 'ArrowRight':
      to = cards[at + 1]
      break
    case 'Home':
      to = cards[0]
      break
    case 'End':
      to = cards.at(-1)
      break
    case 'ArrowUp':
    case 'ArrowDown':
      to = nearestInNextRow(cards, from, event.key === 'ArrowUp' ? -1 : 1)
      break
    default:
      return
  }
  event.preventDefault()
  to?.focus()
}

function nearestInNextRow(
  cards: HTMLElement[],
  from: HTMLElement,
  direction: -1 | 1,
): HTMLElement | undefined {
  const origin = from.getBoundingClientRect()
  const centre = origin.left + origin.width / 2
  let row: number | null = null
  let best: { card: HTMLElement; distance: number } | undefined
  for (const card of cards) {
    const box = card.getBoundingClientRect()
    const ahead = direction < 0 ? box.top < origin.top - 1 : box.top > origin.top + 1
    if (!ahead) continue
    // The nearest row first, then the card closest to the same column.
    const closer = row === null || (direction < 0 ? box.top > row + 1 : box.top < row - 1)
    if (closer) {
      row = box.top
      best = undefined
    } else if (Math.abs(box.top - row!) > 1) {
      continue
    }
    const distance = Math.abs(box.left + box.width / 2 - centre)
    if (!best || distance < best.distance) best = { card, distance }
  }
  return best?.card
}

/** The title, update time and folder of each session the artifacts show under. */
function useSessionInfo(...lists: (ArtifactSummary[] | null)[]): Map<string, SessionInfo> {
  const [list, trash] = lists
  const ids = useMemo(
    () => [...new Set([...(list ?? []), ...(trash ?? [])].map((a) => a.sessionId))],
    [list, trash],
  )
  // Flat values, so a running session's other changes do not render the page again.
  const flat = useSessionsStore(
    useShallow((s) =>
      ids.flatMap((id) => {
        const session = s.byId[id]
        return session
          ? [session.title, session.updatedAt, session.projectPath, session.agentId]
          : [null, null, null, null]
      }),
    ),
  )
  return useMemo(() => {
    const map = new Map<string, SessionInfo>()
    ids.forEach((id, i) => {
      const updatedAt = flat[i * 4 + 1] as number | null
      if (updatedAt === null) return
      map.set(id, {
        title: flat[i * 4] as string | null,
        updatedAt,
        projectPath: flat[i * 4 + 2] as string,
        agentId: flat[i * 4 + 3] as AgentId,
      })
    })
    return map
  }, [ids, flat])
}

function LoadingList() {
  const { t } = useTranslation('artifacts')
  return (
    <div aria-busy aria-label={t('page.loading')} className="k-arts__grid">
      {Array.from({ length: 4 }, (_, i) => (
        <CardSkeleton key={i} />
      ))}
    </div>
  )
}

/**
 * Import: an HTML file or a folder, since Windows and Linux have no dialog that picks either,
 * each opening the projects to import into, the sidebar's in its order and then No project.
 */
function ImportMenu({
  align = 'end',
  trigger,
}: {
  align?: 'start' | 'end'
  trigger?: ReactElement
}) {
  const { t } = useTranslation('artifacts')
  const projects = useProjectsStore((s) => s.projects)
  // A file is read by the host it lies on, so it goes into a project of this computer's.
  const own = useMemo(() => projects.filter((p) => hostOfPath(p.path) === null), [projects])
  const host = useWindowHost()
  if (host.kind === 'one' && host.hostId !== null) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          trigger ?? (
            <Button
              size="md"
              variant="secondary"
              icon={<Icon icon={Upload04Icon} size={14} />}
              aria-label={t('page.import')}
            >
              {t('page.importShort')}
            </Button>
          )
        }
      />
      <DropdownMenuContent align={align}>
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('page.importWhat')}</DropdownMenuLabel>
          {(['file', 'folder'] as const).map((kind) => (
            <DropdownMenuSub key={kind}>
              <DropdownMenuSubTrigger>
                <Icon icon={kind === 'file' ? File01Icon : Folder01Icon} size={15} />
                {t(`page.importKind.${kind}`)}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-58 max-w-(--available-width)">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{t('page.importInto')}</DropdownMenuLabel>
                  {own.map((project) => (
                    <DropdownMenuItem
                      key={project.path}
                      onClick={() => void importArtifact(project.path, kind)}
                    >
                      <FolderClosedMark />
                      <span className="truncate">{project.name}</span>
                    </DropdownMenuItem>
                  ))}
                  {own.length > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuItem onClick={() => void importArtifact(null, kind)}>
                    <Icon icon={NO_PROJECT_ICON} size={16} />
                    {t('page.noProject')}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ImportError({ failure }: { failure: ImportFailure }) {
  const { t } = useTranslation(['artifacts', 'common'])
  return (
    <Notice
      tone="red"
      mark={<Icon icon={Alert02Icon} size={16} />}
      title={t('page.importFailedTitle')}
      action={
        <button
          type="button"
          className="ui-as-icon-btn"
          aria-label={t('page.dismiss')}
          onClick={dismissImportFailure}
        >
          <Icon icon={Cancel01Icon} size={15} />
        </button>
      }
    >
      {t(`page.importFailed.${failure}`)}
    </Notice>
  )
}

function NoMatch({ query, onClear }: { query: string; onClear: () => void }) {
  const { t } = useTranslation('artifacts')
  return (
    <div className="k-arts__none">
      <div className="ui-as-empty">
        <span className="ui-as-empty__icon">
          <Icon icon={Search01Icon} size={18} />
        </span>
        <b className="ui-as-empty__title">{t('page.noMatch')}</b>
        <p className="ui-as-empty__text">
          {query.trim()
            ? t('page.noMatchQuery', { query: query.trim() })
            : t('page.noMatchFilters')}
        </p>
      </div>
      <Button size="md" variant="secondary" onClick={onClear}>
        {t('page.clearFilters')}
      </Button>
    </div>
  )
}

function ListError({ error }: { error: string }) {
  const { t } = useTranslation(['artifacts', 'common'])
  const onHost = useHostContext()
  return (
    <Notice
      tone="red"
      mark={<Icon icon={Alert02Icon} size={16} />}
      title={t('page.errorTitle')}
      action={
        <Button size="md" variant="secondary" onClick={retryArtifacts}>
          {t('common:actions.retry')}
        </Button>
      }
    >
      {t('page.errorDescription', { error, ...onHost })}
    </Notice>
  )
}
