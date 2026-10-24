import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  ArrowDownUpIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  Rows3Icon,
  ShapesIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { ArtifactSummary } from '@shared/artifacts'
import { SearchField } from '@renderer/components/search-field'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@renderer/components/ui/empty'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { TopBar } from '@renderer/features/shell/top-bar'
import { basename, longAgo } from '@renderer/lib/format'
import { isMod } from '@renderer/lib/platform'
import { useNow } from '@renderer/lib/use-now'
import {
  artifactsPageShown,
  retryArtifacts,
  setArtifactsFilter,
  useArtifactsStore,
} from '@renderer/stores/artifacts'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSessionsStore } from '@renderer/stores/sessions'
import { openSession, setArtifactsView, useViewStore } from '@renderer/stores/view'
import { ArtifactCard, CardSkeleton } from './artifact-card'
import {
  filterByTitle,
  groupArtifacts,
  GROUPINGS,
  sessionCount,
  SORTS,
  type ArtifactGrouping,
  type ArtifactSort,
  type Group,
} from './model'

/** Cards at least 280 px wide, 16 px apart: three across at 960 px. */
const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(--spacing(70),1fr))] gap-4'

interface SessionInfo {
  title: string | null
  updatedAt: number
  projectPath: string
}

/** Where the list was scrolled when the viewer opened, for Back. */
let scrolledTo = 0

