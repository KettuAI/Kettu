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
import { Trans, useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { NO_SESSION, type ArtifactSummary } from '@shared/artifacts'
import { backTo } from '@renderer/app/history'
import { SearchField } from '@renderer/components/search-field'
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
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { CornerControls } from '@renderer/features/shell/top-bar'
import { basename, longAgo } from '@renderer/lib/format'
import { isMac, isMod } from '@renderer/lib/platform'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import {
  artifactListShown,
  dismissImportFailure,
  importArtifact,
  retryArtifacts,
  setArtifactsFilter,
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
import { ArtifactCard, CardSkeleton } from './artifact-card'
import { isEditable } from './keys'
import {
  daysLeft,
  filterByTitle,
  groupArtifacts,
  GROUPINGS,
  sessionCount,
  SORTS,
  type ArtifactGrouping,
  type ArtifactSort,
  type Group,
} from './model'

/** Cards at least 250 px wide, 20 px apart: three across in the 896 px column. */
const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(--spacing(62.5),1fr))] gap-x-5 gap-y-6.5'

interface SessionInfo {
  title: string | null
  updatedAt: number
  projectPath: string
}

/** Where the list was scrolled when the viewer opened, for Back. */
let scrolledTo = 0

/** Recently deleted's Back: to the whole list. */
function leaveRecentlyDeleted(): void {
  backTo({ kind: 'artifacts' }, () => openRecentlyDeleted(false))
}

/**
 * Every artifact as a card, grouped by project and session or as the user chooses; with
 * `deleted`, the page's Recently deleted view.
 */
