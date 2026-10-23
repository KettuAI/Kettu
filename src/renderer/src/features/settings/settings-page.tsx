import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { ArrowLeftIcon, ChevronRightIcon, CircleArrowUpIcon, SearchIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@renderer/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@renderer/components/ui/input-group'
import { Kbd } from '@renderer/components/ui/kbd'
import { formatShortcut, isMac, isMod } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useUpdatesStore } from '@renderer/stores/updates'
import {
  closeSettings,
  openSettings,
  useViewStore,
  type SettingsSection,
} from '@renderer/stores/view'
import { AgentPage } from './agents-section'
import { FlashContext, highlight, matches, type RowDef, type SectionDef } from './model'
import { SectionBody } from './rows'
import {
  useAboutSection,
  useAdvancedSection,
  useAgentsSection,
  useAppearanceSection,
  useGeneralSection,
  useGitSection,
  useNotificationsSection,
  useShortcutsSection,
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
  // The list in three clusters: how the app looks and behaves, the agents and their tools, then
  // the rest.
  const clusters: SectionDef[][] = [
    [useGeneralSection(), useAppearanceSection(), useNotificationsSection(), useShortcutsSection()],
    [useAgentsSection(), useUsageSection(), useTerminalSection(), useGitSection()],
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
  const agent = useViewStore((s) => (s.settings.section === 'agents' ? s.settings.agent : null))
  const scroller = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const [jump, setJump] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)

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
    if (row.open) {
      row.open()
      return
    }
    openSettings(section.id)
    setJump(row.id)
  }

  // Every page, and the results, start at the top; a search result starts at its row.
  useLayoutEffect(() => {
    const view = scroller.current
    if (!view) return
    const row = jump ? view.querySelector<HTMLElement>(`[data-setting-row="${jump}"]`) : null
    if (row) {
      row.scrollIntoView({ block: 'center' })
      setFlash(jump)
      setJump(null)
    } else {
      view.scrollTop = 0
    }
  }, [active, agent, searching, jump])

  useEffect(() => {
    if (!flash) return
    const timer = setTimeout(() => setFlash(null), FLASH_MS)
    return () => clearTimeout(timer)
  }, [flash])

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (isMod(event) && !event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        search.current?.focus()
        search.current?.select()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    if (query) setQuery('')
    else event.currentTarget.blur()
  }

  return (
    <div className="flex h-full animate-in bg-background fade-in animation-duration-(--duration-fast)">
      <aside className="flex w-[244px] shrink-0 flex-col bg-sidebar">
        <div className="app-region-drag flex h-top-bar shrink-0 items-center gap-1 pr-2.5 pl-3">
          {isMac && <span aria-hidden className="w-[calc(14px+var(--traffic-lights))] shrink-0" />}
          <BackButton />
        </div>
        <div className="flex flex-col gap-3 px-3 pt-1.5 pb-3.5">
          <h1 className="px-1 text-heading font-semibold">{t('page.title')}</h1>
          <InputGroup className="h-control bg-card shadow-outline">
            <InputGroupAddon>
              <SearchIcon className="size-3.5" />
            </InputGroupAddon>
            <InputGroupInput
              ref={search}
              value={query}
              placeholder={t('page.search')}
              aria-label={t('page.search')}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKey}
              className="text-ui"
            />
            <InputGroupAddon align="inline-end">
              {query ? (
                <button
                  type="button"
                  aria-label={t('page.clearSearch')}
                  onClick={() => {
                    setQuery('')
                    search.current?.focus()
                  }}
                  className="flex size-5 items-center justify-center rounded-md hover:bg-accent hover:text-foreground"
                >
                  <XIcon className="size-3" />
                </button>
              ) : (
                <Kbd className="h-auto bg-transparent p-0 font-normal">
                  {formatShortcut('Mod+F')}
                </Kbd>
              )}
            </InputGroupAddon>
          </InputGroup>
        </div>
        <nav
          aria-label={t('page.sections')}
          className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 pb-3"
        >
          {clusters.map((cluster, i) => (
            <Fragment key={i}>
              {i > 0 && <span aria-hidden className="h-2.5 shrink-0" />}
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
            </Fragment>
          ))}
        </nav>
        <AppFooter />
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="app-region-drag h-top-bar shrink-0" />
        <div
          ref={scroller}
          className="min-h-0 flex-1 overflow-y-auto px-8 [scrollbar-gutter:stable_both-edges]"
        >
          <FlashContext.Provider value={flash}>
            <div
              key={searching ? 'results' : agent ? `agents/${agent}` : page.id}
              className="mx-auto flex w-full max-w-[560px] animate-in flex-col pt-1 pb-24 fade-in animation-duration-(--duration-fast)"
            >
              {searching ? (
                <SearchResults query={needle} hits={hits} count={hitCount} onGo={go} />
              ) : agent ? (
                <AgentPage agentId={agent} />
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
    <header className="flex flex-col gap-1.5 px-1 pb-7">
      <h2 id={id} className="text-title font-semibold text-balance">
        {title}
      </h2>
      {children && <p className="text-small text-pretty text-muted-foreground">{children}</p>}
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
  dim: boolean
  count: number | null
  onChoose: () => void
}) {
  const Icon = section.icon
  return (
    <button
      type="button"
      disabled={dim}
      aria-current={selected ? 'page' : undefined}
      onClick={onChoose}
      className={cn(
        'group flex h-8 shrink-0 items-center gap-2.5 rounded-lg px-2 text-left text-ui outline-none transition-colors duration-(--duration-fast) focus-visible:ring-2 focus-visible:ring-ring/50',
        selected
          ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
          : 'text-sidebar-foreground/85 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground',
        dim && 'pointer-events-none opacity-40',
      )}
    >
      <Icon
        className={cn(
          'size-4 shrink-0 transition-colors duration-(--duration-fast)',
          selected
            ? 'text-sidebar-accent-foreground'
            : 'text-muted-foreground group-hover:text-sidebar-foreground',
        )}
      />
      <span className="min-w-0 flex-1 truncate">{section.title}</span>
      {count !== null ? (
        <span
          key={count}
          className="animate-in text-xs text-muted-foreground tabular fade-in animation-duration-(--duration-base)"
        >
          {count}
        </span>
      ) : (
        section.mark && (
          <span
            role="img"
            aria-label={section.mark}
            title={section.mark}
            className="size-1.5 shrink-0 rounded-full bg-checked"
          />
        )
      )}
    </button>
  )
}