/** Every artifact as a card, grouped by project and session or as the user chooses. */
export default function ArtifactsPage() {
  const { t, i18n } = useTranslation(['artifacts', 'common'])
  const list = useArtifactsStore((s) => s.list)
  const error = useArtifactsStore((s) => s.error)
  const filter = useArtifactsStore((s) => s.filter)
  const { group, sort } = useViewStore(useShallow((s) => s.artifactsView))
  const projects = useProjectsStore((s) => s.projects)
  const sessions = useSessionInfo(list)
  const now = useNow()
  const scroller = useRef<HTMLDivElement>(null)
  const filterField = useRef<HTMLInputElement>(null)
  const [active, setActive] = useState<string | null>(null)

  useEffect(() => {
    artifactsPageShown(true)
    return () => artifactsPageShown(false)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.defaultPrevented || useViewStore.getState().settings.open) return
      if (isMod(event) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        filterField.current?.focus()
        filterField.current?.select()
      } else if (
        event.key === 'Escape' &&
        useArtifactsStore.getState().filter &&
        // Not while a menu or tooltip of the page takes the key.
        (event.target === document.body || scroller.current?.contains(event.target as Node))
      ) {
        event.preventDefault()
        setArtifactsFilter('')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Back from the viewer: the same scroll, and the card it opened has the focus again.
  const ready = list !== null
  useLayoutEffect(() => {
    if (!ready) return
    const view = scroller.current
    const { opened } = useArtifactsStore.getState()
    if (!view || !opened) return
    view.scrollTop = scrolledTo
    setActive(opened)
    view
      .querySelector<HTMLElement>(`[data-artifact-card="${opened}"]`)
      ?.focus({ preventScroll: true })
    useArtifactsStore.setState({ opened: null })
  }, [ready])

  const collator = useMemo(
    () => new Intl.Collator(i18n.language, { numeric: true, sensitivity: 'base' }),
    [i18n.language],
  )
  const day = new Date(now).setHours(0, 0, 0, 0)
  const groups = useMemo(() => {
    if (!list) return []
    return groupArtifacts(filterByTitle(list, filter), group, sort, {
      projects,
      session: (id) => {
        const info = sessions.get(id)
        return info
          ? { title: info.title ?? t('common:untitledSession'), updatedAt: info.updatedAt }
          : null
      },
      deletedSession: t('page.deletedSession'),
      collator,
      now: day,
    })
  }, [list, filter, group, sort, projects, sessions, collator, day, t])

  const projectName = (artifact: ArtifactSummary): string =>
    artifact.scratch
      ? t('page.noProject')
      : (projects.find((p) => p.path === artifact.project)?.name ?? basename(artifact.project))
  const sessionName = (id: string): string => {
    const info = sessions.get(id)
    if (!info) return t('page.deletedSession')
    return info.title ?? t('common:untitledSession')
  }

  const cards = groups.flatMap((g) => g.sections.flatMap((s) => s.artifacts))
  const tabbable = cards.some((a) => a.id === active) ? active : (cards[0]?.id ?? null)

  let body
  if (list === null && error) body = <ListError error={error} />
  else if (list === null) body = <LoadingList />
  else if (list.length === 0) body = <NoArtifacts />
  else if (groups.length === 0) body = <NoMatch />
  else {
    body = (
      <>
        {error && <ListError error={error} />}
        <div
          className="flex flex-col gap-7"
          onKeyDown={moveCardFocus}
          onFocus={(event) => {
            const id = (event.target as HTMLElement).dataset.artifactCard
            if (id) setActive(id)
          }}
        >
          {groups.map((g) => (
            <GroupView
              key={g.key}
              group={g}
              grouping={group}
              sessions={sessions}
              now={now}
              render={(artifact) => (
                <ArtifactCard
                  key={artifact.id}
                  artifact={artifact}
                  lead={
                    group === 'project-session'
                      ? t('card.version', { version: artifact.version })
                      : group === 'project'
                        ? sessionName(artifact.sessionId)
                        : projectName(artifact)
                  }
                  project={projectName(artifact)}
                  session={sessionName(artifact.sessionId)}
                  sessionGone={!sessions.has(artifact.sessionId)}
                  tabbable={artifact.id === tabbable}
                />
              )}
            />
          ))}
        </div>
      </>
    )
  }

  const controls = list === null ? !error : list.length > 0

  return (
    <div className="flex h-full flex-col">
      <TopBar className="shadow-none">{null}</TopBar>
      <div
        ref={scroller}
        onScroll={(event) => (scrolledTo = event.currentTarget.scrollTop)}
        className="min-h-0 flex-1 overflow-y-auto px-7 pt-4 pb-14 [scrollbar-gutter:stable]"
      >
        <div className="@container mx-auto flex max-w-240 flex-col">
          <header className="mb-7 flex items-end gap-4">
            <div className="min-w-0 flex-1">
              <h1 className="text-title">{t('page.title')}</h1>
              {list && list.length > 0 && (
                <p className="mt-1 text-xs text-secondary">
                  {t('page.summary', { count: list.length, sessions: sessionCount(list) })}
                </p>
              )}
              {list === null && !error && (
                <div className="mt-1 flex h-4 items-center">
                  <Skeleton className="h-3 w-33" />
                </div>
              )}
            </div>
            {controls && (
              <div className="flex shrink-0 items-center gap-2">
                <div className="flex items-center gap-0.5">
                  <ChoiceMenu
                    icon={<Rows3Icon data-icon="inline-start" />}
                    title={t('page.groupBy')}
                    name={(choice) => t('page.groupByChoice', { choice })}
                    choices={GROUPINGS.map((g) => [g, t(`page.groupings.${g}`)] as const)}
                    value={group}
                    onPick={(g: ArtifactGrouping) => setArtifactsView({ group: g })}
                  />
                  <ChoiceMenu
                    icon={<ArrowDownUpIcon data-icon="inline-start" />}
                    title={t('page.sort')}
                    name={(choice) => t('page.sortChoice', { choice })}
                    choices={SORTS.map((s) => [s, t(`page.sorts.${s}`)] as const)}
                    value={sort}
                    onPick={(s: ArtifactSort) => setArtifactsView({ sort: s })}
                  />
                </div>
                <SearchField
                  value={filter}
                  onChange={setArtifactsFilter}
                  label={t('page.filter')}
                  clearLabel={t('page.clearFilter')}
                  inputRef={filterField}
                  className="w-50 @min-[47.5rem]:w-65"
                />
              </div>
            )}
          </header>
          {body}
        </div>
      </div>
    </div>
  )
}

/** One group: its label and count, then each session's row over its cards, or one grid. */
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
    of.kind === 'project'
      ? of.name
      : of.kind === 'no-project'
        ? t('page.noProject')
        : of.kind === 'date'
          ? t(`page.dates.${of.bucket}`)
          : null
  return (
    <section className="flex flex-col gap-2.5">
      {label !== null && (
        <h2
          title={of.kind === 'project' ? of.path : undefined}
          className="flex items-baseline gap-1.5 text-xs font-medium text-tertiary"
        >
          <span className="truncate">{label}</span>
          <span className="text-meta font-normal">{group.count}</span>
        </h2>
      )}
      <div className="flex flex-col gap-4">
        {group.sections.map((section) => (
          <div key={section.key} className="flex min-w-0 flex-col gap-2">
            {grouping === 'project-session' && section.sessionId && (
              <SessionRow id={section.sessionId} info={sessions.get(section.sessionId)} now={now} />
            )}
            <div className={GRID}>{section.artifacts.map(render)}</div>
          </div>
        ))}
      </div>
    </section>
  )
}

/** The session's title and last update, as a row that opens it; a deleted one is a label. */
function SessionRow({ id, info, now }: { id: string; info: SessionInfo | undefined; now: number }) {
  const { t } = useTranslation(['artifacts', 'common'])
  if (!info) {
    return (
      <span className="flex h-row items-center truncate font-medium text-secondary">
        {t('page.deletedSession')}
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
            className="-ml-2 flex h-row max-w-full min-w-0 items-center gap-2 self-start rounded-lg px-2 text-ui outline-none hover:bg-hover focus-ring"
          />
        }
        delay={700}
      >
        <span className="truncate font-medium">{info.title ?? t('common:untitledSession')}</span>
        <span className="shrink-0 text-meta text-tertiary">{longAgo(info.updatedAt, now)}</span>
      </TooltipTrigger>
      <TooltipContent>{t('page.openSession')}</TooltipContent>
    </Tooltip>
  )
}

/** A quiet button showing the current choice, whose menu picks another and closes. */
function ChoiceMenu<T extends string>({
  icon,
  title,
  name,
  choices,
  value,
  onPick,
}: {
  icon: React.ReactNode
  title: string
  name: (choice: string) => string
  choices: readonly (readonly [T, string])[]
  value: T
  onPick: (value: T) => void
}) {
  const current = choices.find(([v]) => v === value)?.[1] ?? ''
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={<Button variant="quiet" size="compact" aria-label={name(current)} />}
            />
          }
        >
          {icon}
          <span className="hidden @min-[40rem]:inline">{current}</span>
          <ChevronDownIcon data-icon="inline-end" />
        </TooltipTrigger>
        <TooltipContent>{name(current)}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{title}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={value} onValueChange={(v) => onPick(v as T)}>
            {choices.map(([v, label]) => (
              <DropdownMenuRadioItem key={v} value={v} closeOnClick>
                {label}
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
function useSessionInfo(list: ArtifactSummary[] | null): Map<string, SessionInfo> {
  const ids = useMemo(() => [...new Set(list?.map((a) => a.sessionId))], [list])
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
    <div aria-busy aria-label={t('page.loading')} className="flex flex-col gap-2.5">
      <Skeleton className="my-0.5 h-3 w-18" />
      <div className="flex flex-col gap-4">
        {[3, 1].map((count, i) => (
          <div key={i} className="flex flex-col gap-2">
            <div className="flex h-row items-center">
              <Skeleton className={i === 0 ? 'h-3 w-57' : 'h-3 w-44'} />
            </div>
            <div className={GRID}>
              {Array.from({ length: count }, (_, j) => (
                <CardSkeleton key={j} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function NoArtifacts() {
  const { t } = useTranslation('artifacts')
  return (
    <Empty className="py-24">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ShapesIcon />
        </EmptyMedia>
        <EmptyTitle>{t('page.emptyTitle')}</EmptyTitle>
        <EmptyDescription>{t('page.emptyDescription')}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

function NoMatch() {
  const { t } = useTranslation('artifacts')
  return (
    <div className="flex flex-col items-center gap-1 py-26 text-center">
      <p className="text-ui text-secondary">{t('page.noMatch')}</p>
      <p className="text-xs text-tertiary">{t('page.noMatchHint')}</p>
    </div>
  )
}

function ListError({ error }: { error: string }) {
  const { t } = useTranslation(['artifacts', 'common'])
  return (
    <Alert variant="destructive" className="mb-7">
      <CircleAlertIcon />
      <AlertTitle>{t('page.errorTitle')}</AlertTitle>
      <AlertDescription>{error}</AlertDescription>
      <AlertAction>
        <Button variant="outline" size="compact" onClick={retryArtifacts}>
          {t('common:actions.retry')}
        </Button>
      </AlertAction>
    </Alert>
  )
}
