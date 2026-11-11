import { useDevicesSection } from './devices-section'
import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { ArrowRight01Icon, Cancel01Icon, Search01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { popupOpen } from '@renderer/app/shortcuts'
import { AgentMarkHost } from '@renderer/components/agents/agent-mark-host'
import { css as shellCss, Icon } from '@renderer/components/affect/app-shell'
import { css as generalCss } from '@renderer/components/affect/settings-general'
import { css as modelsCss } from '@renderer/components/affect/settings-models'
import { css as prefsCss } from '@renderer/components/affect/settings-preferences'
import { css as securityCss } from '@renderer/components/affect/settings-security'
import { Dialog, DialogPortal } from '@renderer/components/ui/dialog'
import { useCloudOff } from '@renderer/lib/cloud'
import { formatShortcut, isMod, isWeb } from '@renderer/lib/platform'
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
import { useTasksSection } from '@renderer/features/tasks/tiers-section'
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
  useNotificationsSection,
  useRemoteSection,
  useSharingSection,
  useTerminalSection,
  useUsageSection,
} from './section-defs'
import { useComputerUseSection } from './computer-section'

const FLASH_MS = 1200

/**
 * Settings open as a modal over the app, which stays in view under the scrim: the list of
 * sections and search on the left, the selected section on the right. The view store opens and
 * closes it; Esc steps back from an item's page first.
 */
