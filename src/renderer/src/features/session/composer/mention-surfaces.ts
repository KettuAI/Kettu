// The terminals, browser tabs and devices of a session's side panel that a message can mention,
// from the stores that hold each.

import { useMemo } from 'react'
import { useBrowserStore } from '@renderer/stores/browser'
import { useDevicesStore } from '@renderer/stores/devices'
import { mentionTerminalsOf, useTerminalsStore } from '@renderer/stores/terminals'
import { panelSession } from '@renderer/stores/view'
import type { MentionItem, MentionSurfaces } from './chips'

function pagesOf(sessionId: string | null): MentionItem[] {
  if (!sessionId) return []
  const tabs = useBrowserStore.getState().bySession[sessionId]?.tabs ?? []
  return tabs.map((tab) => ({ id: tab.id, name: tab.title || tab.url || tab.id }))
}

function devicesOf(sessionId: string | null): MentionItem[] {
  if (!sessionId) return []
  return useDevicesStore
    .getState()
    .devices.filter((device) => device.sessionId === sessionId)
    .map((device) => ({ id: device.id, name: device.name }))
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
  const pages = useBrowserStore((s) =>
    JSON.stringify(
      sessionId
        ? (s.bySession[sessionId]?.tabs ?? []).map((tab) => [
            tab.id,
            tab.title || tab.url || tab.id,
          ])
        : [],
    ),
  )
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
      page: items(pages),
      device: items(devices),
    }
  }, [terminals, pages, devices])
}
