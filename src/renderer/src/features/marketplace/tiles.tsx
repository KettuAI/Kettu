// The Marketplace's tiles: an item's, and a plain one for what is no item.

import { useEffect, type CSSProperties, type ReactNode } from 'react'
import { Icon } from '@renderer/components/affect/app-shell'
import { SiteIconImage } from '@renderer/components/site-icon-image'
import { loadSiteIcons, requestSiteIcon, useSiteIcon } from '@renderer/stores/site-icons'
import { tileArt, type TileSize, type TileSubject } from './tile-art'

/**
 * The icon of the site a remote server connects to, as links in replies show a site's: main loads
 * and keeps it, the page never does. Null without one, or while it is on its way.
 */
function useServerIcon(site: string | null): string | null {
  const icon = useSiteIcon(site ?? '')
  const missing = site !== null && !icon
  useEffect(() => {
    if (!site || !missing) return
    loadSiteIcons()
    requestSiteIcon(site)
  }, [site, missing])
  return site ? (icon ?? null) : null
}

/** A plain tile with a muted glyph or an agent's mark, for what has no item of its own. */
export function PlainTile({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden className="ui-as-int-logo k-mkt-tile" data-quiet="">
      {children}
    </span>
  )
}

/**
 * An item's tile: 40 px in a row, 64 px at the top of its page, 20 px in a section's
 * "and N more". `quiet` is for what an agent keeps itself, which Kettu
 * only shows: its glyph on a plain tile.
 */
export function ItemTile({
  subject,
  size = 'row',
  quiet = false,
}: {
  subject: TileSubject
  size?: TileSize
  quiet?: boolean
}) {
  const art = tileArt(subject)
  const site =
    !quiet && art.type === 'glyph' && subject.kind === 'mcp' ? (subject.site ?? null) : null
  const logo = useServerIcon(site)
  const sized = size === 'row' ? undefined : size
  if (subject.kind === 'kettu-plugin' && subject.icon) {
    return (
      <span aria-hidden className="ui-as-int-logo k-mkt-tile" data-size={sized}>
        <SiteIconImage className="k-mkt-tile__logo" src={subject.icon} />
      </span>
    )
  }
  if (art.type === 'mark') {
    const { mark } = art
    const style = {
      ...(mark.tile ? { background: mark.tile } : {}),
      '--mark-scale': mark.scale ?? 1,
    } as CSSProperties
    return (
      <span
        aria-hidden
        className="ui-as-int-logo k-mkt-tile"
        data-size={sized}
        data-filled={mark.tile ? '' : undefined}
        style={style}
      >
        <svg viewBox={mark.viewBox ?? '0 0 24 24'} fill={mark.ink} className="k-mkt-tile__mark">
          {mark.paths.map((path) => (
            <path key={path.d} d={path.d} fill={path.fill} />
          ))}
        </svg>
      </span>
    )
  }
  if (logo !== null) {
    return (
      <span aria-hidden className="ui-as-int-logo k-mkt-tile" data-size={sized}>
        {logo && <SiteIconImage className="k-mkt-tile__logo" src={logo} />}
      </span>
    )
  }
  if (quiet) {
    return (
      <span aria-hidden className="ui-as-int-logo k-mkt-tile" data-size={sized} data-quiet="">
        <Icon icon={art.icon} />
      </span>
    )
  }
  return (
    <span
      aria-hidden
      className="ui-as-int-logo k-mkt-tile"
      data-size={sized}
      data-filled=""
      style={{ background: art.color, color: 'var(--tile-ink)' }}
    >
      <Icon icon={art.icon} />
    </span>
  )
}
