import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeftIcon, ChevronRightIcon, SearchIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SearchField } from '@renderer/components/search-field'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@renderer/components/ui/empty'
import { Kbd } from '@renderer/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { DESK, ON_DESK, SHEET } from '@renderer/features/shell/sheet'
import { formatShortcut, isMac, isMod } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { useSessionsStore } from '@renderer/stores/sessions'
import { loadMcpStatus } from '@renderer/stores/mcp'
import { useUpdatesStore } from '@renderer/stores/updates'
import {
  closeSettings,
  openSettings,
  useViewStore,
  type SettingsSection,
} from '@renderer/stores/view'
import { footerLabel } from './footer-label'
import { excerpt, FlashContext, highlight, matches, type RowDef, type SectionDef } from './model'
import { GroupLabel, RowGroup, SectionBody } from './rows'
import {
  useAboutSection,
  useArchivedSection,
  useAdvancedSection,
  useAgentsSection,
  useHarnessesSection,
  useAppearanceSection,
  useBrowserSection,
  useGeneralSection,
  useGitSection,
  useHostsSection,
  useMcpSection,
  useNotificationsSection,
  useRemoteSection,
  useSharingSection,
  useTerminalSection,
  useUsageSection,
} from './section-defs'

const FLASH_MS = 1200

/**
 * Settings take the whole window: a list of sections and search on the left, the selected section
 * as a page of its own on the right. While searching, the page gives way to the matching rows,
 * each of which opens its page at the row.
 */
export default function SettingsPage() {
  const { t } = useTranslation('settings')
  // The list in clusters: what belongs to this client first, then the agents and their tools,
  // then the rest.
  const clusters: SectionDef[][] = [
    [
      useGeneralSection(),
      useAppearanceSection(),
      useNotificationsSection(),
      useHostsSection(),
      useBrowserSection(),
    ],
    [
      useAgentsSection(),
      useHarnessesSection(),
      useUsageSection(),
      useTerminalSection(),
      useGitSection(),
    ],
    [useMcpSection()],
    [useArchivedSection(), useSharingSection()],
    [useRemoteSection()],
    [useAdvancedSection(), useAboutSection()],
  ]
  const sections = clusters.flat()
  const [query, setQuery] = useState('')
  const needle = query.trim()
  const searching = needle.length > 0
  const hits = sections.map((s) => ({ ...s, rows: s.rows.filter((r) => matches(r, needle)) }))
  const hitCount = hits.reduce((sum, s) => sum + s.rows.length, 0)
  const active = useViewStore((s) => s.settings.section) ?? 'general'
  const page = sections.find((s) => s.id === active) ?? sections[0]!
  const item = useViewStore((s) => (s.settings.section === active ? s.settings.item : null))
  // Read when Settings opens, so search finds every row, and again when its section shows.
  useEffect(() => {
    loadMcpStatus()
  }, [])
  useEffect(() => {
    if (active === 'mcp') loadMcpStatus()
  }, [active, item])
  const scroller = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const [jump, setJump] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const lastItem = useRef(item)

  // Opening a section from elsewhere, such as the app menu, leaves the results behind.
  const [seen, setSeen] = useState(active)
  if (seen !== active) {
    setSeen(active)
    setQuery('')
  }

  const choose = (id: SettingsSection) => {
    setQuery('')
    openSettings(id)
  }

  const go = (section: SectionDef, row: RowDef) => {
    setQuery('')
    if (row.open) row.open()
    else openSettings(section.id)
    setJump(row.id)
  }

  // Every page, and the results, start at the top; a search result starts at its row, and the
  // list, back from an item's page, at that item, which takes the focus.
  useLayoutEffect(() => {
    const view = scroller.current
    const left = lastItem.current
    lastItem.current = item
    if (!view) return
    const row = jump ? view.querySelector<HTMLElement>(`[data-setting-row="${jump}"]`) : null
    const found =
      left && !item && !searching
        ? view.querySelector<HTMLElement>(`[data-item-row="${left}"]`)
        : null
    if (row) {
      row.scrollIntoView({ block: 'center' })
      setFlash(jump)
      setJump(null)
    } else if (found) {
      found.scrollIntoView({ block: 'center' })
      found.focus({ preventScroll: true })
    } else {
      view.scrollTop = 0
    }
  }, [active, item, searching, jump])

  useEffect(() => {
    if (!flash) return
    const timer = setTimeout(() => setFlash(null), FLASH_MS)
    return () => clearTimeout(timer)
  }, [flash])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isMod(event) && !event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        search.current?.focus()
        search.current?.select()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // The desk drags the window; the column and the page on it opt out.
  return (
    <div
      className={cn(
        'flex h-full animate-in bg-sidebar fade-in animation-duration-(--duration-fast)',
        DESK,
      )}
    >
      <aside className={cn('flex w-64 shrink-0 flex-col border-r pb-2', ON_DESK)}>
        {/* As the sidebar's header: level with the top bar on macOS, in the band elsewhere. */}
        <div
          className={cn(
            'app-region-drag flex shrink-0 items-center px-2',
            isMac ? 'h-top-bar' : 'h-(--title-bar)',
          )}
        >
          {isMac && <span aria-hidden className="w-[calc(26px+var(--traffic-lights))] shrink-0" />}
          <BackButton />
        </div>
        <h1 className="mx-4.5 mt-1.5 mb-3 font-heading text-subheading font-medium">
          {t('page.title')}
        </h1>
        <SearchField
          value={query}
          onChange={setQuery}
          label={t('page.search')}
          clearLabel={t('page.clearSearch')}
          inputRef={search}
          className="mx-2.5 mb-2.5 h-7.5 w-auto"
        />
        {/* Padded inside the scroller, so the rows' focus rings are not cut off. */}
        <nav
          aria-label={t('page.sections')}
          className="-my-1 flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-2 py-1"
        >
          {clusters.map((cluster, i) => (
            <div key={i} className="flex flex-col gap-0.5">
              {cluster.map((section) => {
                const count = hits.find((h) => h.id === section.id)?.rows.length ?? 0
                return (
                  <NavRow
                    key={section.id}
                    section={section}
                    selected={!searching && section.id === active}
                    dim={searching && count === 0}
                    count={searching && count > 0 ? count : null}
                    onChoose={() => choose(section.id)}
                  />
                )
              })}
            </div>
          ))}
        </nav>
        <AppFooter />
      </aside>

      <main className={cn('flex min-w-0 flex-1 flex-col', !isMac && 'mt-(--title-bar)', SHEET)}>
        <div className="app-region-drag h-top-bar shrink-0" />
        <div
          ref={scroller}
          className="min-h-0 flex-1 overflow-y-auto px-8 [scrollbar-gutter:stable_both-edges]"
        >
          <FlashContext.Provider value={flash}>
            <div
              key={searching ? 'results' : item ? `${page.id}/${item}` : page.id}
              className="mx-auto flex w-full max-w-[560px] animate-in flex-col pt-1 pb-24 fade-in slide-in-from-bottom-1 animation-duration-(--duration-base)"
            >
              {searching ? (
                <SearchResults query={needle} hits={hits} count={hitCount} onGo={go} />
              ) : item && page.itemPage ? (
                page.itemPage(item)
              ) : (
                <section aria-labelledby={`settings-${page.id}`} className="flex flex-col">
                  {page.hero ?? (
                    <PageHeader id={`settings-${page.id}`} title={page.title}>
                      {page.description}
                    </PageHeader>
                  )}
                  <SectionBody section={page} />
                  {page.footer}
                </section>
              )}
            </div>
          </FlashContext.Provider>
        </div>
      </main>
    </div>
  )
}

