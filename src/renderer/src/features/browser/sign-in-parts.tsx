import { useEffect } from 'react'
import { BrowserIcon, SquareLock02Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { SignInBrowserId, SignInSource } from '@shared/signins'
import { cn } from '@renderer/lib/utils'
import { loadSiteIcons, useSiteIcon } from '@renderer/stores/site-icons'
import { useSignInsStore } from '@renderer/stores/sign-ins'
import './sign-ins.css'

// The letter tiles' grounds, picked by the site's name so a site keeps its color.
const TILE_COLORS = [
  'var(--tile-teal)',
  'var(--tile-violet)',
  'var(--tile-emerald)',
  'var(--tile-slate)',
  'var(--tile-cyan)',
  'var(--tile-sky)',
  'var(--tile-amber)',
  'var(--tile-pink)',
  'var(--tile-word)',
  'var(--tile-pdf)',
]

function tileColor(site: string): string {
  let hash = 0
  for (const char of site) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return TILE_COLORS[hash % TILE_COLORS.length]!
}

/**
 * A site's tile: the icon Kettu's browser recorded for it, else its first letter. No icon is
 * fetched for it, so the list of the user's sites goes nowhere.
 */
export function SiteTile({ site, large }: { site: string; large?: boolean }) {
  useEffect(loadSiteIcons, [])
  const icon = useSiteIcon(`https://${site}/`)
  return (
    <span
      aria-hidden
      className={cn('ksi-tile', large && 'ksi-tile--lg')}
      data-icon={icon ? '' : undefined}
      style={icon ? undefined : { background: tileColor(site) }}
    >
      {icon ? <img src={icon} alt="" /> : site[0]?.toUpperCase()}
    </span>
  )
}

/** A browser's own icon from the system, else a generic browser glyph. */
export function BrowserMark({
  browser,
  size = 16,
}: {
  browser: SignInBrowserId | SignInSource | null
  size?: number
}) {
  const sources = useSignInsStore((s) => s.sources)
  const source =
    typeof browser === 'string' ? sources?.find((known) => known.browser === browser) : browser
  if (source?.icon) {
    return <img src={source.icon} alt="" aria-hidden width={size} height={size} />
  }
  return <HugeiconsIcon icon={BrowserIcon} size={size} strokeWidth={1.9} aria-hidden />
}

// The program that asks the keychain for the key; macOS names it in its prompt.
const KEYCHAIN_CLIENT = 'security'

/**
 * macOS's keychain prompt, drawn small and tilted so the user knows it when it comes and does not
 * take it for Kettu's own. Allow is the button to press.
 */
export function KeychainPrompt({ item }: { item: string }) {
  const { t } = useTranslation('browser')
  return (
    <figure className="ksi-kc" aria-label={t('signIns.prompt.label')}>
      <span className="ksi-kc__icon" aria-hidden>
        <HugeiconsIcon icon={SquareLock02Icon} size={22} strokeWidth={1.9} />
      </span>
      <p>{t('signIns.prompt.ask', { app: KEYCHAIN_CLIENT, item })}</p>
      <p>{t('signIns.prompt.password')}</p>
      <span className="ksi-kc__field" aria-hidden>
        <small>{t('signIns.prompt.field')}</small>
        <span>••••••••••</span>
      </span>
      <span className="ksi-kc__btns" aria-hidden>
        <span className="ksi-kc__btn">{t('signIns.prompt.alwaysAllow')}</span>
        <span className="ksi-kc__gap" />
        <span className="ksi-kc__btn">{t('signIns.prompt.deny')}</span>
        <span className="ksi-kc__btn" data-pick="">
          {t('signIns.prompt.allow')}
        </span>
      </span>
    </figure>
  )
}
