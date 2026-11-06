import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import {
  Alert02Icon,
  ArrowLeft01Icon,
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
import { NO_SESSION, type ArtifactImportKind, type ArtifactSummary } from '@shared/artifacts'
import type { AgentId } from '@shared/thread'
import { backTo } from '@renderer/app/history'
import {
  Dropdown,
  FilterButton,
  Icon,
  SearchField,
  SectionHead,
  Tabs,
  type MenuItem,
} from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { Notice } from '@renderer/features/routines/kit'
import { basename, longAgo } from '@renderer/lib/format'
import { useHostContext } from '@renderer/lib/host-features'
import { isMod, isWeb } from '@renderer/lib/platform'
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
  setArtifactsProjectFilter,
  useArtifactsStore,
  type ImportFailure,
} from '@renderer/stores/artifacts'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSessionsStore } from '@renderer/stores/sessions'
import {
  openRecentlyDeleted,
  openSession,
  setArtifactsView,
  useViewStore,
} from '@renderer/stores/view'
import { ArtifactCard, CardSkeleton, type CardTime } from './artifact-card'
import { askForArtifact } from './ask'
import { isEditable } from './keys'
import { KIND_ICON } from './kinds'
import {
  agentsOf,
  ARTIFACT_KINDS,
  artifactKind,
  daysLeft,
  filterArtifacts,
  groupArtifacts,
  GROUPINGS,
  NO_PROJECT,
  projectsOf,
  SORTS,
  type ArtifactGrouping,
  type ArtifactSort,
  type Group,
} from './model'
import { FolderMark, KindSketch } from './sketch'
import './artifacts.css'

interface SessionInfo {
  title: string | null
  updatedAt: number
  projectPath: string
  agentId: AgentId
}

/** Where the list was scrolled when the viewer opened, for Back. */
let scrolledTo = 0

/** Recently deleted's Back: to the whole list. */
function leaveRecentlyDeleted(): void {
  backTo({ kind: 'artifacts' }, () => openRecentlyDeleted(false))
}

/**
 * Every artifact as a card, the most recently opened first or as the user chooses, under its
 * search and filters; with `deleted`, the page's Recently deleted view.
 */
