import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  FileUpIcon,
  TrashIcon,
  XIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { NO_SESSION, type ArtifactSummary } from '@shared/artifacts'
import type { AgentId } from '@shared/thread'
import { backTo } from '@renderer/app/history'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { SearchField } from '@renderer/components/search-field'
import { SegmentedControl } from '@renderer/components/segmented-control'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@renderer/components/ui/empty'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { CornerControls } from '@renderer/features/shell/top-bar'
import { basename, longAgo } from '@renderer/lib/format'
import { useHostContext } from '@renderer/lib/host-features'
import { hasBand, isMod, isWeb } from '@renderer/lib/platform'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
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
import { KIND_LOOK } from './kinds'
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

/** As many 220 px columns as fit, sharing what is left. */
const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-5 gap-y-7'

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
  const filterField = useRef<HTMLInputElement>(null)
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
        filterField.current?.focus()
        filterField.current?.select()
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
  // "Page", or "Canvas · 6 pages".
  const kindLine = (artifact: ArtifactSummary): string =>
    artifactKind(artifact) === 'canvas'
      ? t('card.canvas', { count: artifact.pages })
      : t('page.kinds.web')
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
    setArtifactsProjectFilter(null)
    setArtifactsAgentFilter(null)
  }

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
          <div {...cardsProps} className={cn(GRID, 'mt-1')}>
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
    else if (groups.length === 0) body = <NoMatch onClear={clearFilters} />
    else {
      body = (
        <>
          {error && <ListError error={error} />}
          <div {...cardsProps} className="mt-1">
            {groups.map((g, i) => (
              <GroupView
                key={g.key}
                group={g}
                first={i === 0}
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
                    timeOf(artifact),
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

  return (
    <div className="flex h-full flex-col">
      <PageStrip />
      <div
        ref={scroller}
        onScroll={(event) => (scrolledTo = event.currentTarget.scrollTop)}
        className="min-h-0 flex-1 overflow-y-auto px-9 pb-10 [scrollbar-gutter:stable]"
      >
        <div className="mx-auto flex max-w-270 flex-col gap-5">
          {deleted ? (
            <header>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="quiet"
                      size="sm"
                      onClick={leaveRecentlyDeleted}
                      className="mb-2 -ml-2.25 self-start"
                    />
                  }
                >
                  <ArrowLeftIcon data-icon="inline-start" />
                  {t('page.title')}
                </TooltipTrigger>
                <TooltipContent>
                  {t('page.backToArtifacts')} <span className="opacity-60">Esc</span>
                </TooltipContent>
              </Tooltip>
              <h1 className="font-display text-title font-bold">{t('page.recentlyDeleted')}</h1>
              <p className="mt-1.5 text-row text-tertiary">{t('page.deletedDescription')}</p>
            </header>
          ) : (
            <>
              <header className="flex min-h-8 flex-wrap items-center gap-4">
                <h1 className="min-w-0 flex-1 font-display text-title font-bold">
                  {t('page.title')}
                </h1>
                {any && (
                  <SearchField
                    value={filter}
                    onChange={setArtifactsFilter}
                    label={t('page.filter')}
                    clearLabel={t('page.clearFilter')}
                    inputRef={filterField}
                    className="h-row w-65 max-w-full rounded-xl border-0 bg-subtle shadow-none not-has-disabled:hover:border-0 has-[[data-slot=input-group-control]:focus-visible]:shadow-field-focus [&_input]:text-lede [&_kbd]:hidden [&>[data-align=inline-start]]:pr-1.25 [&>[data-align=inline-start]]:pl-2.75 [&>[data-align=inline-start]_svg]:size-3"
                  />
                )}
              </header>
              {any && (
                <div className="flex flex-wrap items-center gap-3">
                  <SegmentedControl
                    aria-label={t('page.kind')}
                    value={kindFilter ?? ALL}
                    onChange={(value) =>
                      setArtifactsKindFilter(ARTIFACT_KINDS.find((kind) => kind === value) ?? null)
                    }
                    itemClassName="h-6.5 px-3 text-control font-medium"
                    segments={[
                      { value: ALL, label: t('page.allKinds') },
                      ...ARTIFACT_KINDS.map((kind) => ({
                        value: kind,
                        label: t(`page.kindsPlural.${kind}`),
                      })),
                    ]}
                  />
                  <span className="flex-1" />
                  <FilterMenu list={list} agentOf={agentOf} />
                  <DisplayMenu group={group} sort={sort} />
                  {!isWeb && (
                    <ImportMenu align="end">
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <DropdownMenuTrigger
                              render={
                                <Button
                                  variant="quiet"
                                  size="icon-sm"
                                  aria-label={t('page.import')}
                                  className="size-7.5 rounded-tile text-secondary"
                                />
                              }
                            />
                          }
                        >
                          <FileUpIcon />
                        </TooltipTrigger>
                        <TooltipContent>{t('page.import')}</TooltipContent>
                      </Tooltip>
                    </ImportMenu>
                  )}
                </div>
              )}
            </>
          )}
          {!deleted && importFailed && <ImportError failure={importFailed} />}
          {body}
          {!deleted && list !== null && trash !== null && trash.length > 0 && (
            <button
              type="button"
              onClick={() => openRecentlyDeleted(true)}
              className="mt-3 flex h-11 w-full items-center gap-2.5 rounded-xl px-2.5 text-row text-secondary shadow-[0_-1px_0_var(--border-subtle)] outline-none transition-colors duration-(--duration-fast) hover:bg-hover hover:text-primary focus-ring"
            >
              <TrashIcon className="size-4 text-icon" />
              {t('page.recentlyDeleted')}
              <span className="text-xs text-tertiary tabular-nums">{trash.length}</span>
              <ChevronRightIcon strokeWidth={1.75} className="ml-auto size-3.5 text-icon" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * The strip of sheet above the page, which drags the window. On macOS with the sidebar collapsed
 * it is a top bar's height, beside the traffic lights, and holds the sidebar toggle.
 */
function PageStrip() {
  const cornered = useViewStore((s) => s.sidebarCollapsed) && !hasBand
  return (
    <div
      className={cn(
        'app-region-drag flex shrink-0 items-center',
        cornered ? 'h-top-bar pl-(--corner-inset)' : 'h-8',
      )}
    >
      {cornered && <CornerControls className="-ml-1" />}
    </div>
  )
}

/** One group: its heading and count, then each session's row over its cards, or one grid. */
function GroupView({
  group,
  first,
  grouping,
  sessions,
  now,
  render,
}: {
  group: Group
  first: boolean
  grouping: ArtifactGrouping
  sessions: Map<string, SessionInfo>
  now: number
  render: (artifact: ArtifactSummary) => React.ReactNode
}) {
  const { t } = useTranslation(['artifacts', 'common'])
  const of = group.of
  const label =
    of.kind === 'project' ? of.name : of.kind === 'no-project' ? t('page.noProject') : null
  return (
    <section
      aria-label={label ?? undefined}
      className={cn(
        'flex min-w-0 flex-col',
        !first && 'mt-10 pt-7 shadow-[inset_0_1px_0_var(--border-subtle)]',
      )}
    >
      {label !== null && (
        <h2 className="mb-1 flex min-w-0 items-baseline gap-2 text-row font-semibold">
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
            <span className="truncate">{label}</span>
          )}
          <span className="text-xs font-normal text-tertiary tabular-nums">{group.count}</span>
        </h2>
      )}
      {group.sections.map((section, i) => (
        <div
          key={section.key}
          className={cn('flex min-w-0 flex-col', i > 0 ? 'mt-7' : label !== null && 'mt-2')}
        >
          {grouping === 'project-session' && section.sessionId && (
            <SessionRow id={section.sessionId} info={sessions.get(section.sessionId)} now={now} />
          )}
          <div className={GRID}>{section.artifacts.map(render)}</div>
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
      <span className="mb-2.5 flex h-7 items-center truncate text-ui font-medium text-secondary">
        {t(id === NO_SESSION ? 'page.imported' : 'page.deletedSession')}
      </span>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={() => openSession(id, info.projectPath)}
            className="group/session mb-2.5 -ml-2 flex h-7 max-w-full min-w-0 items-center gap-2 self-start rounded-lg px-2 text-ui text-primary outline-none transition-colors duration-(--duration-fast) hover:bg-hover focus-ring"
          />
        }
        delay={700}
      >
        <AgentMark agent={info.agentId} size={14} className="shrink-0" />
        <span className="truncate font-medium">{info.title ?? t('common:untitledSession')}</span>
        <span className="shrink-0 text-xs text-tertiary">{longAgo(info.updatedAt, now)}</span>
        <ArrowRightIcon className="size-3.5 shrink-0 text-tertiary opacity-0 transition-[opacity,translate] duration-(--duration-fast) group-hover/session:translate-x-0 group-hover/session:opacity-100 group-focus-visible/session:translate-x-0 group-focus-visible/session:opacity-100 motion-safe:-translate-x-0.75" />
      </TooltipTrigger>
      <TooltipContent>{t('page.openSession')}</TooltipContent>
    </Tooltip>
  )
}

/** The kinds an agent makes, each opening New session to ask for one. */
function KindTiles() {
  const { t } = useTranslation('artifacts')
  return (
    <section aria-labelledby="artifacts-ask" className="mt-2 flex flex-col items-center">
      <h2 id="artifacts-ask" className="text-xs text-tertiary">
        {t('page.ask')}
      </h2>
      <div className="mt-2.5 flex flex-wrap justify-center gap-4">
        {ARTIFACT_KINDS.map((kind) => {
          const look = KIND_LOOK[kind]
          return (
            <button
              key={kind}
              type="button"
              onClick={() => askForArtifact(kind)}
              className="group/tile flex w-30 flex-col gap-2 text-left text-ui text-primary outline-none"
            >
              <span
                className={cn(
                  'grid h-20 place-items-center rounded-xl transition-colors duration-(--duration-fast) group-focus-visible/tile:outline-2 group-focus-visible/tile:outline-offset-2 group-focus-visible/tile:outline-focus',
                  look.tint,
                  look.tileHover,
                )}
              >
                <look.icon strokeWidth={1.2} className={cn('size-7', look.color)} />
              </span>
              <span className="pl-0.5">{t(`page.kinds.${kind}`)}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

/** A header menu's button: what it is, then its current choice, as text; `active` off the default. */
const MENU_BUTTON =
  'h-7.5 gap-1.25 rounded-tile px-2 text-control font-normal text-secondary data-active:text-primary'

const ALL = 'all'

/** Narrows the list to an agent's artifacts and to a project, each any by default. */
function FilterMenu({
  list,
  agentOf,
}: {
  list: ArtifactSummary[]
  agentOf: (sessionId: string) => AgentId | null
}) {
  const { t, i18n } = useTranslation('artifacts')
  const projectFilter = useArtifactsStore((s) => s.projectFilter)
  const agentFilter = useArtifactsStore((s) => s.agentFilter)
  const projects = useProjectsStore((s) => s.projects)
  const order = useAgentsStore((s) => s.order)
  const agents = useMemo(() => agentsOf(list, agentOf, order), [list, agentOf, order])
  const choices = useMemo(
    () =>
      projectsOf(list, {
        projects,
        collator: new Intl.Collator(i18n.language, { numeric: true, sensitivity: 'base' }),
      }),
    [list, projects, i18n.language],
  )
  // A radio value per project: its folder after a prefix, so "All" can never be a folder.
  const projectValue =
    projectFilter === null ? ALL : projectFilter === NO_PROJECT ? 'none' : `in:${projectFilter}`
  const projectLabel =
    projectFilter === null
      ? null
      : projectFilter === NO_PROJECT
        ? t('page.noProject')
        : (choices.flatMap((of) =>
            of.kind === 'project' && of.path === projectFilter ? [of.name] : [],
          )[0] ?? basename(projectFilter))
  const agentLabel = agentFilter === null ? t('page.anyAgent') : agentName(agentFilter)
  const shown = projectLabel
    ? t('page.filterBoth', { agent: agentLabel, project: projectLabel })
    : agentLabel
  const active = agentFilter !== null || projectFilter !== null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="quiet"
            data-active={active || undefined}
            aria-label={t('page.filterMenu', { value: shown })}
            className={MENU_BUTTON}
          />
        }
      >
        {agentFilter !== null && <AgentMark agent={agentFilter} size={14} />}
        <span className="max-w-50 truncate">{shown}</span>
        <ChevronDownIcon strokeWidth={1.75} className="size-3 text-tertiary" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="max-w-72 min-w-50">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('page.agent')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={agentFilter ?? ALL}
            onValueChange={(value) =>
              setArtifactsAgentFilter(agents.find((id) => id === value) ?? null)
            }
          >
            <DropdownMenuRadioItem value={ALL} closeOnClick>
              {t('page.anyAgent')}
            </DropdownMenuRadioItem>
            {agents.map((id) => (
              <DropdownMenuRadioItem key={id} value={id} closeOnClick>
                <AgentMark agent={id} size={14} />
                <span className="truncate">{agentName(id)}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('page.project')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={projectValue}
            onValueChange={(value) =>
              setArtifactsProjectFilter(
                value === ALL
                  ? null
                  : value === 'none'
                    ? NO_PROJECT
                    : String(value).slice('in:'.length),
              )
            }
          >
            <DropdownMenuRadioItem value={ALL} closeOnClick>
              {t('page.allProjects')}
            </DropdownMenuRadioItem>
            {choices.map((of) =>
              of.kind === 'project' ? (
                <DropdownMenuRadioItem key={of.path} value={`in:${of.path}`} closeOnClick>
                  <span className="truncate">{of.name}</span>
                </DropdownMenuRadioItem>
              ) : (
                <DropdownMenuRadioItem key="none" value="none" closeOnClick>
                  {t('page.noProject')}
                </DropdownMenuRadioItem>
              ),
            )}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The order, named on its button, and flat or grouped. */
function DisplayMenu({ group, sort }: { group: ArtifactGrouping; sort: ArtifactSort }) {
  const { t } = useTranslation('artifacts')
  const shown = t(`page.sortsShort.${sort}`)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="quiet"
            data-active={group !== 'none' || sort !== 'recent' || undefined}
            aria-label={t('page.display', { value: shown })}
            className={MENU_BUTTON}
          />
        }
      >
        {shown}
        <ChevronDownIcon strokeWidth={1.75} className="size-3 text-tertiary" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="min-w-53">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('page.sort')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={sort}
            onValueChange={(value) =>
              setArtifactsView({ sort: SORTS.find((s) => s === value) ?? 'recent' })
            }
          >
            {SORTS.map((s) => (
              <DropdownMenuRadioItem key={s} value={s} closeOnClick>
                {t(`page.sorts.${s}`)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('page.layout')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={group}
            onValueChange={(value) =>
              setArtifactsView({ group: GROUPINGS.find((g) => g === value) ?? 'none' })
            }
          >
            {GROUPINGS.map((g) => (
              <DropdownMenuRadioItem key={g} value={g} closeOnClick>
                {t(`page.layouts.${g}`)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
    <div aria-busy aria-label={t('page.loading')} className={cn(GRID, 'mt-1')}>
      {Array.from({ length: 4 }, (_, i) => (
        <CardSkeleton key={i} />
      ))}
    </div>
  )
}

/** An empty tray, drawn for an empty list. */
function EmptyTray() {
  return (
    <EmptyMedia className="mb-3">
      <span
        aria-hidden
        className="relative block aspect-16/10 w-33 rounded-code bg-sidebar shadow-sunk"
      >
        <span className="absolute inset-[14%] rounded-xs border-[1.5px] border-dashed border-strong" />
      </span>
    </EmptyMedia>
  )
}

function NoArtifacts() {
  const { t } = useTranslation('artifacts')
  return (
    <Empty className="mt-16 flex-none">
      <EmptyHeader className="max-w-125">
        <EmptyTitle>{t('page.emptyTitle')}</EmptyTitle>
        <EmptyDescription className="max-w-none">{t('page.emptyDescription')}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <KindTiles />
        {!isWeb && (
          <ImportMenu align="center">
            <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
              <FileUpIcon data-icon="inline-start" />
              {t('page.importEllipsis')}
            </DropdownMenuTrigger>
          </ImportMenu>
        )}
      </EmptyContent>
    </Empty>
  )
}

function NothingDeleted() {
  const { t } = useTranslation('artifacts')
  return (
    <Empty className="py-18">
      <EmptyHeader>
        <EmptyTray />
        <EmptyTitle>{t('page.nothingDeleted')}</EmptyTitle>
      </EmptyHeader>
    </Empty>
  )
}

/**
 * "Import into": the sidebar's projects in its order, each with its folder in a tooltip, then No
 * project; each opens the dialog.
 */
function ImportMenu({
  align,
  children,
}: {
  align: 'start' | 'center' | 'end'
  children: React.ReactNode
}) {
  const { t } = useTranslation('artifacts')
  const projects = useProjectsStore((s) => s.projects)
  return (
    <DropdownMenu>
      {children}
      <DropdownMenuContent align={align} sideOffset={6} className="min-w-50">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('page.importInto')}</DropdownMenuLabel>
          {projects.map((project) => (
            <Tooltip key={project.path}>
              <TooltipTrigger
                render={<DropdownMenuItem onClick={() => void importArtifact(project.path)} />}
              >
                <span className="truncate">{project.name}</span>
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-sm font-mono break-all">
                {project.path}
              </TooltipContent>
            </Tooltip>
          ))}
          {projects.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuItem onClick={() => void importArtifact(null)}>
            {t('page.noProject')}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ImportError({ failure }: { failure: ImportFailure }) {
  const { t } = useTranslation(['artifacts', 'common'])
  return (
    <Alert variant="error" className="mt-8">
      <CircleAlertIcon />
      <AlertTitle>{t('page.importFailedTitle')}</AlertTitle>
      <AlertDescription>{t(`page.importFailed.${failure}`)}</AlertDescription>
      <AlertAction>
        <Button
          variant="quiet"
          size="icon-sm"
          aria-label={t('page.dismiss')}
          onClick={dismissImportFailure}
        >
          <XIcon />
        </Button>
      </AlertAction>
    </Alert>
  )
}

function NoMatch({ onClear }: { onClear: () => void }) {
  const { t } = useTranslation('artifacts')
  return (
    <div className="mt-8 flex flex-col items-center gap-1.5 py-14 text-center">
      <p className="font-heading text-subheading font-medium text-secondary">{t('page.noMatch')}</p>
      <Button variant="quiet" size="sm" onClick={onClear}>
        {t('page.clearFilters')}
      </Button>
    </div>
  )
}

function ListError({ error }: { error: string }) {
  const { t } = useTranslation(['artifacts', 'common'])
  const onHost = useHostContext()
  return (
    <Alert variant="error" className="mt-8">
      <CircleAlertIcon />
      <AlertTitle>{t('page.errorTitle')}</AlertTitle>
      <AlertDescription>{t('page.errorDescription', { error, ...onHost })}</AlertDescription>
      <AlertAction>
        <Button variant="outline" size="sm" onClick={retryArtifacts}>
          {t('common:actions.retry')}
        </Button>
      </AlertAction>
    </Alert>
  )
}