/** A page's title and its one line, in the page title and small roles. */
export function PageHeader({
  id,
  title,
  children,
}: {
  id?: string
  title: ReactNode
  children?: ReactNode
}) {
  return (
    <header className="flex flex-col gap-1 pb-7">
      <h2 id={id} className="font-heading text-title font-medium text-balance">
        {title}
      </h2>
      {children && <p className="text-small text-pretty text-tertiary">{children}</p>}
    </header>
  )
}

function NavRow({
  section,
  selected,
  dim,
  count,
  onChoose,
}: {
  section: SectionDef
  selected: boolean
  /** While searching, a section without matches; it stays a way to its page. */
  dim: boolean
  count: number | null
  onChoose: () => void
}) {
  const Icon = section.icon
  return (
    <button
      type="button"
      aria-current={selected ? 'page' : undefined}
      onClick={onChoose}
      className={cn(
        'group flex h-row shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-ui text-primary outline-none transition-[background-color,opacity] duration-(--duration-fast) focus-ring',
        selected ? 'bg-selected' : 'hover:bg-hover',
        dim && 'opacity-42',
      )}
    >
      <Icon
        className={cn(
          'size-4 shrink-0 transition-colors duration-(--duration-fast)',
          selected ? 'text-primary' : 'text-icon group-hover:text-primary',
        )}
      />
      <span className="min-w-0 flex-1 truncate">{section.title}</span>
      {section.mark && (
        <span
          role="img"
          aria-label={section.mark}
          title={section.mark}
          className="mr-1 size-1.5 shrink-0 rounded-full bg-info"
        />
      )}
      {count !== null && (
        <span
          key={count}
          className="h-4.5 min-w-4.5 shrink-0 animate-in rounded-full bg-surface px-1.25 text-center text-meta leading-4.5 font-normal text-secondary tabular shadow-[inset_0_0_0_var(--hairline)_var(--border-default)] fade-in animation-duration-(--duration-base)"
        >
          {count}
        </span>
      )}
    </button>
  )
}