export default function ArtifactsPage({ deleted }: { deleted: boolean }) {
  const { t, i18n } = useTranslation(['artifacts', 'common'])
  const list = useArtifactsStore((s) => s.list)
  const trash = useArtifactsStore((s) => s.deleted)
  const error = useArtifactsStore((s) => s.error)
  const filter = useArtifactsStore((s) => s.filter)
  const kindFilter = useArtifactsStore((s) => s.kindFilter)
  const projectFilter = useArtifactsStore((s) => s.projectFilter)
  const agentFilter = useArtifactsStore((s) => s.agentFilter)
  const openedAt = useArtifactsStore((s) => s.openedAt)
  const importFailed = useArtifactsStore((s) => s.importFailed)
  const { group, sort } = useViewStore(useShallow((s) => s.artifactsView))
  const projects = useProjectsStore((s) => s.projects)
  const sessions = useSessionInfo(list, trash)
  const now = useNow()
  const scroller = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState<string | null>(null)

  useEffect(() => {
    artifactListShown(true)
    return () => artifactListShown(false)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.defaultPrevented || useViewStore.getState().settings.open) return
      // Not while a menu or tooltip of the page takes the key.
      const onPage =
        event.target === document.body || scroller.current?.contains(event.target as Node)
      if (deleted) {
        if (event.key === 'Escape' && onPage && !isEditable(event.target)) {
          event.preventDefault()
          leaveRecentlyDeleted()
        }
      } else if (
        isMod(event) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === 'f'
      ) {
        event.preventDefault()
        const field = scroller.current?.querySelector<HTMLInputElement>('.ui-as-search input')
        field?.focus()
        field?.select()
      } else if (event.key === 'Escape' && useArtifactsStore.getState().filter && onPage) {
        event.preventDefault()
        setArtifactsFilter('')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [deleted])

  // Back from the viewer: the same scroll, and the card it opened has the focus again.
  const ready = (deleted ? trash : list) !== null
  useLayoutEffect(() => {
    const view = scroller.current
    if (!view) return
    const { opened } = useArtifactsStore.getState()
    if (!ready || !opened) {
      view.scrollTop = 0
      return
    }
    view.scrollTop = scrolledTo
    // Its focus event makes it the cards' Tab stop.
    view
      .querySelector<HTMLElement>(`[data-artifact-card="${opened}"]`)
      ?.focus({ preventScroll: true })
    useArtifactsStore.setState({ opened: null })
  }, [ready, deleted])

  const collator = useMemo(
    () => new Intl.Collator(i18n.language, { numeric: true, sensitivity: 'base' }),
    [i18n.language],
  )
  const agentOf = useMemo(() => {
    return (id: string): AgentId | null => sessions.get(id)?.agentId ?? null
  }, [sessions])
  const shown = useMemo(
    () =>
      list
        ? filterArtifacts(list, {
            title: filter,
            kind: kindFilter,
            project: projectFilter,
            agent: agentFilter,
            agentOf,
          })
        : [],
    [list, filter, kindFilter, projectFilter, agentFilter, agentOf],
  )
  const groups = useMemo(() => {
    if (!list) return []
    return groupArtifacts(shown, group, sort, {
      projects,
      session: (id) => {
        const info = sessions.get(id)
        return info
          ? { title: info.title ?? t('common:untitledSession'), updatedAt: info.updatedAt }
          : null
      },
      deletedSession: t('page.deletedSession'),
      imported: t('page.imported'),
      collator,
      opened: openedAt,
    })
  }, [list, shown, group, sort, projects, sessions, collator, openedAt, t])

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
  // The time the order goes by: when it was opened here or written, or when it was written.
  const timeOf = (artifact: ArtifactSummary): CardTime => {
    const opened = openedAt[artifact.id] ?? 0
    return { at: sort !== 'updated' && opened > artifact.updatedAt ? opened : artifact.updatedAt }
  }
  // "Page", "Document", or "Canvas · 6 pages".
  const kindLine = (artifact: ArtifactSummary): string => {
    const kind = artifactKind(artifact)
    return kind === 'canvas' ? t('card.canvas', { count: artifact.pages }) : t(`page.kinds.${kind}`)
  }
  const card = (
    artifact: ArtifactSummary,
    meta: string,
    time: CardTime | null,
    tabbable: string | null,
  ) => (
    <ArtifactCard
      key={artifact.id}
      artifact={artifact}
      agent={agentOf(artifact.sessionId)}
      meta={meta}
      time={time}
      project={projectName(artifact)}
      session={sessionName(artifact.sessionId)}
      tabbable={artifact.id === tabbable}
    />
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
  }

  const projectChoices = useMemo(
    () => (list ? projectsOf(list, { projects, collator }) : []),
    [list, projects, collator],
  )
  const agentChoices = useAgentChoices(list, agentOf)

  let body
  if (deleted) {
    const tabbable = trash?.some((a) => a.id === active) ? active : (trash?.[0]?.id ?? null)
    if (trash === null && error) body = <ListError error={error} />
    else if (trash === null) body = <LoadingList />
    else if (trash.length === 0) body = <NothingDeleted />
    else {
      body = (
        <>
          {error && <ListError error={error} />}
          <div {...cardsProps} className="k-arts__grid">
            {trash.map((artifact) =>
              card(
                artifact,
                t('card.daysLeft', {
                  project: projectName(artifact),
                  count: daysLeft(artifact.deletedAt ?? now, now),
                }),
                null,
                tabbable,
              ),
            )}
          </div>
        </>
      )
    }
  } else {
    const cards = groups.flatMap((g) => g.sections.flatMap((s) => s.artifacts))
    const tabbable = cards.some((a) => a.id === active) ? active : (cards[0]?.id ?? null)
    if (list === null && error) body = <ListError error={error} />
    else if (list === null) body = <LoadingList />
    else if (list.length === 0) body = <NoArtifacts />
    else if (groups.length === 0) body = <NoMatch query={filter} onClear={clearFilters} />
    else {
      body = (
        <>
          {error && <ListError error={error} />}
          <div {...cardsProps}>
            {groups.map((g) => (
              <GroupView
                key={g.key}
                group={g}
                grouping={group}
                sessions={sessions}
                now={now}
                render={(artifact) =>
                  card(
                    artifact,
                    group === 'project-session'
                      ? t('card.kindVersion', {
                          kind: kindLine(artifact),
                          version: artifact.version,
                        })
                      : kindLine(artifact),
                    group === 'project-session' ? null : timeOf(artifact),
                    tabbable,
                  )
                }
              />
            ))}
          </div>
        </>
      )
    }
  }

  const any = list !== null && list.length > 0
  const kindTabs = [ALL, ...ARTIFACT_KINDS] as const
  const tabLabel = (kind: (typeof kindTabs)[number]) =>
    kind === ALL ? t('page.allKinds') : t(`page.kindsPlural.${kind}`)

  return (
    <div
      ref={scroller}
      onScroll={(event) => (scrolledTo = event.currentTarget.scrollTop)}
      className="k-arts-scroll"
    >
      <div aria-hidden className="k-arts-drag app-region-drag" />
      <div className="ui-as-page k-arts">
        {deleted ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button type="button" className="k-arts__back" onClick={leaveRecentlyDeleted} />
                }
              >
                <Icon icon={ArrowLeft01Icon} size={15} />
                {t('page.title')}
              </TooltipTrigger>
              <TooltipContent>
                {t('page.backToArtifacts')} <span className="opacity-60">Esc</span>
              </TooltipContent>
            </Tooltip>
            <h1 className="ui-as-page-title">{t('page.recentlyDeleted')}</h1>
            <p className="ui-as-page-sub">{t('page.deletedDescription')}</p>
          </>
        ) : (
          <>
            <h1 className="ui-as-page-title">{t('page.title')}</h1>
            <p className="ui-as-page-sub">{t('page.description')}</p>
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
                      groups={[
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
                      ]}
                      value={{ agent: [...agentFilter], project: [...projectFilter] }}
                      onChange={(value) => {
                        setArtifactsAgentFilter(
                          agentChoices.filter((id) => value.agent?.includes(id)),
                        )
                        setArtifactsProjectFilter(value.project ?? [])
                      }}
                    />
                    <DisplayMenu group={group} sort={sort} />
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
          </>
        )}
        {!deleted && importFailed && <ImportError failure={importFailed} />}
        {body}
        {!deleted && list !== null && trash !== null && trash.length > 0 && (
          <button type="button" className="k-arts__bin" onClick={() => openRecentlyDeleted(true)}>
            <Icon icon={Delete02Icon} size={14} />
            {t('page.recentlyDeleted')}
            <span className="k-num">{trash.length}</span>
            <Icon icon={ArrowRight01Icon} size={13} />
          </button>
        )}
      </div>
    </div>
  )
}