export default function ArtifactsPage({ deleted }: { deleted: boolean }) {
  const { t, i18n } = useTranslation(['artifacts', 'common'])
  const list = useArtifactsStore((s) => s.list)
  const trash = useArtifactsStore((s) => s.deleted)
  const error = useArtifactsStore((s) => s.error)
  const filter = useArtifactsStore((s) => s.filter)
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
  const day = new Date(now).setHours(0, 0, 0, 0)
  const shown = useMemo(() => (list ? filterByTitle(list, filter) : []), [list, filter])
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
      now: day,
    })
  }, [list, shown, group, sort, projects, sessions, collator, day, t])

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
  const card = (artifact: ArtifactSummary, lead: string, tabbable: string | null) => (
    <ArtifactCard
      key={artifact.id}
      artifact={artifact}
      lead={lead}
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
  const clearFilter = () => {
    setArtifactsFilter('')
    filterField.current?.focus()
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
          <div {...cardsProps} className={GRID}>
            {trash.map((artifact) =>
              card(
                artifact,
                t('card.daysLeft', {
                  project: projectName(artifact),
                  count: daysLeft(artifact.deletedAt ?? now, now),
                }),
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
    else if (groups.length === 0) body = <NoMatch onClear={clearFilter} />
    else {
      body = (
        <>
          {error && <ListError error={error} />}
          <div {...cardsProps}>
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
                      ? t('card.version', { version: artifact.version })
                      : group === 'project'
                        ? sessionName(artifact.sessionId)
                        : projectName(artifact),
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

  const sessionsShown = sessionCount(shown)
  const summary =
    sessionsShown > 0
      ? t('page.summary', { count: shown.length, sessions: sessionsShown })
      : t('page.count', { count: shown.length })

  return (
    <div className="flex h-full flex-col">
      <DragStrip />
      <div
        ref={scroller}
        onScroll={(event) => (scrolledTo = event.currentTarget.scrollTop)}
        className="min-h-0 flex-1 overflow-y-auto px-8 pb-18 [scrollbar-gutter:stable]"
      >
        <div className="@container mx-auto flex max-w-224 flex-col">
          {deleted ? (
            <>
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
              <header className="mb-7.5">
                <h1 className="font-heading text-title font-medium">{t('page.recentlyDeleted')}</h1>
                <p className="mt-1.5 text-small leading-5.5 text-secondary">
                  {t('page.deletedDescription')}
                </p>
              </header>
            </>
          ) : (
            <header className="mb-7.5 flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <h1 className="font-heading text-title font-medium">{t('page.title')}</h1>
                {list && list.length > 0 && (
                  <p className="mt-1.5 text-small leading-5.5 text-secondary">
                    <Trans
                      t={t}
                      i18nKey="page.sentence"
                      values={{
                        summary,
                        grouping: t(`page.groupedBy.${group}`),
                        sorting: t(`page.sortedBy.${sort}`),
                      }}
                      components={{
                        group: (
                          <InlineChoice
                            title={t('page.groupBy')}
                            label={t('page.groupByChoice', {
                              choice: t(`page.groupings.${group}`),
                            })}
                            choices={GROUPINGS.map((g) => [g, t(`page.groupings.${g}`)] as const)}
                            value={group}
                            onPick={(g: ArtifactGrouping) => setArtifactsView({ group: g })}
                          />
                        ),
                        sort: (
                          <InlineChoice
                            title={t('page.sort')}
                            label={t('page.sortChoice', { choice: t(`page.sorts.${sort}`) })}
                            choices={SORTS.map((s) => [s, t(`page.sorts.${s}`)] as const)}
                            value={sort}
                            onPick={(s: ArtifactSort) => setArtifactsView({ sort: s })}
                          />
                        ),
                      }}
                    />
                  </p>
                )}
                {list === null && !error && (
                  <div className="mt-1.5 flex h-5.5 items-center">
                    <Skeleton className="h-3 w-55" />
                  </div>
                )}
              </div>
              {list && list.length > 0 && (
                <>
                  <SearchField
                    value={filter}
                    onChange={setArtifactsFilter}
                    label={t('page.filter')}
                    clearLabel={t('page.clearFilter')}
                    inputRef={filterField}
                    className="w-50 @min-[47.5rem]:w-65"
                  />
                  <ImportMenu align="end">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <DropdownMenuTrigger
                            render={
                              <Button variant="outline" size="icon" aria-label={t('page.import')} />
                            }
                          />
                        }
                      >
                        <FileUpIcon />
                      </TooltipTrigger>
                      <TooltipContent>{t('page.import')}</TooltipContent>
                    </Tooltip>
                  </ImportMenu>
                </>
              )}
            </header>
          )}
          {!deleted && importFailed && <ImportError failure={importFailed} />}
          {body}
          {!deleted && list !== null && trash !== null && trash.length > 0 && (
            <button
              type="button"
              onClick={() => openRecentlyDeleted(true)}
              className="mt-10 flex h-11 w-full items-center gap-2.5 rounded-lg px-2.5 text-ui text-secondary shadow-[0_calc(-1*var(--hairline))_0_var(--border-subtle)] outline-none transition-colors duration-(--duration-fast) hover:bg-hover hover:text-primary focus-ring"
            >
              <TrashIcon className="size-4 text-icon" />
              {t('page.recentlyDeleted')}
              <span className="text-xs text-tertiary tabular-nums">{trash.length}</span>
              <ChevronRightIcon className="ml-auto size-3.5 text-icon" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * The window's drag region over the page, a top bar's height with the desk above the sheet. On
 * macOS with the sidebar collapsed it holds the sidebar toggle, level with the traffic lights.
 */
function DragStrip() {
  const cornered = useViewStore((s) => s.sidebarCollapsed) && isMac
  return (
    <div
      className={cn(
        'app-region-drag flex h-top-bar shrink-0 items-end',
        cornered && 'pl-[calc(36px+var(--traffic-lights))]',
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
    of.kind === 'project'
      ? of.name
      : of.kind === 'no-project'
        ? t('page.noProject')
        : of.kind === 'date'
          ? t(`page.dates.${of.bucket}`)
          : null
  return (
    <section
      aria-label={label ?? undefined}
      className={cn(
        'flex min-w-0 flex-col',
        !first && 'mt-10 pt-7 shadow-[inset_0_var(--hairline)_0_var(--border-subtle)]',
      )}
    >
      {label !== null && (
        <h2 className="mb-1 flex min-w-0 items-baseline gap-2 font-heading text-heading font-medium">
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
          <span className="font-sans text-xs font-normal text-tertiary tabular-nums">
            {group.count}
          </span>
        </h2>
      )}
      {group.sections.map((section, i) => (
        <div key={section.key} className={cn('flex min-w-0 flex-col', i === 0 ? 'mt-2' : 'mt-7')}>
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
        <span className="truncate font-medium">{info.title ?? t('common:untitledSession')}</span>
        <span className="shrink-0 text-xs text-tertiary">{longAgo(info.updatedAt, now)}</span>
        <ArrowRightIcon className="size-3.5 shrink-0 text-tertiary opacity-0 transition-[opacity,translate] duration-(--duration-fast) group-hover/session:translate-x-0 group-hover/session:opacity-100 group-focus-visible/session:translate-x-0 group-focus-visible/session:opacity-100 motion-safe:-translate-x-0.75" />
      </TooltipTrigger>
      <TooltipContent>{t('page.openSession')}</TooltipContent>
    </Tooltip>
  )
}

/**
 * A choice inside the page's sentence, "by project and session": the words open a menu that picks
 * another and closes. `children` are the words, as the sentence's translation places them.
 */
function InlineChoice<T extends string>({
  title,
  label,
  choices,
  value,
  onPick,
  children,
}: {
  title: string
  /** The trigger's name: what it chooses and the current choice. */
  label: string
  choices: readonly (readonly [T, string])[]
  value: T
  onPick: (value: T) => void
  children?: React.ReactNode
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label}
        className="-mr-0.75 -ml-1 inline-flex h-5.5 items-center gap-0.5 rounded-md pr-0.75 pl-1 align-top font-medium text-primary underline decoration-border-strong decoration-dotted underline-offset-4 outline-none transition-colors duration-(--duration-fast) focus-ring hover:bg-hover hover:decoration-transparent aria-expanded:bg-hover aria-expanded:decoration-transparent"
      >
        {children}
        <ChevronDownIcon className="size-3 text-tertiary" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" alignOffset={-6} sideOffset={6} className="min-w-53">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{title}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={value} onValueChange={(v) => onPick(v as T)}>
            {choices.map(([v, name]) => (
              <DropdownMenuRadioItem key={v} value={v} closeOnClick>
                {name}
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
          ? [session.title, session.updatedAt, session.projectPath]
          : [null, null, null]
      }),
    ),
  )
  return useMemo(() => {
    const map = new Map<string, SessionInfo>()
    ids.forEach((id, i) => {
      const updatedAt = flat[i * 3 + 1] as number | null
      if (updatedAt === null) return
      map.set(id, {
        title: flat[i * 3] as string | null,
        updatedAt,
        projectPath: flat[i * 3 + 2] as string,
      })
    })
    return map
  }, [ids, flat])
}

function LoadingList() {
  const { t } = useTranslation('artifacts')
  return (
    <div aria-busy aria-label={t('page.loading')} className="flex flex-col">
      <Skeleton className="mt-2 mb-4.5 h-4 w-45" />
      <div className={GRID}>
        {Array.from({ length: 3 }, (_, i) => (
          <CardSkeleton key={i} />
        ))}
      </div>
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
    <Empty className="py-18">
      <EmptyHeader>
        <EmptyTray />
        <EmptyTitle>{t('page.emptyTitle')}</EmptyTitle>
        <EmptyDescription>{t('page.emptyDescription')}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <ImportMenu align="center">
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
            <FileUpIcon data-icon="inline-start" />
            {t('page.importEllipsis')}
          </DropdownMenuTrigger>
        </ImportMenu>
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
    <Alert variant="error" className="mb-7">
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
    <div className="flex flex-col items-center gap-1.5 py-14 text-center">
      <p className="font-heading text-subheading font-medium text-secondary">{t('page.noMatch')}</p>
      <Button variant="quiet" size="sm" onClick={onClear}>
        {t('page.clearFilter')}
      </Button>
    </div>
  )
}

function ListError({ error }: { error: string }) {
  const { t } = useTranslation(['artifacts', 'common'])
  return (
    <Alert variant="error" className="mb-7">
      <CircleAlertIcon />
      <AlertTitle>{t('page.errorTitle')}</AlertTitle>
      <AlertDescription>{t('page.errorDescription', { error })}</AlertDescription>
      <AlertAction>
        <Button variant="outline" size="sm" onClick={retryArtifacts}>
          {t('common:actions.retry')}
        </Button>
      </AlertAction>
    </Alert>
  )
}
