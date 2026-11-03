import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { originLabel } from '@shared/browser'
import type { AllowedSites } from '@shared/ipc'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage } from '@renderer/lib/host'
import { useViewStore } from '@renderer/stores/view'

/** A site agents may open without asking, the projects that allow it, and whether it is going. */
export interface AllowedSite {
  origin: string
  projects: string[]
  removing: boolean
}

/**
 * The sites projects let agents open, one entry per site with every project that allows it, read
 * when Settings opens and again each time the Browser page shows; removing one takes it from each
 * of those projects. `error` is why the read or the last removal failed.
 */
export function useAllowedSites(): {
  sites: AllowedSite[] | null
  error: string | null
  remove: (origin: string) => void
  reload: () => void
} {
  const { t } = useTranslation('settings')
  const [list, setList] = useState<AllowedSites[] | null>(null)
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [reads, setReads] = useState(0)
  const shown = useViewStore((s) => s.settings.open && s.settings.section === 'browser')
  const [shownBefore, setShownBefore] = useState(shown)
  if (shown !== shownBefore) {
    setShownBefore(shown)
    if (shown) {
      setError(null)
      setReads((n) => n + 1)
    }
  }

  useEffect(() => {
    let cancelled = false
    window.kettu.browser.allowedSites().then(
      (sites) => {
        if (!cancelled) setList(sites)
      },
      (e: unknown) => {
        if (!cancelled) setError(errorMessage(e))
      },
    )
    return () => {
      cancelled = true
    }
  }, [reads])

  const sites = list && allowedByOrigin(list, removing)
  const remove = (origin: string) => {
    const projects = (list ?? [])
      .filter((site) => site.origins.includes(origin))
      .map((site) => site.projectPath)
    setRemoving((current) => new Set(current).add(origin))
    setError(null)
    void Promise.allSettled(
      projects.map((project) => window.kettu.browser.removeAllowedSite(project, origin)),
    )
      .then((results) => {
        setList((current) => current && afterRemoval(current, origin, projects, results))
        const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
        if (failed) {
          setError(
            t('browser.allowedSites.removeFailed', {
              origin: originLabel(origin),
              reason: errorMessage(failed.reason),
            }),
          )
        } else toast(t('browser.allowedSites.removed', { origin: originLabel(origin) }))
      })
      .finally(() =>
        setRemoving((current) => {
          const next = new Set(current)
          next.delete(origin)
          return next
        }),
      )
  }
  const reload = () => {
    setError(null)
    setReads((n) => n + 1)
  }
  return { sites, error, remove, reload }
}

/** Each site once, in the order first allowed, with the projects that allow it. */
export function allowedByOrigin(
  list: AllowedSites[],
  removing: ReadonlySet<string> = new Set(),
): AllowedSite[] {
  const byOrigin = new Map<string, string[]>()
  for (const site of list) {
    for (const origin of site.origins) {
      const projects = byOrigin.get(origin) ?? []
      projects.push(site.projectPath)
      byOrigin.set(origin, projects)
    }
  }
  return [...byOrigin].map(([origin, projects]) => ({
    origin,
    projects,
    removing: removing.has(origin),
  }))
}

/**
 * The list once `origin`'s removal from each of `projects` settled, `results` in the same order:
 * the projects whose removal went through lose it, and those whose removal failed keep it. A
 * project left with no site drops out.
 */
export function afterRemoval(
  list: AllowedSites[],
  origin: string,
  projects: readonly string[],
  results: readonly PromiseSettledResult<unknown>[],
): AllowedSites[] {
  const removed = new Set(projects.filter((_, i) => results[i]?.status === 'fulfilled'))
  return list
    .map((site) =>
      removed.has(site.projectPath)
        ? { ...site, origins: site.origins.filter((o) => o !== origin) }
        : site,
    )
    .filter((site) => site.origins.length > 0)
}
