import { useDevicesSection } from './devices-section'
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { ChevronRightIcon, SearchIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { popupOpen } from '@renderer/app/shortcuts'
import { AgentMarkHost } from '@renderer/components/agents/agent-mark-host'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@renderer/components/ui/empty'
import { formatShortcut, isMod, isWeb } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import {
  hostScope,
  HostScopeContext,
  LOCAL_SCOPE,
  useSettingsHostStore,
  type HostScope,
} from '@renderer/stores/host-scope'
import { isAway, useOtherHost } from '@renderer/stores/hosts'
import {
  closeSettings,
  openSettings,
  settingsBack,
  useViewStore,
  type SettingsSection,
} from '@renderer/stores/view'
import { HostPicker } from './host-picker'
import { HOST_SECTIONS } from './host-sections'
import { excerpt, FlashContext, highlight, matches, type RowDef, type SectionDef } from './model'
import { GroupLabel, PageHeader, SectionBody } from './rows'
import { webClusters } from './web-sections'
import {
  useAboutSection,
  useAccountSection,
  useArchivedSection,
  useArtifactsSection,
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
import { useComputerUseSection } from './computer-section'

const FLASH_MS = 1200

/**
 * Settings open as a sheet over the app, which stays in view under the scrim: a list of sections
 * and search on the left, the selected section on the right. While searching, the page gives way
 * to the matching rows, each of which opens its page at the row. The client's own sections are
 * this computer's; the host's show the host the picker chose.
 */
export default function SettingsPage() {
  const { t } = useTranslation('settings')
  const open = useViewStore((s) => s.settings.open)
  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (next) return
        // Esc steps back from an item's page first, and leaves a field being typed in alone.
        if (details.reason === 'escape-key') {
          details.cancel()
          if (!isEditable(details.event.target)) settingsBack()
          return
        }
        closeSettings()
      }}
    >
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Popup
          // The section in the list takes the focus, so Tab starts from it, without scrolling the
          // list down to a section near its end, which would hide the search above it.
          initialFocus={() => {
            const current = document.querySelector<HTMLElement>(
              '[data-settings-dialog] nav [aria-current=page]',
            )
            if (!current) return true
            current.focus({ preventScroll: true })
            return false
          }}
          data-overlay-layer=""
          data-settings-dialog=""
          className="fixed top-14 left-1/2 z-50 flex h-[calc(100%-112px)] w-[calc(100%-48px)] max-w-265 -translate-x-1/2 flex-col overflow-hidden rounded-modal bg-surface text-primary shadow-dialog outline-none duration-(--duration-fast) [--segment-thumb:var(--bg-surface)] data-open:animate-in data-open:fade-in-0 data-open:slide-in-from-bottom-1 data-closed:animate-out data-closed:fade-out-0"
        >
          <header className="flex h-13.5 shrink-0 items-center pr-3 pl-5.5 shadow-[inset_0_calc(-1*var(--hairline))_0_var(--border-subtle)]">
            <DialogTitle className="flex-1 font-sans text-label font-semibold tracking-normal">
              {t('page.title')}
            </DialogTitle>
            <DialogClose
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('page.close')}
                  className="rounded-xl text-secondary [&_svg:not([class*='size-'])]:size-4.25"
                />
              }
            >
              <XIcon />
            </DialogClose>
          </header>
          <SettingsBody />
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  )
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return (
    el.isContentEditable ||
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT'
  )
}

function SettingsBody() {
  const client = [
    useGeneralSection(),
    useAppearanceSection(),
    useNotificationsSection(),
    useAccountSection(),
    useHostsSection(),
    useBrowserSection(),
    useDevicesSection(),
    useComputerUseSection(),
  ]
  const about = useAboutSection()
  const hostId = useShownHost()
  const scope = useMemo(() => (hostId === null ? LOCAL_SCOPE : hostScope(hostId)), [hostId])
  // Opened again, Settings starts at this computer, as every way into it means this computer.
  useEffect(() => () => useSettingsHostStore.setState({ hostId: null }), [])
  return (
    <HostScopeContext.Provider value={scope}>
      <AgentMarkHost.Provider value={scope.hostId}>
        <SettingsLayout client={client} about={about} scope={scope} />
      </AgentMarkHost.Provider>
    </HostScopeContext.Provider>
  )
}

/**
 * The host the picker chose while it can be shown: known here, and not away. One that goes away
 * leaves the picker at this computer, so it does not come back by itself later.
 */
function useShownHost(): string | null {
  const chosen = useSettingsHostStore((s) => s.hostId)
  const host = useOtherHost(chosen)
  const shown = host && !isAway(host.connection) ? host.id : null
  useEffect(() => {
    if (chosen !== null && shown === null) useSettingsHostStore.setState({ hostId: null })
  }, [chosen, shown])
  return shown
}

