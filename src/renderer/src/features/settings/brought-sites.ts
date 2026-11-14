import { useEffect } from 'react'
import type { BroughtSite } from '@shared/signins'
import { loadBrought, useSignInsStore } from '@renderer/stores/sign-ins'
import { useViewStore } from '@renderer/stores/view'

/** How many brought sites the page lists before "Show all". */
export const BROUGHT_SHOWN = 3

/** The brought sites, read when Settings opens and again each time the Browser page shows. */
export function useBroughtSites(): BroughtSite[] | null {
  const shown = useViewStore((s) => s.settings.open && s.settings.section === 'browser')
  useEffect(() => {
    if (shown) loadBrought()
  }, [shown])
  return useSignInsStore((s) => s.brought)
}
