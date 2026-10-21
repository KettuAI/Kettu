import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowLeftIcon, SearchIcon, XIcon } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@renderer/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@renderer/components/ui/input-group'
import { Kbd } from '@renderer/components/ui/kbd'
import { formatShortcut, isMac, isMod } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { useSessionsStore } from '@renderer/stores/sessions'
import { prefersReducedMotion } from '@renderer/stores/settings'
import { closeSettings, useViewStore, type SettingsSection } from '@renderer/stores/view'
import { matches, type RowDef, type SectionDef } from './model'
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
} from './section-defs'

/** Settings take the whole window: one scrolling page with a table of contents and search. */
export default function SettingsPage() {
  const sections: SectionDef[] = [
    useGeneralSection(),
    useAppearanceSection(),
    useAgentsSection(),
    useTerminalSection(),
    useGitSection(),
    useNotificationsSection(),
    useShortcutsSection(),
    useAdvancedSection(),
    useAboutSection(),
  ]
  const [query, setQuery] = useState('')
  const searching = query.trim().length > 0
  const shown = sections.map((s) => ({
    ...s,
    rows: s.rows.filter((r) => matches(r, query.trim())),
  }))
  const anyMatch = shown.some((s) => s.rows.length > 0)
  const initial = useViewStore((s) => s.settings.section)
  const [active, setActive] = useState<SettingsSection>(initial ?? 'general')
  const scroller = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)

  const scrollTo = (id: SettingsSection, smooth: boolean) => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-section="${id}"]`)
    el?.scrollIntoView({
      block: 'start',
      behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto',
    })
  }
  const jump = (id: SettingsSection) => {
    setActive(id)
    scrollTo(id, true)
  }

  // Opening at a section, such as Agents from the sign-in notice, lands on it at once.
  useLayoutEffect(() => {
    if (initial) scrollTo(initial, false)
    // Only on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The table of contents follows the section in view.
  useEffect(() => {
    const root = scroller.current
    if (!root) return
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        const id = visible?.target.getAttribute('data-section') as SettingsSection | null
        if (id) setActive(id)
      },
      { root, rootMargin: '0px 0px -70% 0px' },
    )
    for (const el of root.querySelectorAll('[data-section]')) observer.observe(el)
    return () => observer.disconnect()
  }, [query])

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
    <div className="flex h-full animate-in bg-background fade-in duration-(--duration-fast)">
      <aside className="flex w-[244px] shrink-0 flex-col bg-sidebar">
        <div className="app-region-drag flex h-top-bar shrink-0 items-center gap-1 pr-2.5 pl-3">
          {isMac && <span aria-hidden className="w-[66px] shrink-0" />}
          <BackButton />
        </div>
        <div className="flex flex-col gap-3 px-3 pt-2 pb-3">
          <h1 className="px-1 text-[19px] leading-tight font-semibold tracking-[-0.01em]">
            Settings
          </h1>
          <InputGroup className="h-control bg-card shadow-outline">
            <InputGroupAddon>
              <SearchIcon className="size-3.5" />
            </InputGroupAddon>
            <InputGroupInput
              ref={search}
              value={query}
              placeholder="Search settings"
              aria-label="Search settings"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKey}
              className="text-[13px]"
            />
            <InputGroupAddon align="inline-end">
              {query ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => {
                    setQuery('')
                    search.current?.focus()
                  }}
                  className="flex size-5 items-center justify-center rounded-[5px] hover:bg-accent hover:text-foreground"
                >
                  <XIcon className="size-3" />
                </button>
              ) : (
                <Kbd className="h-auto bg-transparent p-0 text-[11px] font-normal">
                  {formatShortcut('Mod+F')}
                </Kbd>
              )}
            </InputGroupAddon>
          </InputGroup>
        </div>
        <nav aria-label="Sections" className="flex flex-col gap-px overflow-y-auto px-2 pb-4">
          {shown.map((section) => {
            const count = section.rows.length
            const disabled = searching && count === 0
            return (
              <button
                key={section.id}
                type="button"
                disabled={disabled}
                aria-current={!searching && active === section.id ? 'true' : undefined}
                onClick={() => jump(section.id)}
                className={cn(
                  'flex h-row items-center gap-2 rounded-lg px-2 text-left text-[13px] outline-none transition-colors duration-(--duration-fast) focus-visible:ring-2 focus-visible:ring-ring/50',
                  !searching && active === section.id
                    ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground/85 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground',
                  disabled && 'pointer-events-none opacity-40',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{section.title}</span>
                {searching && count > 0 && (
                  <span
                    key={count}
                    className="animate-in text-xs text-muted-foreground tabular fade-in duration-(--duration-base)"
                  >
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </nav>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="app-region-drag h-top-bar shrink-0" />
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
          <div className="mx-auto flex max-w-[700px] flex-col gap-9 px-8 pt-1 pb-24">
            {shown.map(
              (section) =>
                section.rows.length > 0 && (
                  <section
                    key={section.id}
                    data-section={section.id}
                    aria-labelledby={`settings-${section.id}`}
                    className="flex scroll-mt-4 flex-col gap-2.5"
                  >
                    <h2 id={`settings-${section.id}`} className="px-1 text-[13px] font-semibold">
                      {section.title}
                    </h2>
                    <SectionBody section={section} />
                    {!searching && section.footer}
                  </section>
                ),
            )}
            {!anyMatch && (
              <Empty className="pt-16">
                <EmptyHeader>
                  <EmptyTitle>No settings match “{query.trim()}”</EmptyTitle>
                  <EmptyDescription>
                    Try another word, such as theme, proxy or shell.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}

function SectionBody({ section }: { section: SectionDef }) {
  if (section.rows.every((r) => r.layout === 'custom')) {
    return (
      <div className="flex flex-col gap-2.5">
        {section.rows.map((row) => (
          <div key={row.id} className="rounded-xl bg-card px-4 py-3.5 shadow-card">
            {row.render()}
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className="flex flex-col rounded-xl bg-card shadow-card">
      {section.rows.map((row, i) => (
        <Row key={row.id} row={row} first={i === 0} />
      ))}
    </div>
  )
}

function Row({ row, first }: { row: RowDef; first: boolean }) {
  const text = (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[13px] font-medium">{row.name}</span>
      {row.description && (
        <span className="text-xs leading-normal text-muted-foreground">{row.description}</span>
      )}
    </div>
  )
  return (
    <div className={cn('px-4 py-3', !first && 'border-t border-border-soft')}>
      {row.layout === 'block' ? (
        <div className="flex flex-col gap-3">
          {text}
          {row.render()}
        </div>
      ) : (
        <div className="flex min-h-[28px] items-center gap-6">
          <div className="min-w-0 flex-1">{text}</div>
          <div className="flex shrink-0 items-center gap-2">{row.render()}</div>
        </div>
      )}
    </div>
  )
}

function BackButton() {
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
      Back
      {waiting > 0 && (
        <span
          aria-label={`${waiting} waiting for approval`}
          className="ml-0.5 inline-flex h-[18px] min-w-[18px] animate-in items-center justify-center rounded-full bg-attention px-1.5 text-[11px] font-semibold text-attention-foreground tabular zoom-in-75 fade-in"
        >
          {waiting}
        </span>
      )}
    </Button>
  )
}
