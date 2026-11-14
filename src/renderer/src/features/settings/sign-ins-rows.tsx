import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BroughtSite } from '@shared/signins'
import { toast } from '@renderer/components/ui/toast'
import { BrowserMark, SiteTile } from '@renderer/features/browser/sign-in-parts'
import { shortBrowserName } from '@renderer/features/browser/sign-in-text'
import { monthDay } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useDefaultBrowser } from '@renderer/stores/site-icons'
import {
  loadSources,
  openBringSignIns,
  preferredSource,
  useSignInsStore,
} from '@renderer/stores/sign-ins'
import { ControlError, SetButton } from './controls'
import { ItemLine, Thing } from './rows'

/** Bring sign-ins: its mark is the browser used most here, as the dialog picks it first. */
export function BringSignInsRow() {
  const { t } = useTranslation('settings')
  const sources = useSignInsStore((s) => s.sources)
  const defaultBrowser = useDefaultBrowser().name
  useEffect(() => {
    void loadSources().catch(() => {})
  }, [])
  const source = sources ? preferredSource(sources, defaultBrowser) : null
  return (
    <div className="ui-sg-row ksi-bring-row">
      <Thing mark={<BrowserMark browser={source} size={20} />} name={t('browser.signIns.name')}>
        <ItemLine>{t('browser.signIns.description')}</ItemLine>
      </Thing>
      <SetButton onClick={openBringSignIns}>{t('browser.signIns.button')}</SetButton>
    </div>
  )
}

/** A brought site: where it came from and when, and Remove, which signs Kettu's browser out. */
export function BroughtSiteRow({ site }: { site: BroughtSite }) {
  const { t } = useTranslation('settings')
  const sources = useSignInsStore((s) => s.sources)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const browser = shortBrowserName(
    sources?.find((source) => source.browser === site.browser)?.name ?? BROWSER_NAMES[site.browser],
  )
  const remove = () => {
    setRemoving(true)
    setError(null)
    window.kettu.signIns.remove(site.site).then(
      () => toast(t('browser.signIns.removed', { site: site.site })),
      (e: unknown) => {
        setRemoving(false)
        setError(t('browser.signIns.removeFailed', { site: site.site, reason: errorMessage(e) }))
      },
    )
  }
  return (
    <div className="ui-sg-row">
      <Thing mark={<SiteTile site={site.site} large />} name={site.site}>
        <ItemLine>
          {t('browser.signIns.from', {
            browser,
            profile: site.profile,
            date: monthDay(site.at),
          })}
        </ItemLine>
      </Thing>
      <ControlError error={error} />
      <SetButton loading={removing} onClick={remove}>
        {t('browser.signIns.remove')}
      </SetButton>
    </div>
  )
}

const BROWSER_NAMES: Record<BroughtSite['browser'], string> = {
  chrome: 'Google Chrome',
  edge: 'Microsoft Edge',
  brave: 'Brave',
  arc: 'Arc',
  firefox: 'Firefox',
  safari: 'Safari',
}

/** Show all, or fewer, under the first brought sites. */
export function BroughtMoreRow({
  count,
  all,
  onToggle,
}: {
  count: number
  all: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation('settings')
  return (
    <div className="ui-sg-row ksi-brought-more">
      <button type="button" aria-expanded={all} onClick={onToggle}>
        {all ? t('browser.signIns.showFewer') : t('browser.signIns.showAll', { count })}
      </button>
    </div>
  )
}