/** The app's version at the foot of the list, and what its updater has to say; opens About. */
function AppFooter() {
  const { t } = useTranslation('settings')
  const status = useUpdatesStore((s) => s.status)
  if (!status) return null
  const { state } = status
  const end: ReactNode =
    state.kind === 'ready' ? (
      <Badge variant="info" className="min-w-0 shrink">
        <CircleArrowUpIcon data-icon="inline-start" />
        <span className="truncate">{t('footer.restartToUpdate')}</span>
      </Badge>
    ) : state.kind === 'available' ? (
      <Badge variant="info" className="min-w-0 shrink">
        <CircleArrowUpIcon data-icon="inline-start" />
        <span className="truncate">{t('footer.available', { version: state.version })}</span>
      </Badge>
    ) : state.kind === 'downloading' ? (
      <span className="truncate tabular">
        {t('footer.downloading', { percent: Math.round(state.percent) })}
      </span>
    ) : state.kind === 'idle' ? (
      t('footer.upToDate')
    ) : null
  return (
    <button
      type="button"
      title={t('footer.about')}
      onClick={() => openSettings('about')}
      className="group mx-2 mb-2.5 flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-left text-xs text-muted-foreground outline-none transition-colors duration-(--duration-fast) hover:bg-sidebar-accent/70 focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <span className="font-medium text-sidebar-foreground/85 group-hover:text-sidebar-foreground">
        OverBench
      </span>
      <span className="font-mono text-meta">{status.current}</span>
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
  if (count === 0) {
    return (
      <Empty className="pt-16">
        <EmptyHeader>
          <SearchIcon className="size-4 text-muted-foreground" />
          <EmptyTitle>{t('page.noMatch', { query })}</EmptyTitle>
          <EmptyDescription>{t('page.noMatchHint')}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <>
      <PageHeader id="settings-results" title={t('page.results')}>
        {t('page.resultsLine', { query, count })}
      </PageHeader>
      <div className="flex flex-col gap-7">
        {hits.map(
          (section) =>
            section.rows.length > 0 && (
              <section key={section.id} aria-label={section.title} className="flex flex-col">
                <div className="flex h-7.5 items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
                  <h3>{section.title}</h3>
                  <span className="font-normal tabular">{section.rows.length}</span>
                </div>
                {section.rows.map((row) => (
                  <div key={row.id} className="border-t border-border-soft">
                    <button
                      type="button"
                      onClick={() => onGo(section, row)}
                      className="-mx-2 flex w-[calc(100%+--spacing(4))] items-center gap-4 rounded-lg px-3 py-3 text-left outline-none transition-colors duration-(--duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="text-ui font-medium">
                          <Marked text={row.name} query={query} />
                        </span>
                        {row.description && (
                          <span className="text-xs leading-normal text-muted-foreground">
                            <Marked text={row.description} query={query} />
                          </span>
                        )}
                      </span>
                      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
                    </button>
                  </div>
                ))}
              </section>
            ),
        )}
      </div>
    </>
  )
}

function Marked({ text, query }: { text: string; query: string }) {
  return highlight(text, query).map((part, i) =>
    part.match ? (
      <mark key={i} className="rounded-sm bg-mark px-px text-inherit">
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
    <Button
      variant="quiet"
      size="compact"
      className="app-region-no-drag gap-1.5 px-2"
      onClick={closeSettings}
    >
      <ArrowLeftIcon data-icon="inline-start" />
      {t('page.back')}
      {waiting > 0 && (
        <span
          aria-label={t('page.waiting', { count: waiting })}
          className="ml-0.5 inline-flex h-[18px] min-w-[18px] animate-in items-center justify-center rounded-full bg-attention px-1.5 text-meta font-semibold text-attention-foreground tabular zoom-in-75 fade-in"
        >
          {waiting}
        </span>
      )}
    </Button>
  )
}
