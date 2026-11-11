// The parts every listing shares: its frame with Back, links, and its loading and missing states.

import type { ReactNode } from 'react'
import { ArrowLeft01Icon, LinkSquare02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { AwayContent, WindowHostAway } from '@renderer/features/shell/window-host-away'
import { useHostScope } from '@renderer/stores/host-scope'
import { useWindowHostAway } from '@renderer/stores/window-host'

/**
 * What the page shows of its host, greyed and out of reach while that host is offline, under the
 * notice that says whether it is what was last read.
 */
export function MarketAway({ children }: { children: ReactNode }) {
  const { useMarketplaceStore } = useHostScope()
  const away = useWindowHostAway() !== null
  const read = useMarketplaceStore(
    (s) => s.catalog !== null || s.plugins !== null || s.skills !== null,
  )
  return (
    <>
      <WindowHostAway read={read} className="mb-4" />
      <AwayContent away={away}>{children}</AwayContent>
    </>
  )
}

/** A listing's frame: the column, and Back to the directory. */
export function ListingFrame({
  back,
  rise,
  children,
}: {
  back: () => void
  rise?: boolean
  children: ReactNode
}) {
  const { t } = useTranslation('marketplace')
  return (
    <div
      className={
        rise ? 'ui-as-integrations k-mkt-listing ui-as-rise' : 'ui-as-integrations k-mkt-listing'
      }
    >
      <button type="button" className="k-mkt-back" onClick={back}>
        <Icon icon={ArrowLeft01Icon} size={15} />
        {t('listing.back')}
      </button>
      <MarketAway>{children}</MarketAway>
    </div>
  )
}

/** A link shown by its address without the scheme; main opens it in the system browser. */
export function ExternalLink({ href }: { href: string }) {
  const shown = href.replace(/^https?:\/\//, '').replace(/\/$/, '')
  return (
    <a className="k-mkt-link" href={href} target="_blank" rel="noreferrer" title={href}>
      <span>{shown}</span>
      <Icon icon={LinkSquare02Icon} size={12} />
    </a>
  )
}

export function Missing({ back }: { back: () => void }) {
  const { t } = useTranslation('marketplace')
  return (
    <div className="ui-as-empty">
      <b className="ui-as-empty__title">{t('listing.missingTitle')}</b>
      <p className="ui-as-empty__text">{t('listing.missingText')}</p>
      <Button size="sm" variant="secondary" onClick={back}>
        {t('listing.backToDirectory')}
      </Button>
    </div>
  )
}

export function ListingSkeleton() {
  return (
    <div aria-hidden>
      <div className="k-mkt-head">
        <Skeleton className="k-mkt-skeleton__big" />
        <span className="k-mkt-head__title">
          <Skeleton className="k-mkt-skeleton__heading" />
          <Skeleton className="k-mkt-skeleton__line" />
        </span>
      </div>
      <div className="k-mkt-facts">
        <Skeleton className="k-mkt-skeleton__line" />
      </div>
    </div>
  )
}