/** One group: its project and count, then each session's row over its cards, or one grid. */
function GroupView({
  group,
  grouping,
  sessions,
  now,
  render,
}: {
  group: Group
  grouping: ArtifactGrouping
  sessions: Map<string, SessionInfo>
  now: number
  render: (artifact: ArtifactSummary) => React.ReactNode
}) {
  const { t } = useTranslation(['artifacts', 'common'])
  const of = group.of
  const label =
    of.kind === 'project' ? of.name : of.kind === 'no-project' ? t('page.noProject') : null
  if (label === null) {
    return group.sections.map((section) => (
      <div key={section.key} className="k-arts__grid">
        {section.artifacts.map(render)}
      </div>
    ))
  }
  return (
    <section aria-label={label} className="k-arts__group">
      <h3 className="k-arts__project">
        {of.kind === 'project' && <FolderMark />}
        {of.kind === 'project' ? (
          <Tooltip>
            <TooltipTrigger render={<span className="truncate" />} delay={700}>
              {label}
            </TooltipTrigger>
            <TooltipContent side="bottom" align="start" className="font-mono">
              {of.path}
            </TooltipContent>
          </Tooltip>
        ) : (
          label
        )}
        <small className="k-num">{group.count}</small>
      </h3>
      {group.sections.map((section) => (
        <div key={section.key} className="k-arts__session">
          {grouping === 'project-session' && section.sessionId && (
            <SessionRow id={section.sessionId} info={sessions.get(section.sessionId)} now={now} />
          )}
          <div className="k-arts__grid">{section.artifacts.map(render)}</div>
        </div>
      ))}
    </section>
  )
}

