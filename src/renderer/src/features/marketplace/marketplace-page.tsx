// The Marketplace on affectUI's Integrations screen: plugins, skills and MCP servers in sections
// of two columns, a bar that stays at the top with the tabs, search and Add, and a listing for
// each. It works on the window's host: the chosen one, or this computer while every host shows.

import { useEffect, useLayoutEffect, useRef } from 'react'
import { css as integrationsCss } from '@renderer/components/affect/integrations'
import { css as generalCss } from '@renderer/components/affect/settings-general'
import { css as securityCss } from '@renderer/components/affect/settings-security'
import { AgentMarkHost } from '@renderer/components/agents/agent-mark-host'
import { HostScopeContext } from '@renderer/stores/host-scope'
import { returnedTo, type MarketplaceTab } from '@renderer/stores/view'
import { useWindowHostAway, useWindowScope } from '@renderer/stores/window-host'
import { Directory } from './directory'
import { ListingPage } from './listing'
import './marketplace.css'

/** How many places of the directory keep their scroll; the most recently scrolled win. */
const REMEMBERED = 50

// The directory's scroll per host, tab and search, for Back to return to.
const directoryScroll = new Map<string, number>()

function rememberScroll(key: string, top: number): void {
  directoryScroll.delete(key)
  directoryScroll.set(key, top)
  if (directoryScroll.size > REMEMBERED)
    directoryScroll.delete(directoryScroll.keys().next().value!)
}

export default function MarketplacePage({
  item,
  tab,
}: {
  item: string | null
  tab: MarketplaceTab
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const scope = useWindowScope()
  const away = useWindowHostAway() !== null
  const { useMarketplaceStore } = scope

  // Each host has its own store, so a host chosen again shows what was read of it at once. An
  // offline host keeps what was last read until it is back.
  useEffect(() => {
    if (away) return
    const store = useMarketplaceStore.getState()
    // The host keeps each catalog for a while; a read that failed is tried again on each visit.
    if (!store.catalogLoading && (!store.catalog || store.catalog.error)) void store.loadCatalog()
    if (!store.pluginsLoading && (!store.plugins || store.pluginsError)) void store.loadPlugins()
    if (!store.skillsLoading && (!store.skills || store.skills.error)) void store.loadSkills()
    void store.loadKeys()
    void store.loadConnections()
  }, [useMarketplaceStore, away])

  const directoryKey = (): string =>
    `${scope.hostId ?? ''}|${tab}|${useMarketplaceStore.getState().query}`

  // A listing and the directory share the page's scroll, which starts at the top for each. The
  // directory reached by Back or Forward returns to where it was, without its entrance.
  useLayoutEffect(() => {
    const view = scroller.current
    if (!view) return
    const back = !item && returnedTo({ kind: 'marketplace' })
    view.scrollTo({ top: back ? (directoryScroll.get(directoryKey()) ?? 0) : 0 })
    if (!back) return
    for (const animation of view.getAnimations({ subtree: true })) {
      if (animation instanceof CSSAnimation && animation.animationName === 'ui-as-rise') {
        animation.finish()
      }
    }
    // The tab and search are read on arrival; changing them later moves no scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item, scope])

  return (
    <HostScopeContext.Provider value={scope}>
      <AgentMarkHost.Provider value={scope.hostId}>
        <div
          ref={scroller}
          className="k-mkt-scroll"
          onScroll={(event) => {
            if (!item) rememberScroll(directoryKey(), event.currentTarget.scrollTop)
          }}
        >
          <style href="ui-screen-integrations" precedence="default">
            {integrationsCss}
          </style>
          <style href="ui-settings-general" precedence="default">
            {generalCss}
          </style>
          <style href="ui-settings-security" precedence="default">
            {securityCss}
          </style>
          <div aria-hidden className="k-mkt-drag app-region-drag" />
          {item ? (
            <ListingPage key={`${scope.hostId}|${item}`} item={item} tab={tab} />
          ) : (
            <Directory key={scope.hostId ?? 'local'} tab={tab} />
          )}
        </div>
      </AgentMarkHost.Provider>
    </HostScopeContext.Provider>
  )
}