function SettingsLayout({
  client,
  about,
  scope,
}: {
  client: SectionDef[]
  about: SectionDef
  scope: HostScope
}) {
  const { t } = useTranslation('settings')
  // The list in clusters: what belongs to this client first, then the host's, then About.
  const all: SectionDef[][] = [
    client,
    [
      useAgentsSection(),
      useHarnessesSection(),
      useUsageSection(),
      useGitSection(),
      useMcpSection(),
    ],
    [useArchivedSection(), useArtifactsSection(), useSharingSection(), useTerminalSection()],
    [useRemoteSection(), useAdvancedSection()],
    [about],
  ]
  // The list and the page come from the same sections, so the web client lists only its own.
  const clusters = isWeb ? webClusters(all) : all
  const picker = !isWeb
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
  const loadMcp = scope.useMcpStore((s) => s.load)
  useEffect(() => {
    void loadMcp()
  }, [loadMcp])
  useEffect(() => {
    if (active === 'mcp') void loadMcp()
  }, [active, item, loadMcp])
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
        // A dialog or menu over Settings keeps the focus: the search lies under it.
        if (popupOpen()) return
        event.preventDefault()
        search.current?.focus()
        search.current?.select()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="flex min-h-0 flex-1">
      <nav
        aria-label={t('page.sections')}
        className="flex w-59 shrink-0 flex-col overflow-y-auto px-3 py-3.5 shadow-[inset_calc(-1*var(--hairline))_0_0_var(--border-subtle)]"
      >
        <SettingsSearch value={query} onChange={setQuery} inputRef={search} />
        {clusters.map((cluster, i) => (
          <Fragment key={i}>
            {picker && i === 1 && <HostPicker hostId={scope.hostId} />}
            <div className="mt-2 flex flex-col gap-px">
              {cluster.map((section) => {
                const count = hits.find((h) => h.id === section.id)?.rows.length ?? 0
                return (
                  <NavRow
                    key={section.id}
                    section={section}
                    selected={!searching && section.id === page.id}
                    dim={searching && count === 0}
                    count={searching && count > 0 ? count : null}
                    onChoose={() => choose(section.id)}
                  />
                )
              })}
            </div>
          </Fragment>
        ))}
      </nav>
      <div
        ref={scroller}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto px-8 pt-6.5 pb-12 [scrollbar-gutter:stable]"
      >
        <FlashContext.Provider value={flash}>
          {/* A client's section shows this computer's own, whichever host the picker chose. */}
          <HostScopeContext.Provider value={HOST_SECTIONS.has(page.id) ? scope : LOCAL_SCOPE}>
            <AgentMarkHost.Provider value={HOST_SECTIONS.has(page.id) ? scope.hostId : null}>
              <div
                key={
                  (searching ? 'results' : item ? `${page.id}/${item}` : page.id) +
                  (HOST_SECTIONS.has(page.id) ? `@${scope.hostId ?? ''}` : '')
                }
                className="flex animate-in flex-col fade-in animation-duration-(--duration-fast)"
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
            </AgentMarkHost.Provider>
          </HostScopeContext.Provider>
        </FlashContext.Provider>
      </div>
    </div>
  )
}

function SettingsSearch({
  value,
  onChange,
  inputRef,
}: {
  value: string
  onChange: (value: string) => void
  inputRef: RefObject<HTMLInputElement | null>
}) {
  const { t } = useTranslation('settings')
  return (
    <label className="flex h-row shrink-0 items-center gap-2.25 rounded-xl bg-subtle pr-2 pl-2.5 text-tertiary transition-shadow duration-(--duration-fast) has-focus-visible:shadow-[0_0_0_var(--hairline)_var(--focus),var(--focus-halo)]">
      <SearchIcon className="size-3.75 shrink-0" />
      <input
        ref={inputRef}
        value={value}
        placeholder={t('page.search')}
        aria-label={t('page.search')}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(event) => {
          // Esc clears the search, then leaves the field; it does not close Settings.
          if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
          event.stopPropagation()
          if (value) onChange('')
          else event.currentTarget.blur()
        }}
        className="min-w-0 flex-1 bg-transparent text-lede text-primary outline-none placeholder:text-tertiary"
      />
      {value ? (
        <button
          type="button"
          aria-label={t('page.clearSearch')}
          onClick={() => {
            onChange('')
            inputRef.current?.focus()
          }}
          className="flex size-5 shrink-0 items-center justify-center rounded-md outline-none hover:bg-hover hover:text-primary focus-ring"
        >
          <XIcon className="size-3" strokeWidth={1.75} />
        </button>
      ) : (
        <span aria-hidden className="shrink-0 pr-0.5 text-caption">
          {formatShortcut('Mod+F')}
        </span>
      )}
    </label>
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
        'flex h-row shrink-0 items-center gap-2.75 rounded-tile px-2.5 text-left text-row outline-none transition-[background-color,color,opacity] duration-(--duration-fast) focus-ring [&>svg]:text-tertiary',
        selected
          ? 'bg-selected font-medium text-foreground [&>svg]:text-secondary'
          : 'text-secondary hover:bg-hover hover:text-foreground',
        dim && 'opacity-42',
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{section.title}</span>
      {section.mark && count === null && (
        <span
          role="img"
          aria-label={section.mark}
          title={section.mark}
          className="size-1.75 shrink-0 rounded-full bg-attention-dot"
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
        hits.map(
          (section) =>
            section.rows.length > 0 && (
              <section key={section.id} aria-label={section.title} className="flex flex-col">
                <GroupLabel
                  group={{ id: section.id, label: section.title, count: section.rows.length }}
                />
                <div className="shadow-[inset_0_var(--hairline)_0_var(--border-subtle)]">
                  {section.rows.map((row) => (
                    // The hairline sits on the row, straight, under the rounded hover of its button.
                    <div
                      key={row.id}
                      className="shadow-[inset_0_calc(-1*var(--hairline))_0_var(--border-subtle)]"
                    >
                      <button
                        type="button"
                        onClick={() => onGo(section, row)}
                        className="flex w-full items-center gap-4 rounded-lg py-3.75 text-left outline-none transition-colors duration-(--duration-fast) hover:bg-hover focus-ring"
                      >
                        <span className="flex min-w-0 flex-1 flex-col gap-0.75">
                          <span className="text-label">
                            <Marked text={row.name} query={query} />
                          </span>
                          {row.description && (
                            <span className="line-clamp-2 text-group leading-normal text-tertiary">
                              <Marked text={excerpt(row.description, query)} query={query} />
                            </span>
                          )}
                        </span>
                        <ChevronRightIcon className="size-3.5 shrink-0 text-tertiary" />
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            ),
        )
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