/** The session's title and last update, as a row that opens it; a deleted one is a label. */
function SessionRow({ id, info, now }: { id: string; info: SessionInfo | undefined; now: number }) {
  const { t } = useTranslation(['artifacts', 'common'])
  if (!info) {
    return (
      <span className="k-arts__session-row">
        <span>{t(id === NO_SESSION ? 'page.imported' : 'page.deletedSession')}</span>
      </span>
    )
  }
  return (
    <button
      type="button"
      className="k-arts__session-row"
      title={t('page.openSession')}
      onClick={() => openSession(id, info.projectPath)}
    >
      <AgentMark agent={info.agentId} size={14} className="shrink-0" />
      <span>{info.title ?? t('common:untitledSession')}</span>
      <small>{longAgo(info.updatedAt, now)}</small>
      <Icon icon={ArrowRight01Icon} size={13} />
    </button>
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

/** The order, named on its button, and flat or grouped. */
function DisplayMenu({ group, sort }: { group: ArtifactGrouping; sort: ArtifactSort }) {
  const { t } = useTranslation('artifacts')
  return (
    <Dropdown
      align="end"
      className="k-arts__menu"
      items={[
        { label: t('page.sort'), heading: true },
        ...SORTS.map((s) => ({
          label: t(`page.sorts.${s}`),
          checked: s === sort,
          onSelect: () => setArtifactsView({ sort: s }),
        })),
        { label: t('page.layout'), heading: true, divider: true },
        ...GROUPINGS.map((g) => ({
          label: t(`page.layouts.${g}`),
          checked: g === group,
          onSelect: () => setArtifactsView({ group: g }),
        })),
      ]}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className="ui-as-tool ui-as-tool--label"
          aria-label={t('page.display', { value: t(`page.sortsShort.${sort}`) })}
          aria-expanded={open}
          aria-haspopup="menu"
          data-active={group !== 'none' || sort !== 'recent' || undefined}
          onClick={toggle}
        >
          <Icon icon={SlidersHorizontalIcon} size={15} />
          {t(`page.sortsShort.${sort}`)}
        </button>
      )}
    />
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

/** The kinds an agent makes, each opening New session to ask for one. */
function NoArtifacts() {
  const { t } = useTranslation('artifacts')
  return (
    <>
      <div className="k-arts__empty">
        <b>{t('page.emptyTitle')}</b>
        <p>{t('page.emptyDescription')}</p>
        {!isWeb && (
          <ImportMenu
            align="start"
            trigger={(open, toggle) => (
              <Button
                size="sm"
                variant="secondary"
                icon={<Icon icon={Upload04Icon} size={14} />}
                aria-expanded={open}
                aria-haspopup="menu"
                onClick={toggle}
              >
                {t('page.importEllipsis')}
              </Button>
            )}
          />
        )}
      </div>
      <SectionHead title={t('page.ask')} />
      <div className="k-arts__asks">
        {ARTIFACT_KINDS.map((kind, i) => (
          <button
            key={kind}
            type="button"
            className="k-arts__ask ui-as-rise"
            style={{ '--i': i } as CSSProperties}
            onClick={() => askForArtifact(kind)}
          >
            <span className="ui-as-template__preview">
              <KindSketch kind={kind} title={t(`page.kinds.${kind}`)} />
            </span>
            <b>
              <Icon icon={KIND_ICON[kind]} size={14} />
              {t(`page.kinds.${kind}`)}
            </b>
            <small>{t(`page.askNotes.${kind}`)}</small>
          </button>
        ))}
      </div>
    </>
  )
}

function NothingDeleted() {
  const { t } = useTranslation('artifacts')
  return (
    <div className="ui-as-empty" data-tall>
      <span className="ui-as-empty__icon">
        <Icon icon={Delete02Icon} size={18} />
      </span>
      <b className="ui-as-empty__title">{t('page.nothingDeleted')}</b>
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
  trigger?: (open: boolean, toggle: () => void) => ReactNode
}) {
  const { t } = useTranslation('artifacts')
  const projects = useProjectsStore((s) => s.projects)
  const into = (kind: ArtifactImportKind): MenuItem[] => [
    { label: t('page.importInto'), heading: true },
    ...projects.map((project) => ({
      label: project.name,
      logo: <FolderMark />,
      onSelect: () => void importArtifact(project.path, kind),
    })),
    {
      label: t('page.noProject'),
      divider: projects.length > 0,
      onSelect: () => void importArtifact(null, kind),
    },
  ]
  return (
    <Dropdown
      align={align}
      className="k-arts__menu"
      items={[
        { label: t('page.importWhat'), heading: true },
        { label: t('page.importKind.file'), icon: File01Icon, submenu: into('file') },
        { label: t('page.importKind.folder'), icon: Folder01Icon, submenu: into('folder') },
      ]}
      trigger={({ open, toggle }) =>
        trigger ? (
          trigger(open, toggle)
        ) : (
          <Button
            size="sm"
            variant="secondary"
            icon={<Icon icon={Upload04Icon} size={14} />}
            aria-label={t('page.import')}
            aria-expanded={open}
            aria-haspopup="menu"
            onClick={toggle}
          >
            {t('page.importShort')}
          </Button>
        )
      }
    />
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
      <Button size="sm" variant="secondary" onClick={onClear}>
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
        <Button size="sm" variant="secondary" onClick={retryArtifacts}>
          {t('common:actions.retry')}
        </Button>
      }
    >
      {t('page.errorDescription', { error, ...onHost })}
    </Notice>
  )
}
