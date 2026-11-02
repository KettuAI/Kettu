import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { originLabel } from '@shared/browser'
import type { AllowedSites } from '@shared/ipc'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage } from '@renderer/lib/host'

/** A site agents may open without asking, and the projects that allow it. */
export interface AllowedSite {
  origin: string
  projects: string[]
}

/**
 * The sites projects let agents open, one entry per site with every project that allows it, read
 * when Settings opens; removing one takes it from each of those projects.
 */
export function useAllowedSites(): {
  sites: AllowedSite[] | null
  error: string | null
  busy: string | null
  remove: (origin: string) => void
} {
  const { t } = useTranslation('settings')
  const [list, setList] = useState<AllowedSites[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.kettu.browser
      .allowedSites()
      .then((sites) => {
        if (!cancelled) setList(sites)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const sites = list && allowedByOrigin(list)
  const remove = (origin: string) => {
    const from = (list ?? []).filter((site) => site.origins.includes(origin))
    setBusy(origin)
    setError(null)
    void Promise.all(
      from.map((site) => window.kettu.browser.removeAllowedSite(site.projectPath, origin)),
    )
      .then(() => {
        setList(
          (current) =>
            current
              ?.map((site) => ({ ...site, origins: site.origins.filter((o) => o !== origin) }))
              .filter((site) => site.origins.length > 0) ?? null,
        )
        toast(t('browser.allowedSites.removed', { origin: originLabel(origin) }))
      })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(null))
  }
  return { sites, error, busy, remove }
}

/** Each site once, in the order first allowed, with the projects that allow it. */
export function allowedByOrigin(list: AllowedSites[]): AllowedSite[] {
  const byOrigin = new Map<string, string[]>()
  for (const site of list) {
    for (const origin of site.origins) {
      const projects = byOrigin.get(origin) ?? []
      projects.push(site.projectPath)
      byOrigin.set(origin, projects)
    }
  }
  return [...byOrigin].map(([origin, projects]) => ({ origin, projects }))
}
