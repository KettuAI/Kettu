import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowDown01Icon, Globe02Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { BrowserState, BrowserTab } from '@shared/browser'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { PaneIcon, PaneTabClose } from '@renderer/features/shell/panel-button'
import { loadSiteIcons, useSiteIcon } from '@renderer/stores/site-icons'
import { addressText } from './address'

/** Below this width per tab the strip shows only the selected tab's name. */
const FULL_TAB_PX = 112

const ENTER = { opacity: 0, y: 4, filter: 'blur(4px)' }
const SHOWN = { opacity: 1, y: 0, filter: 'blur(0px)' }
const LEAVE = { opacity: 0, filter: 'blur(4px)' }

/** A tab's name: its page's title, its address, or New tab while it is blank. */
function useTabName(): (tab: BrowserTab) => string {
  const { t } = useTranslation('browser')
  return (tab) => tab.title || (tab.url ? (addressText(tab.url) ?? tab.url) : t('tabs.blank'))
}

/**
 * The browser's tabs, the user's and the agent's in one strip; the agent's carries a dot while a
 * turn uses it. When they do not fit, the others show only their site icon.
 */
export function BrowserTabs({
  state,
  agentName,
  onSelect,
  onClose,
  onCollapsed,
}: {
  state: BrowserState
  agentName: string
  onSelect: (tabId: string) => void
  onClose: (tabId: string) => void
  onCollapsed: (collapsed: boolean) => void
}) {
  const { t } = useTranslation('browser')
  const strip = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const collapsed = width > 0 && state.tabs.length * FULL_TAB_PX > width

  useLayoutEffect(() => {
    const element = strip.current?.parentElement
    if (!element) return
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element)
    setWidth(element.clientWidth)
    return () => observer.disconnect()
  }, [])

  useEffect(() => onCollapsed(collapsed), [collapsed, onCollapsed])

  return (
    <div
      ref={strip}
      role="tablist"
      aria-label={t('tabs.label')}
      className="kp-head__tabs kp-btabs"
      data-collapsed={collapsed || undefined}
    >
      <AnimatePresence initial={false} mode="popLayout">
        {state.tabs.map((tab) => (
          <Tab
            key={tab.id}
            tab={tab}
            selected={tab.id === state.selected}
            agent={tab.id === state.agentTab ? state.control.kind : null}
            agentName={agentName}
            openerName={nameOf(state.tabs, tab.opener)}
            onSelect={() => onSelect(tab.id)}
            onClose={() => onClose(tab.id)}
          />
        ))}
      </AnimatePresence>
    </div>
  )
}

function nameOf(tabs: readonly BrowserTab[], id: string | null): string | null {
  const tab = id ? tabs.find((other) => other.id === id) : undefined
  return tab ? tab.title || (tab.url ? (addressText(tab.url) ?? tab.url) : null) : null
}

function Tab({
  tab,
  selected,
  agent,
  agentName,
  openerName,
  onSelect,
  onClose,
}: {
  tab: BrowserTab
  selected: boolean
  /** Who uses the tab, when it is the agent's. */
  agent: BrowserState['control']['kind'] | null
  agentName: string
  openerName: string | null
  onSelect: () => void
  onClose: () => void
}) {
  const { t } = useTranslation('browser')
  const name = useTabName()(tab)
  const button = useRef<HTMLButtonElement>(null)
  const note =
    agent === 'agent'
      ? t('tabs.agentUsing', { agent: agentName })
      : agent === 'you'
        ? t('tabs.agentWaiting', { agent: agentName })
        : agent === 'asks'
          ? t('tabs.agentAsks', { agent: agentName })
          : tab.released
            ? t('tabs.releasedNote')
            : openerName
              ? t('tabs.openedBy', { name: openerName })
              : tab.url

  // A full strip scrolls; a tab selected out of sight, such as a popup, comes into view.
  useEffect(() => {
    if (selected) button.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [selected])

  return (
    <motion.span
      layout="position"
      initial={ENTER}
      animate={SHOWN}
      exit={LEAVE}
      transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
      className="kp-tab kp-btab"
      data-selected={selected || undefined}
      data-agent={agent ?? undefined}
      data-released={tab.released || undefined}
    >
      <button
        ref={button}
        type="button"
        role="tab"
        aria-selected={selected}
        title={note ? `${name} · ${note}` : name}
        onClick={onSelect}
        onAuxClick={(event) => event.button === 1 && onClose()}
        className="kp-tab__btn"
      >
        <SiteMark url={tab.url} />
        <span className="kp-tab__name">{name}</span>
        {agent && agent !== 'idle' && (
          <span role="img" aria-label={note ?? undefined} className="kp-btab__who" />
        )}
      </button>
      <PaneTabClose label={t('actions.closeTab', { name })} onClick={onClose} />
    </motion.span>
  )
}

/** The count of tabs, which lists every one; the agent's names it, released ones say so. */
export function TabCountMenu({
  state,
  agentName,
  onSelect,
}: {
  state: BrowserState
  agentName: string
  onSelect: (tabId: string) => void
}) {
  const { t } = useTranslation('browser')
  const nameOf = useTabName()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={t('tabs.all')}
            title={t('tabs.all')}
            className="kp-tool kp-tabcount app-region-no-drag"
          />
        }
      >
        <span>{state.tabs.length}</span>
        <PaneIcon icon={ArrowDown01Icon} size={12} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="kp-tablist">
        <DropdownMenuLabel>{t('tabs.count', { count: state.tabs.length })}</DropdownMenuLabel>
        {state.tabs.map((tab) => {
          const address = tab.url ? (addressText(tab.url) ?? tab.url) : null
          const who =
            tab.id === state.agentTab ? agentName : tab.released ? t('tabs.released') : null
          const description = [who, address].filter(Boolean).join(' · ')
          return (
            <DropdownMenuItem key={tab.id} onClick={() => onSelect(tab.id)}>
              <SiteMark url={tab.url} />
              <span className="kp-tablist__text">
                <span className="kp-tablist__name">{nameOf(tab)}</span>
                {description && <span className="kp-tablist__note">{description}</span>}
              </span>
              {tab.id === state.selected && (
                <PaneIcon icon={Tick02Icon} size={14} className="kp-tablist__check" />
              )}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The page's site icon, as recorded when it opened, else a globe. */
export function SiteMark({ url }: { url: string | null }) {
  useEffect(loadSiteIcons, [])
  const icon = useSiteIcon(url ?? '')
  if (icon) return <img src={icon} alt="" aria-hidden className="kp-sitemark" />
  return <PaneIcon icon={Globe02Icon} size={14} className="kp-tab__icon" />
}
