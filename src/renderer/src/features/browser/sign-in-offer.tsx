import { useEffect } from 'react'
import { ArrowRight01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { useDefaultBrowser } from '@renderer/stores/site-icons'
import {
  bringOfferedSignIn,
  loadBrought,
  loadSources,
  openBringSignIns,
  preferredSource,
  useSignInOffer,
  useSignInsStore,
} from '@renderer/stores/sign-ins'
import { BrowserMark } from './sign-in-parts'
import { shortBrowserName } from './sign-in-text'

/**
 * In the address field: the sign-in one of the user's browsers has for the page's site, when
 * Kettu's browser has none there. Hidden while an agent drives the page.
 */
export function SignInChip({
  url,
  sessionId,
  hidden,
}: {
  url: string | null
  sessionId: string | null
  hidden?: boolean
}) {
  const { t } = useTranslation('browser')
  const offer = useSignInOffer(hidden ? null : url)
  // The browser's icon comes with the list of browsers, read once a run.
  useEffect(() => {
    if (offer) void loadSources().catch(() => {})
  }, [offer])
  if (!offer || hidden) return null
  const browser = shortBrowserName(offer.browserName)
  return (
    <button
      type="button"
      className="ksi-addr-chip"
      title={t('signIns.chipTitle', { site: offer.site, browser, profile: offer.profileName })}
      onClick={() => bringOfferedSignIn(offer, sessionId)}
    >
      <BrowserMark browser={offer.browser} size={13} />
      <span>{t('signIns.chip', { browser })}</span>
    </button>
  )
}

/**
 * On the empty browser: bring sign-ins from the browser used most on this computer. Shown until
 * some site has been brought, and only when one of the browsers here can bring them.
 */
export function BringSignInsOffer() {
  const { t } = useTranslation('browser')
  const sources = useSignInsStore((s) => s.sources)
  const brought = useSignInsStore((s) => s.brought)
  const defaultBrowser = useDefaultBrowser().name
  useEffect(() => {
    loadBrought()
    void loadSources().catch(() => {})
  }, [])
  const source = sources && preferredSource(sources, defaultBrowser)
  if (!source || brought === null || brought.length > 0) return null
  const browser = shortBrowserName(source.name)
  return (
    <button type="button" className="ksi-offer" onClick={openBringSignIns}>
      <BrowserMark browser={source} size={16} />
      <span>
        <b>{t('signIns.offer', { browser })}</b>
        <small>{t('signIns.offerNote', { browser })}</small>
      </span>
      <HugeiconsIcon icon={ArrowRight01Icon} size={13} strokeWidth={1.9} aria-hidden />
    </button>
  )
}
