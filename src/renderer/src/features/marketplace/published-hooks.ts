// Marketplace › Published's hooks and menus: the host's Published store, whether it shows the
// tab, picking a folder, and a listing's New version and ⋯ items.

import { useEffect, useState } from 'react'
import {
  Delete02Icon,
  Folder01Icon,
  Message01Icon,
  PencilEdit02Icon,
  PlugSocketIcon,
  ViewIcon,
  ViewOffSlashIcon,
} from '@hugeicons/core-free-icons'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { MarketPublished, MineListing } from '@shared/market-publish'
import type { MenuItem } from '@renderer/components/affect/app-shell'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage } from '@renderer/lib/host'
import { isWeb } from '@renderer/lib/platform'
import { useHostScope } from '@renderer/stores/host-scope'
import { publishedStore, type PublishedStoreHook } from '@renderer/stores/market-published'
import { openMarketplace } from '@renderer/stores/view'
import type { ListingDialog } from './publish-dialogs'
import { previewItem } from './published-keys'
import { askAgent, folderShown, isClosed, listingName } from './published-model'

/** The Published store of the page's host. */
export function usePublishedStore(): PublishedStoreHook {
  const { hostId, request } = useHostScope()
  return publishedStore(hostId, request)
}

/**
 * Whether the host's Kettu account shows the Published tab: signed in with Kettu's services on.
 * Asked once the page shows; the host says when it changes.
 */
export function useShowsPublished(): boolean {
  const store = usePublishedStore()
  const account = store((s) => s.account)
  useEffect(() => {
    if (store.getState().account === undefined) void store.getState().loadAccount()
  }, [store])
  return !!account
}

/** The folder to check in the folder dialog, and the draft it publishes, if any. */
export interface FolderChoice {
  path: string
  draftId: string | null
}

/** Picks a folder of the page's host for the folder dialog; null when the user picked none. */
export function usePickFolder(): () => Promise<string | null> {
  const scope = useHostScope()
  return () => scope.api.dialogs.openProject()
}

/**
 * Turns a closed listing's files into a Kettu plugin written to a folder of its own, which is handed
 * on to be checked and published; `converting` while the files are fetched and converted.
 */
export function useConvertListing(onConverted: (choice: FolderChoice) => void): {
  convert: (listing: MineListing) => void
  converting: boolean
} {
  const scope = useHostScope()
  const [converting, setConverting] = useState(false)
  const convert = (listing: MineListing) => {
    setConverting(true)
    scope
      .request('market.convertListing', { id: listing.id })
      .then(
        (converted) => onConverted({ path: converted.path, draftId: null }),
        (error: unknown) => toast(errorMessage(error), undefined, { tone: 'warning' }),
      )
      .finally(() => setConverting(false))
  }
  return { convert, converting }
}

/** A closed listing's one way on: converting it, as its menu offers. */
export function convertItem(
  t: TFunction<'marketplace'>,
  convert: () => void,
  converting: boolean,
): MenuItem {
  return {
    label: t('published.menu.convert'),
    description: t('published.menu.convertLine'),
    icon: PlugSocketIcon,
    disabled: converting,
    onSelect: convert,
  }
}

/** A listing's New version items: an agent in a new session, its last folder, or another one. */
export function useNewVersionItems(
  listing: MineListing,
  published: MarketPublished,
  onFolder: (choice: FolderChoice) => void,
): MenuItem[] {
  const { t } = useTranslation('marketplace')
  const { hostId } = useHostScope()
  const pick = usePickFolder()
  const origin = published.origins[listing.id]
  const shown = origin ? folderShown(hostId, origin.path) : null
  const name = listingName(listing)
  return [
    {
      label: t('published.ask'),
      description: t('published.askLine'),
      icon: Message01Icon,
      onSelect: () =>
        askAgent(
          shown
            ? t('published.askVersionPrompt', { name, folder: shown.path })
            : t('published.askVersionPromptAnywhere', { name }),
          shown?.projectPath ?? null,
        ),
    },
    ...(isWeb
      ? []
      : origin && shown
        ? [
            {
              label: t('published.fromOrigin', { folder: shown.path }),
              description: t('published.fromOriginLine'),
              icon: Folder01Icon,
              onSelect: () => onFolder({ path: origin.path, draftId: null }),
            },
          ]
        : [
            {
              label: t('published.folder'),
              description: t('published.folderLine'),
              icon: Folder01Icon,
              onSelect: () => void pick().then((path) => path && onFolder({ path, draftId: null })),
            },
          ]),
  ]
}

/** What a listing's ⋯ offers: details, unlisting or listing again, and deleting. */
export function listingMenu(
  listing: MineListing,
  t: TFunction<'marketplace'>,
  open: (dialog: ListingDialog) => void,
  relist: () => void,
): MenuItem[] {
  const unlisted = listing.visibility === 'unlisted'
  return [
    {
      label: t('published.menu.editDetails'),
      description: t('published.menu.editDetailsLine'),
      icon: PencilEdit02Icon,
      onSelect: () => open({ kind: 'details', listing }),
    },
    // Others can open neither an Only me listing, nor one with no version yet, nor a closed one.
    listing.visibility === 'private' || listing.current === null || isClosed(listing)
      ? {
          label: t('published.menu.viewAsOthers'),
          description: t(
            isClosed(listing)
              ? 'published.menu.viewAsOthersClosed'
              : 'published.menu.viewAsOthersPrivate',
          ),
          icon: ViewIcon,
          disabled: true,
          onSelect: () => {},
        }
      : {
          label: t('published.menu.viewAsOthers'),
          description: t('published.menu.viewAsOthersLine'),
          icon: ViewIcon,
          onSelect: () => openMarketplace({ item: previewItem(listing.id), tab: 'published' }),
        },
    ...(unlisted
      ? [
          {
            label: t('published.menu.listAgain'),
            icon: ViewIcon,
            divider: true,
            onSelect: relist,
          },
        ]
      : listing.visibility === 'public'
        ? [
            {
              label: t('published.menu.unlist'),
              description: t('published.menu.unlistLine'),
              icon: ViewOffSlashIcon,
              divider: true,
              onSelect: () => open({ kind: 'unlist', listing }),
            },
          ]
        : []),
    {
      label: t('published.menu.delete'),
      icon: Delete02Icon,
      danger: true,
      divider: listing.visibility === 'private',
      onSelect: () => open({ kind: 'delete', listing }),
    },
  ]
}

/** List again: back into the directory, as before it was unlisted. */
export function useRelist(): (listing: MineListing) => void {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const store = usePublishedStore()
  return (listing) => {
    void scope
      .request('market.updateListing', { id: listing.id, change: { visibility: 'public' } })
      .then(
        () => {
          toast(t('published.toast.listed', { name: listing.name }), undefined, {
            tone: 'success',
          })
          return store.getState().load()
        },
        (error: unknown) => toast(errorMessage(error), undefined, { tone: 'warning' }),
      )
  }
}
