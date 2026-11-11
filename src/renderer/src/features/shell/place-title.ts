import { useTranslation } from 'react-i18next'
import type { AgentId, HarnessId } from '@shared/thread'
import { shortAgo } from '@renderer/lib/format'
import { i18n } from '@renderer/lib/i18n'
import { AGENT_NAMES, agentName } from '@renderer/stores/agents'
import { useArtifactsStore } from '@renderer/stores/artifacts'
import { listingTitle } from '@renderer/features/marketplace/model'
import { hostScope, LOCAL_SCOPE } from '@renderer/stores/host-scope'
import { otherHosts, useHostsStore } from '@renderer/stores/hosts'
import { useRemoteStore } from '@renderer/stores/remote'
import { useRoutinesStore } from '@renderer/stores/routines'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import type { HistoryPlace, SettingsPlace } from '@renderer/stores/view'
import { useWindowScope, windowHost } from '@renderer/stores/window-host'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// Bound to the namespace only: each call reads the language shown at the time.
const t = i18n.getFixedT(null, 'shell')

/** A place's name in the history's lists and tooltips, from what the stores hold now. */
export function placeTitle(place: HistoryPlace): string {
  switch (place.kind) {
    case 'session':
      return sessionTitle(useSessionsStore.getState().byId[place.sessionId] ?? {})
    case 'new':
      return t('history.places.newSession')
    case 'usage':
      return t('history.places.usage')
    case 'routines':
      return t('history.places.routines')
    case 'routine':
      if (place.routineId === null) return t('history.places.newRoutine')
      return useRoutinesStore.getState().byId[place.routineId]?.name ?? t('history.places.routines')
    case 'artifacts':
      return place.deleted ? t('history.places.recentlyDeleted') : t('history.places.artifacts')
    case 'marketplace': {
      const shown = windowHost()
      // The Marketplace works on the window's host, so its listings are named from that host's.
      const scope =
        shown.kind === 'one' && shown.hostId !== null ? hostScope(shown.hostId) : LOCAL_SCOPE
      const title = place.item ? listingTitle(scope, place.item) : null
      return title
        ? t('history.places.marketplaceItem', { item: title })
        : t('history.places.marketplace')
    }
    case 'artifact': {
      const { list, deleted } = useArtifactsStore.getState()
      const found = [...(list ?? []), ...(deleted ?? [])].find((a) => a.id === place.id)
      return found?.title || t('history.places.artifact')
    }
    case 'settings': {
      const section = sectionName(place.section)
      const item = itemName(place)
      return item
        ? t('history.places.settingsItem', { section, item })
        : t('history.places.settings', { section })
    }
    case 'launch':
      return ''
  }
}

/** A place's name, kept current as its session, routine, artifact or listing is renamed. */
export function usePlaceTitle(place: HistoryPlace): string {
  useTranslation('shell')
  useSessionsStore((s) => (place.kind === 'session' ? s.byId[place.sessionId]?.title : null))
  useRoutinesStore((s) =>
    place.kind === 'routine' && place.routineId ? s.byId[place.routineId]?.name : null,
  )
  useArtifactsStore((s) => (place.kind === 'artifact' ? s.list : null))
  useWindowScope().useMarketplaceStore((s) =>
    place.kind === 'marketplace' && place.item ? s.catalog : null,
  )
  return placeTitle(place)
}

function sectionName(section: SettingsPlace['section']): string {
  // Plan usage is the one section named in its own feature's catalog.
  return section === 'usage'
    ? i18n.t('usage:settings.title')
    : i18n.t(`settings:sections.${section}`)
}

/** The name of the item a Settings page shows, where the stores know it. */
function itemName({ section, item }: SettingsPlace): string | null {
  if (!item) return null
  switch (section) {
    case 'agents':
      return agentName(item as AgentId)
    case 'harnesses':
      return AGENT_NAMES[item as HarnessId] ?? null
    case 'hosts':
      return otherHosts(useHostsStore.getState()).find((host) => host.id === item)?.name ?? null
    case 'remote':
      return useRemoteStore.getState().status?.devices.find((d) => d.id === item)?.name ?? null
    default:
      return null
  }
}

/** How long ago a place was left, for the history: "just now", "5 min", "2 h", then a day. */
export function placeAgo(at: number, now = Date.now()): string {
  const delta = Math.max(0, now - at)
  if (delta < MINUTE) return t('history.ago.now')
  if (delta < HOUR) return t('history.ago.minutes', { count: Math.floor(delta / MINUTE) })
  if (delta < DAY) return t('history.ago.hours', { count: Math.floor(delta / HOUR) })
  return shortAgo(at, now)
}
