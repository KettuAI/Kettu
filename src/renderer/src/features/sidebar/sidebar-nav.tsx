import type { ReactNode } from 'react'
import {
  Analytics01Icon,
  DashboardSquare02Icon,
  PencilEdit02Icon,
  RepeatIcon,
  Store01Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { RoutineView } from '@shared/routines'
import { newSession } from '@renderer/app/actions'
import type { AppShellProps, ShellNavItem } from '@renderer/components/affect/app-shell'
import { strongestSignal, signalText } from '@renderer/features/routines/model'
import { useRoutinesStore } from '@renderer/stores/routines'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import {
  openArtifacts,
  openMarketplace,
  openRoutines,
  openUsage,
  useViewStore,
} from '@renderer/stores/view'
import { RoutineSignalMark, TightestLimit, TodayCost, TodayTokens } from './nav-ends'

/**
 * The sidebar's menu for App Shell: New session, Artifacts, Routines, Marketplace and Usage, with
 * the row the main area shows marked, and the Routines and Usage rows' marks at their ends.
 */
export function useSidebarNav(): Pick<AppShellProps, 'nav' | 'active' | 'onNavigate'> {
  const { t } = useTranslation('sidebar')
  const { t: tu } = useTranslation('usage')
  const labels = {
    newSession: t('nav.newSession'),
    artifacts: t('nav.artifacts'),
    routines: t('nav.routines'),
    marketplace: t('nav.marketplace'),
    usage: tu('nav.usage'),
  }
  const routines = useRoutinesRow()
  const usageEnd = useUsageEnd()
  const current = useViewStore((s) => {
    if (s.settings.open) return null
    const main = s.main
    if (main.kind === 'new') return 'newSession'
    if (main.kind === 'artifacts' || (main.kind === 'artifact' && main.back.kind === 'artifacts'))
      return 'artifacts'
    if (main.kind === 'routines' || main.kind === 'routine') return 'routines'
    if (main.kind === 'marketplace') return 'marketplace'
    if (main.kind === 'usage') return 'usage'
    return null
  })
  const routineRun = useRoutineRunShown()
  const active = current ?? (routineRun ? 'routines' : null)
  const nav: ShellNavItem[] = [
    { label: labels.newSession, icon: PencilEdit02Icon },
    { label: labels.artifacts, icon: DashboardSquare02Icon },
    { label: labels.routines, icon: RepeatIcon, end: routines.end, ariaLabel: routines.name },
    { label: labels.marketplace, icon: Store01Icon },
    { label: labels.usage, icon: Analytics01Icon, end: usageEnd },
  ]
  return {
    nav,
    active: active ? labels[active] : undefined,
    onNavigate: (label) => {
      if (label === labels.newSession) newSession()
      else if (label === labels.artifacts) openArtifacts()
      else if (label === labels.routines) openRoutines()
      else if (label === labels.marketplace) openMarketplace()
      else if (label === labels.usage) openUsage()
    },
  }
}

/** Whether the main area shows a session a routine ran, which the Routines row stands for. */
function useRoutineRunShown(): boolean {
  const id = useViewStore((s) =>
    s.main.kind === 'session' && !s.settings.open ? s.main.sessionId : null,
  )
  return useSessionsStore((s) => (id ? s.byId[id]?.origin === 'routine' : false))
}

/** The Routines row's end: the strongest signal among the routines' runs, and its name. */
function useRoutinesRow(): { end: ReactNode; name: string | undefined } {
  const { t: tr } = useTranslation('routines')
  const routines = useRoutinesStore(
    useShallow((s) =>
      s.order.map((id) => s.byId[id]).filter((routine): routine is RoutineView => !!routine),
    ),
  )
  const signal = strongestSignal(routines)
  if (!signal) return { end: undefined, name: undefined }
  return {
    end: <RoutineSignalMark signal={signal} />,
    name: tr('signal.name', { signal: signalText(signal) }),
  }
}

/** The Usage row's end: today's tokens, cost or plan limit, as Settings chooses. */
function useUsageEnd(): ReactNode {
  const end = useSettingsStore((s) => s.settings.usage.sidebar)
  return end === 'today' ? (
    <TodayTokens />
  ) : end === 'cost' ? (
    <TodayCost />
  ) : end === 'limit' ? (
    <TightestLimit />
  ) : undefined
}
