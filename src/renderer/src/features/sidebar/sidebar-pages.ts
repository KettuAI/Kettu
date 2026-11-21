import {
  DashboardSquare02Icon,
  KanbanIcon,
  PieChartIcon,
  Store01Icon,
  TimeScheduleIcon,
} from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'
import { SIDEBAR_PAGES, type SettingsPatch, type SidebarPage } from '@shared/settings'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage } from '@renderer/lib/host'
import { useSettingsStore } from '@renderer/stores/settings'
import {
  openArtifacts,
  openMarketplace,
  openOverview,
  openRoutines,
  openSettingsRow,
  openUsage,
} from '@renderer/stores/view'

/** Each page's icon, the same wherever the page is named. */
export const PAGE_ICON: Record<SidebarPage, IconSvgElement> = {
  overview: KanbanIcon,
  artifacts: DashboardSquare02Icon,
  routines: TimeScheduleIcon,
  marketplace: Store01Icon,
  usage: PieChartIcon,
}

export const OPEN_PAGE: Record<SidebarPage, () => void> = {
  overview: openOverview,
  artifacts: openArtifacts,
  routines: openRoutines,
  marketplace: openMarketplace,
  usage: openUsage,
}

/** The page's row in Settings › Appearance, as its catalog entry names it. */
export function pageRow(page: SidebarPage): string {
  return `sidebar-${page}`
}

/** Whether the order and hidden pages are as they first come. */
export function isDefaultPages(order: readonly SidebarPage[], hidden: readonly SidebarPage[]) {
  return hidden.length === 0 && order.every((page, i) => page === SIDEBAR_PAGES[i])
}

function update(patch: SettingsPatch): void {
  useSettingsStore
    .getState()
    .update(patch)
    .catch((e: unknown) => toast(errorMessage(e)))
}

export function hidePage(page: SidebarPage): void {
  const { sidebarHidden } = useSettingsStore.getState().settings.appearance
  if (!sidebarHidden.includes(page))
    update({ appearance: { sidebarHidden: [...sidebarHidden, page] } })
}

/** Opens the sidebar's group in Settings at a page's row, or at the first page's. */
export function customizeSidebar(page?: SidebarPage): void {
  const first = useSettingsStore.getState().settings.appearance.sidebarOrder[0]
  openSettingsRow('appearance', null, pageRow(page ?? first ?? SIDEBAR_PAGES[0]))
}
