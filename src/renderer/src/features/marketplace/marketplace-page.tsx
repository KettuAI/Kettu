// The Marketplace on affectUI's Integrations screen: plugins, skills and MCP servers in sections
// of two columns, a bar that stays at the top with the tabs, search and Add, and a listing for
// each.

import { useEffect, useLayoutEffect, useRef } from 'react'
import { css as integrationsCss } from '@renderer/components/affect/integrations'
import { css as generalCss } from '@renderer/components/affect/settings-general'
import { css as securityCss } from '@renderer/components/affect/settings-security'
import { useMarketplaceStore } from '@renderer/stores/marketplace'
import type { MarketplaceTab } from '@renderer/stores/view'
import { Directory } from './directory'
import { ListingPage } from './listing'
import './marketplace.css'

export default function MarketplacePage({
  item,
  tab,
}: {
  item: string | null
  tab: MarketplaceTab
}) {
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const store = useMarketplaceStore.getState()
    // The host keeps each catalog for a while; a read that failed is tried again on each visit.
    if (!store.catalogLoading && (!store.catalog || store.catalog.error)) void store.loadCatalog()
    if (!store.pluginsLoading && (!store.plugins || store.pluginsError)) void store.loadPlugins()
    if (!store.skillsLoading && (!store.skills || store.skills.error)) void store.loadSkills()
    void store.loadKeys()
    void store.loadConnections()
  }, [])

  // A listing and the directory share the page's scroll, which starts at the top for each.
  useLayoutEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
  }, [item])

  return (
    <div ref={scroller} className="k-mkt-scroll">
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
      {item ? <ListingPage key={item} item={item} tab={tab} /> : <Directory tab={tab} />}
    </div>
  )
}
