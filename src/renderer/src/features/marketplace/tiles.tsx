// The Marketplace's tiles: an item's, and a plain one for what is no item.

import { useEffect, type CSSProperties, type ReactNode } from 'react'
import { Icon } from '@renderer/components/affect/app-shell'
import { useDark } from '@renderer/hooks/use-dark'
import { useHostScope } from '@renderer/stores/host-scope'
import { tileArt, type TileSize, type TileSubject } from './tile-art'

/** A Codex plugin's logo for the theme shown: undefined while it is read, null without one. */
function usePluginLogo(pluginId: string | null): string | null | undefined {
  const dark = useDark()
  const { useMarketplaceStore } = useHostScope()
  const logo = useMarketplaceStore((s) => (pluginId ? s.logos[pluginId] : undefined))
  useEffect(() => {
    if (pluginId) void useMarketplaceStore.getState().loadLogo(pluginId)
  }, [pluginId, useMarketplaceStore])
  if (!pluginId) return null
  if (logo === undefined || logo === 'loading') return undefined
  return (dark && logo.dark) || logo.light
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
 * An item's tile, as affectUI's Integrations draws one: 30 px in a row, 64 px at the top of its
 * page, 20 px in a section's "and N more". `quiet` is for what an agent keeps itself, which Kettu
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
  const hasLogo = !quiet && art.type === 'glyph' && subject.kind === 'plugin'
  const logo = usePluginLogo(hasLogo && subject.harness === 'codex' ? subject.id : null)
  const sized = size === 'row' ? undefined : size
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
        {logo && <img className="k-mkt-tile__logo" src={logo} alt="" draggable={false} />}
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
