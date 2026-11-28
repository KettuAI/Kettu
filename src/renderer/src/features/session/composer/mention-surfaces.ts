// The terminals, browser tabs and devices of a session's side panel that a message can mention,
// from the stores that hold each. Browser tabs prefer this desktop window's own live tabs and fall
// back to tabs reported to the session's agent host so web and remote desktop clients can list and
// reference pages seamlessly.

import { useEffect, useMemo } from 'react'
import type { BrowserTab, SessionBrowserTab } from '@shared/browser'
import { useBrowserStore } from '@renderer/stores/browser'
import { useDevicesStore } from '@renderer/stores/devices'
import {
  ensureSessionBrowserTabs,
  loadSessionBrowserTabs,
  useSessionBrowserTabsStore,
} from '@renderer/stores/session-browser-tabs'
import { mentionTerminalsOf, useTerminalsStore } from '@renderer/stores/terminals'
import { panelSession } from '@renderer/stores/view'
import { surfaceMention, type MentionItem, type MentionSurfaces } from './chips'

/** A browser tab row offered in the composer's `@` mention popover. */
export interface BrowserTabMentionRow {
  browserTab: true
  id: string
  name: string
  url: string | null
  active: boolean
  /** The token inserted after `@`, e.g. `page:t1`. */
  mention: string
}

type ListedBrowserTab = Pick<BrowserTab | SessionBrowserTab, 'id' | 'title' | 'url'> & {
  active: boolean
}

/**
 * Resolves the browser tabs to show and mention for a session: local Electron tabs when this
 * window holds any for the session, otherwise tabs reported to the session's agent host.
 */
export function effectiveBrowserTabs(
  local: { tabs: readonly BrowserTab[]; selected: string | null } | undefined,
  reported: readonly SessionBrowserTab[] | undefined,
): ListedBrowserTab[] {
  if (local && local.tabs.length > 0) {
    return local.tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      url: tab.url,
      active: tab.id === local.selected,
    }))
  }
  return (reported ?? []).map((tab) => ({
    id: tab.id,
    title: tab.title,
    url: tab.url,
    active: tab.active,
  }))
}

function browserTabsOf(sessionId: string | null): ListedBrowserTab[] {
  if (!sessionId) return []
  return effectiveBrowserTabs(
    useBrowserStore.getState().bySession[sessionId],
    useSessionBrowserTabsStore.getState().bySession[sessionId],
  )
}

function pagesOf(sessionId: string | null): MentionItem[] {
  return browserTabsOf(sessionId).map((tab) => ({
    id: tab.id,
    name: tab.title || tab.url || tab.id,
  }))
}

function devicesOf(sessionId: string | null): MentionItem[] {
  if (!sessionId) return []
  return useDevicesStore
    .getState()
    .devices.filter((device) => device.sessionId === sessionId)
    .map((device) => ({ id: device.id, name: device.name }))
}

/** Filters a session's browser tabs for the composer `@` mention query. */
export function matchBrowserTabMentions(
  tabs: readonly ListedBrowserTab[],
  query: string,
): BrowserTabMentionRow[] {
  const needle = query.trim().toLowerCase()
  const rows: BrowserTabMentionRow[] = []
  for (const tab of tabs) {
    const name = tab.title || tab.url || tab.id
    const mention = surfaceMention('page', tab.id).slice(1)
    if (needle !== '') {
      const hay = `${name}\n${tab.url ?? ''}\n${mention}\npage browser tab`.toLowerCase()
      if (!hay.includes(needle)) continue
    }
    rows.push({
      browserTab: true,
      id: tab.id,
      name,
      url: tab.url,
      active: tab.active,
      mention,
    })
  }
  return rows
}

/** What a panel's session can mention now: its session's, or New session's terminals alone. */
export function mentionSurfacesOf(panel: string | null): MentionSurfaces {
  const sessionId = panel ? panelSession(panel) : null
  return {
    terminal: mentionTerminalsOf(useTerminalsStore.getState().byId, panel),
    page: pagesOf(sessionId),
    device: devicesOf(sessionId),
  }
}

/** `mentionSurfacesOf` as a hook, which changes only when what it lists changes. */
export function useMentionSurfaces(panel: string | null): MentionSurfaces {
  const sessionId = panel ? panelSession(panel) : null
  const terminals = useTerminalsStore((s) => JSON.stringify(mentionTerminalsOf(s.byId, panel)))
  const localPages = useBrowserStore((s) =>
    JSON.stringify(
      sessionId
        ? (s.bySession[sessionId]?.tabs ?? []).map((tab) => [
            tab.id,
            tab.title || tab.url || tab.id,
          ])
        : [],
    ),
  )
  const reportedPages = useSessionBrowserTabsStore((s) =>
    JSON.stringify(
      sessionId
        ? (s.bySession[sessionId] ?? []).map((tab) => [tab.id, tab.title || tab.url || tab.id])
        : [],
    ),
  )
  const hasLocalPages = localPages !== '[]'
  useEffect(() => {
    if (sessionId && !hasLocalPages) ensureSessionBrowserTabs(sessionId)
  }, [sessionId, hasLocalPages])
  const devices = useDevicesStore((s) =>
    JSON.stringify(
      sessionId
        ? s.devices.filter((d) => d.sessionId === sessionId).map((d) => [d.id, d.name])
        : [],
    ),
  )
  return useMemo(() => {
    const items = (json: string) =>
      (JSON.parse(json) as [string, string][]).map(([id, name]) => ({ id, name }))
    return {
      terminal: JSON.parse(terminals) as MentionItem[],
      page: items(hasLocalPages ? localPages : reportedPages),
      device: items(devices),
    }
  }, [terminals, hasLocalPages, localPages, reportedPages, devices])
}

const NO_TAB_ROWS: BrowserTabMentionRow[] = []

/**
 * The session's open browser tabs matching the current `@` mention query, refreshing from the
 * session's host when the picker opens without local desktop tabs.
 */
export function useMentionBrowserTabs(
  sessionId: string | null,
  query: string | null,
): BrowserTabMentionRow[] {
  const active = query !== null && sessionId !== null
  const localKey = useBrowserStore((s) => {
    if (!active) return ''
    const state = s.bySession[sessionId]
    if (!state || state.tabs.length === 0) return ''
    return JSON.stringify(
      state.tabs.map((tab) => [tab.id, tab.title, tab.url, tab.id === state.selected]),
    )
  })
  const reportedKey = useSessionBrowserTabsStore((s) => {
    if (!active) return ''
    const tabs = s.bySession[sessionId]
    if (!tabs || tabs.length === 0) return ''
    return JSON.stringify(tabs.map((tab) => [tab.id, tab.title, tab.url, tab.active]))
  })
  const hasLocal = localKey !== ''
  useEffect(() => {
    if (active && !hasLocal) void loadSessionBrowserTabs(sessionId)
  }, [active, hasLocal, sessionId])
  return useMemo(() => {
    if (!active || query === null) return NO_TAB_ROWS
    const key = hasLocal ? localKey : reportedKey
    if (!key) return NO_TAB_ROWS
    const tabs = (JSON.parse(key) as [string, string | null, string | null, boolean][]).map(
      ([id, title, url, isActive]) => ({ id, title, url, active: isActive }),
    )
    return matchBrowserTabMentions(tabs, query)
  }, [active, query, hasLocal, localKey, reportedKey])
}