export default function SettingsPage() {
  const open = useViewStore((s) => s.settings.open)
  const title = useId()
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
        <DialogPrimitive.Backdrop className="kettu-settings-scrim app-region-no-drag" />
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
          aria-labelledby={title}
          data-overlay-layer=""
          data-settings-dialog=""
          className="ui-as kettu-settings app-region-no-drag"
        >
          <SettingsContent titleId={title} />
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

/** The sheets the settings screens are drawn with; React hoists each once. */
function SettingsStyles() {
  return (
    <>
      <style href="ui-app-shell" precedence="default">
        {shellCss}
      </style>
      <style href="ui-settings-general" precedence="default">
        {generalCss}
      </style>
      <style href="ui-settings-security" precedence="default">
        {securityCss}
      </style>
      <style href="ui-settings-models" precedence="default">
        {modelsCss}
      </style>
      <style href="ui-settings-preferences" precedence="default">
        {prefsCss}
      </style>
    </>
  )
}

/**
 * The modal's content, for whatever holds it: the section list and the shown section. It reads
 * and changes the view store itself, and its close button closes Settings. The element holding it
 * carries `ui-as kettu-settings`, which give it the box and the shell's variables.
 */
export function SettingsContent({ titleId }: { titleId?: string }) {
  const cloudOff = useCloudOff()
  const account = useAccountSection()
  const client = [
    useGeneralSection(),
    useAppearanceSection(),
    useNotificationsSection(),
    ...(cloudOff ? [] : [account]),
    useHostsSection(),
    useBrowserSection(),
    useDevicesSection(),
    useComputerUseSection(),
  ]
  const about = useAboutSection()
  const hostId = useShownHost()
  const scope = useMemo(() => (hostId === null ? LOCAL_SCOPE : hostScope(hostId)), [hostId])
  return (
    <HostScopeContext.Provider value={scope}>
      <AgentMarkHost.Provider value={scope.hostId}>
        <SettingsStyles />
        <SettingsLayout client={client} about={about} scope={scope} titleId={titleId} />
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
  titleId,
}: {
  client: SectionDef[]
  about: SectionDef
  scope: HostScope
  titleId?: string
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
      useTasksSection(),
    ],
    [useArchivedSection(), useArtifactsSection(), useSharingSection(), useTerminalSection()],
    [useRemoteSection(), useAdvancedSection()],
    [about],
  ]
  // The list and the page come from the same sections, so the web client lists only its own.
  const clusters = isWeb ? webClusters(all) : all
  const picker = !isWeb
  const sections = clusters.flat()
  // Drawn as three groups, as the settings list has them: this client's, the host's, About.
  const groups =
    clusters.length > 2 ? [clusters[0]!, clusters.slice(1, -1).flat(), clusters.at(-1)!] : clusters
  const [query, setQuery] = useState('')
  const needle = query.trim()
  const searching = needle.length > 0
  const hits = sections.map((s) => ({ ...s, rows: s.rows.filter((r) => matches(r, needle)) }))
  const hitCount = hits.reduce((sum, s) => sum + s.rows.length, 0)
  const active = useViewStore((s) => s.settings.section) ?? 'general'
  const page = sections.find((s) => s.id === active) ?? sections[0]!
  const item = useViewStore((s) => (s.settings.section === active ? s.settings.item : null))
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

  const hostPage = HOST_SECTIONS.has(page.id)
  return (
    <>
      <nav aria-label={t('page.sections')} className="kettu-settings__nav">
        <h2 id={titleId} className="kettu-settings__title">
          {t('page.title')}
        </h2>
        <SettingsSearch value={query} onChange={setQuery} inputRef={search} />
        <div className="kettu-settings__list">
          {groups.map((group, i) => (
            <div key={i} className="kettu-settings__group">
              {picker && i === 1 && <HostPicker hostId={scope.hostId} />}
              {group.map((section) => {
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
          ))}
        </div>
      </nav>
      <div ref={scroller} className="kettu-settings__page">
        <button
          type="button"
          className="ui-as-icon-btn kettu-settings__close"
          aria-label={t('page.close')}
          onClick={closeSettings}
        >
          <Icon icon={Cancel01Icon} size={16} />
        </button>
        <FlashContext.Provider value={flash}>
          {/* A client's section shows this computer's own, whichever host the picker chose. */}
          <HostScopeContext.Provider value={hostPage ? scope : LOCAL_SCOPE}>
            <AgentMarkHost.Provider value={hostPage ? scope.hostId : null}>
              <div
                key={
                  (searching ? 'results' : item ? `${page.id}/${item}` : page.id) +
                  (hostPage ? `@${scope.hostId ?? ''}` : '')
                }
                className="ui-as-page ui-sg ui-ss ui-sm ui-spf kettu-settings__body"
              >
                {searching ? (
                  <SearchResults query={needle} hits={hits} count={hitCount} onGo={go} />
                ) : item && page.itemPage ? (
                  page.itemPage(item)
                ) : (
                  <section aria-labelledby={`settings-${page.id}`}>
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
    </>
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
    <label className="kettu-settings__search">
      <Icon icon={Search01Icon} size={14} />
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
      />
      {value ? (
        <button
          type="button"
          aria-label={t('page.clearSearch')}
          className="kettu-settings__clear"
          onClick={() => {
            onChange('')
            inputRef.current?.focus()
          }}
        >
          <Icon icon={Cancel01Icon} size={10} />
        </button>
      ) : (
        <kbd aria-hidden>{formatShortcut('Mod+F')}</kbd>
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
  return (
    <button
      type="button"
      aria-current={selected ? 'page' : undefined}
      data-dim={dim || undefined}
      onClick={onChoose}
      className="ui-as-side__item"
    >
      <Icon icon={section.icon} size={15} />
      <span className="ui-as-side__text">{section.title}</span>
      {section.mark && count === null && (
        <span
          role="img"
          aria-label={section.mark}
          title={section.mark}
          className="kettu-settings__dot"
        />
      )}
      {count !== null && (
        <span key={count} className="ui-as-side__count">
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
        <div className="ui-as-empty">
          <span className="ui-as-empty__icon">
            <Icon icon={Search01Icon} size={18} />
          </span>
          <b className="ui-as-empty__title">{t('page.noMatch', { query })}</b>
          <p className="ui-as-empty__text">{t('page.noMatchHint')}</p>
        </div>
      ) : (
        <div className="k-groups">
          {hits.map(
            (section) =>
              section.rows.length > 0 && (
                <section key={section.id} aria-label={section.title} className="k-group">
                  <GroupLabel
                    group={{ id: section.id, label: section.title, count: section.rows.length }}
                  />
                  <div className="ui-sg-card">
                    {section.rows.map((row) => (
                      <div key={row.id} className="k-row">
                        <button
                          type="button"
                          onClick={() => onGo(section, row)}
                          className="ui-sg-row k-item k-result"
                        >
                          <span className="ui-sg-label">
                            <b>
                              <Marked text={row.name} query={query} />
                            </b>
                            {row.description && (
                              <small className="k-clamp">
                                <Marked text={excerpt(row.description, query)} query={query} />
                              </small>
                            )}
                          </span>
                          <span className="k-chevron">
                            <Icon icon={ArrowRight01Icon} size={14} />
                          </span>
                        </button>
                      </div>
                    ))}
                  </div>
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
      <mark key={i} className="k-hl">
        {part.text}
      </mark>
    ) : (
      <Fragment key={i}>{part.text}</Fragment>
    ),
  )
}