/** The app's version at the foot of the list, and what its updater has to say; opens About. */
function AppFooter() {
  const { t } = useTranslation('settings')
  const status = useUpdatesStore((s) => s.status)
  if (!status) return null
  const label = footerLabel(status.state)
  const end: ReactNode = !label ? null : label.pill ? (
    <Badge variant="info" className="min-w-0 shrink">
      <span className="truncate">{t(label.key, label.values)}</span>
    </Badge>
  ) : (
    <span className="truncate text-xs text-tertiary tabular">{t(label.key, label.values)}</span>
  )
  return (
    <button
      type="button"
      title={t('footer.about')}
      onClick={() => openSettings('about')}
      className="mx-2 flex h-8 shrink-0 items-center gap-1.5 rounded-lg pr-1.5 pl-2.5 text-left text-command text-secondary outline-none transition-colors duration-(--duration-fast) hover:bg-hover focus-ring"
    >
      <span>Kettu</span>
      <span className="font-mono text-code text-tertiary">{status.current}</span>
      <span className="ml-auto flex min-w-0 items-center">{end}</span>
    </button>
  )
}

function SearchResults({
  query,
  hits,
  count,
  onGo,
}: {
  query: string
  hits: SectionDef[]
  count: number
  onGo: (section: SectionDef, row: RowDef) => void
}) {
  const { t } = useTranslation('settings')
  return (
    <>
      <PageHeader id="settings-results" title={t('page.results')}>
        {count > 0 && t('page.resultsLine', { query, count })}
      </PageHeader>
      {count === 0 ? (
        <Empty className="px-6 py-14">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchIcon />
            </EmptyMedia>
            <EmptyTitle>{t('page.noMatch', { query })}</EmptyTitle>
            <EmptyDescription>{t('page.noMatchHint')}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-7">
          {hits.map(
            (section) =>
              section.rows.length > 0 && (
                <section key={section.id} aria-label={section.title} className="flex flex-col">
                  <GroupLabel
                    group={{ id: section.id, label: section.title, count: section.rows.length }}
                  />
                  <RowGroup>
                    {section.rows.map((row) => (
                      <button
                        key={row.id}
                        type="button"
                        onClick={() => onGo(section, row)}
                        className="relative flex min-h-15 w-full items-center gap-4 py-2.5 pr-3 pl-4 text-left outline-none transition-colors duration-(--duration-fast) before:absolute before:top-0 before:right-0 before:left-4 before:h-(--hairline) before:bg-border-soft first:rounded-t-xl first:before:hidden last:rounded-b-xl hover:bg-hover focus-ring"
                      >
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="text-ui font-medium">
                            <Marked text={row.name} query={query} />
                          </span>
                          {row.description && (
                            <span className="mt-0.5 line-clamp-2 text-xs leading-4 text-secondary">
                              <Marked text={excerpt(row.description, query)} query={query} />
                            </span>
                          )}
                        </span>
                        <ChevronRightIcon className="size-4 shrink-0 text-icon" />
                      </button>
                    ))}
                  </RowGroup>
                </section>
              ),
          )}
        </div>
      )}
    </>
  )
}

function Marked({ text, query }: { text: string; query: string }) {
  return highlight(text, query).map((part, i) =>
    part.match ? (
      <mark key={i} className="rounded-sm bg-mark text-inherit">
        {part.text}
      </mark>
    ) : (
      <Fragment key={i}>{part.text}</Fragment>
    ),
  )
}

function BackButton() {
  const { t } = useTranslation('settings')
  const waiting = useSessionsStore((s) =>
    Object.values(s.byId).reduce((sum, x) => sum + x.permissionCount, 0),
  )
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="quiet"
            size="sm"
            className="app-region-no-drag gap-1.5 pr-2 pl-1.5 text-ui font-normal text-primary"
            onClick={closeSettings}
          />
        }
      >
        <ArrowLeftIcon data-icon="inline-start" className="size-4" />
        {t('page.back')}
        {waiting > 0 && (
          <span
            aria-label={t('page.waiting', { count: waiting })}
            className="ml-0.5 inline-flex h-4.5 min-w-4.5 animate-in items-center justify-center rounded-full bg-attention px-1.25 text-meta font-semibold text-attention-foreground tabular zoom-in-75 fade-in"
          >
            {waiting}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {t('page.back')}
        <Kbd>{formatShortcut('Esc')}</Kbd>
      </TooltipContent>
    </Tooltip>
  )
}
