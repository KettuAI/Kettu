import {
  isValidElement,
  useContext,
  useEffect,
  useState,
  type ComponentType,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { AppWindowMacIcon, CopyIcon, ExternalLinkIcon, GlobeIcon, LinkIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { DefaultBrowser } from '@shared/ipc'
import type { LinkDestination } from '@shared/settings'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { SessionIdContext } from '@renderer/features/session/media/grants'
import { errorMessage } from '@renderer/lib/host'
import { formatShortcut, isMod, isWeb } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import { loadSiteIcons, useDefaultBrowser, useSiteIcon } from '@renderer/stores/site-icons'
import { openSession, toggleSidePane, useViewStore } from '@renderer/stores/view'
import {
  asksBeforeOpening,
  bareParts,
  defaultDestination,
  isBareLink,
  isLocalLink,
  linkSite,
  markdownLink,
  otherDestination,
  rememberSite,
  type LinkContext,
} from '../link-open'

/** What the "Open link?" dialog is given; `link-confirm.tsx` draws it. */
export interface LinkConfirmProps {
  url: string
  open: boolean
  /** The place the dialog starts on. */
  destination: LinkDestination
  /** The session whose reply holds the link; null outside one, where only the browser opens. */
  sessionId: string | null
  onClose: () => void
  onOpen: (destination: LinkDestination, remember: boolean) => void
}

/** Where a link drawn in this place may open. */
function useLinkContext(): { sessionId: string | null; context: LinkContext } {
  const sessionId = useContext(SessionIdContext)
  // Kettu's browser runs in the desktop app only.
  return { sessionId, context: { session: sessionId !== null && !isWeb } }
}

/**
 * Opens a link in the default browser, or in the session's page in Kettu's browser, which the
 * side panel then shows for the session's project.
 */
function openLinkIn(url: string, destination: LinkDestination, sessionId: string | null) {
  const summary = sessionId ? useSessionsStore.getState().byId[sessionId] : undefined
  if (destination === 'session' && sessionId && summary) {
    const { main } = useViewStore.getState()
    if (main.kind !== 'session' || main.sessionId !== sessionId) {
      openSession(sessionId, summary.projectPath)
    }
    toggleSidePane(summary.projectPath, 'browser', true)
    void window.kettu.browser.navigate(sessionId, url)
    return
  }
  // Main hands the address of a window the page opens to the default browser.
  window.open(url, '_blank', 'noreferrer')
}

/** Remembers where the link's site opens from now on, for the dialog's "Always open". */
function rememberDestination(url: string, destination: LinkDestination): void {
  const site = linkSite(url)
  if (!site) return
  const { settings, update } = useSettingsStore.getState()
  update({
    thread: { alwaysOpenIn: rememberSite(settings.thread.alwaysOpenIn, site, destination) },
  }).catch((e: unknown) =>
    console.warn(`Could not remember where ${site} opens: ${errorMessage(e)}`),
  )
}

/** The default browser's own icon, or a generic one where it is not known. */
export function BrowserIcon({
  browser,
  className,
}: {
  browser: DefaultBrowser
  className?: string
}) {
  if (!browser.icon) return <ExternalLinkIcon className={className} />
  return <img src={browser.icon} alt="" draggable={false} className={cn('shrink-0', className)} />
}

/**
 * A link's 14 px tile: the session browser's glyph on the fox's tint for a local address, the
 * icon recorded when Kettu's browser opened the site, or a globe for a site it never opened.
 */
function SiteTile({ url }: { url: string }) {
  const icon = useSiteIcon(url)
  const tile =
    'relative -top-[1.5px] mr-[5px] inline-flex size-3.5 shrink-0 items-center justify-center overflow-hidden rounded-[3px] align-middle leading-none'
  if (isLocalLink(url)) {
    return (
      <span
        aria-hidden
        className={cn(tile, 'bg-[color-mix(in_srgb,var(--focus)_14%,transparent)] text-(--focus)')}
      >
        <AppWindowMacIcon className="size-2.25" strokeWidth={1} />
      </span>
    )
  }
  if (icon) {
    return (
      <span aria-hidden className={tile}>
        <img src={icon} alt="" draggable={false} className="size-full object-contain" />
      </span>
    )
  }
  return (
    <span
      aria-hidden
      className={cn(
        tile,
        'bg-subtle text-tertiary shadow-[inset_0_0_0_var(--hairline)_var(--border-default)]',
      )}
    >
      <GlobeIcon className="size-2.5" strokeWidth={1} />
    </span>
  )
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children)
  return ''
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
// Holds formatted link text to the tile, where it cannot be split at its first character.
const WORD_JOINER = String.fromCodePoint(0x2060)

/** The first character as the reader sees it, and the rest. */
function splitFirst(text: string): [string, string] {
  const first = graphemes.segment(text)[Symbol.iterator]().next().value?.segment ?? ''
  return [first, text.slice(first.length)]
}

/**
 * The tile and the text, which keeps its first character on the tile's line, so a long link
 * wraps without leaving the tile and its piece of line behind. A bare address shows its host in
 * medium weight and the rest of it in the tertiary gray, without its scheme.
 */
function LinkText({ url, children }: { url: string; children: ReactNode }) {
  const tile = <SiteTile url={url} />
  const text = textOf(children)
  const bare = isBareLink(text, url) ? bareParts(url) : null
  if (bare) {
    const [first, host] = splitFirst(bare.host)
    return (
      <>
        <span className="whitespace-nowrap">
          {tile}
          <span className="font-medium">{first}</span>
        </span>
        <span className="font-medium">{host}</span>
        {bare.rest && <span className="text-tertiary">{bare.rest}</span>}
      </>
    )
  }
  const plain =
    typeof children === 'string' ||
    (Array.isArray(children) && children.every((child) => typeof child === 'string'))
  if (plain) {
    const [first, rest] = splitFirst(text)
    return (
      <>
        <span className="whitespace-nowrap">
          {tile}
          {first}
        </span>
        {rest}
      </>
    )
  }
  return (
    <>
      {tile}
      {WORD_JOINER}
      {children}
    </>
  )
}

/**
 * A web link in the thread: its site's icon and its text over one line. A click opens it where
 * Settings > Browser says, a Mod-click (Cmd on macOS, Ctrl elsewhere) in the other place, and
 * the "Open link?" dialog asks first where the settings want it to. Its menu offers both places
 * and copies it.
 */
export function WebLink({
  url,
  children,
  confirm: Confirm,
}: {
  url: string
  children?: ReactNode
  confirm: ComponentType<LinkConfirmProps>
}) {
  const { t } = useTranslation('session')
  const { sessionId, context } = useLinkContext()
  const thread = useSettingsStore((s) => s.settings.thread)
  const browser = useDefaultBrowser()
  const [menuOpen, setMenuOpen] = useState(false)
  // The dialog's run: a new key each time, so its choices start afresh.
  const [ask, setAsk] = useState<{ key: number; destination: LinkDestination; open: boolean }>()
  useEffect(loadSiteIcons, [])

  const label = children ?? url
  const primary = defaultDestination(url, thread, context)
  const browserName = browser.name ?? t('link.yourBrowser')

  const openTo = (destination: LinkDestination) => {
    const prefs = useSettingsStore.getState().settings.thread
    const target = context.session ? destination : 'browser'
    if (asksBeforeOpening(url, prefs, context)) {
      setAsk((last) => ({ key: (last?.key ?? 0) + 1, destination: target, open: true }))
    } else {
      openLinkIn(url, target, sessionId)
    }
  }
  const openFromClick = (other: boolean) => {
    const destination = defaultDestination(
      url,
      useSettingsStore.getState().settings.thread,
      context,
    )
    openTo(other ? otherDestination(destination) : destination)
  }
  const copy = (text: string) => void navigator.clipboard.writeText(text)

  // Mod+Enter in the menu takes the other place, as a Mod-click does.
  const onMenuKey = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || !isMod(event) || event.nativeEvent.isComposing) return
    event.preventDefault()
    event.stopPropagation()
    setMenuOpen(false)
    openFromClick(true)
  }

  const shortcut = (destination: LinkDestination) =>
    destination === primary ? formatShortcut('Enter') : formatShortcut('Mod+Enter')

  return (
    <>
      <ContextMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <Tooltip>
          <TooltipTrigger
            delay={500}
            render={
              <ContextMenuTrigger
                className="select-text"
                render={
                  <a
                    href={url}
                    rel="noreferrer"
                    draggable={false}
                    data-streamdown="link"
                    onClick={(event) => {
                      event.preventDefault()
                      openFromClick(isMod(event))
                    }}
                    onAuxClick={(event) => {
                      if (event.button !== 1) return
                      event.preventDefault()
                      openFromClick(false)
                    }}
                    className={cn(
                      'thread-link rounded-xs outline-none focus-ring',
                      isBareLink(textOf(label), url) && '[overflow-wrap:anywhere]',
                    )}
                  />
                }
              />
            }
          >
            <LinkText url={url}>{label}</LinkText>
          </TooltipTrigger>
          <TooltipContent align="start" sideOffset={6} className="max-w-md">
            {primary === 'session' ? (
              <AppWindowMacIcon className="size-2.75" strokeWidth={1} />
            ) : (
              <ExternalLinkIcon className="size-2.75" strokeWidth={1} />
            )}
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {primary === 'session'
                ? t('link.opensInSession', { url })
                : t('link.opensIn', { url, browser: browserName })}
            </span>
          </TooltipContent>
        </Tooltip>
        <ContextMenuContent className="min-w-60" onKeyDownCapture={onMenuKey}>
          <ContextMenuItem onClick={() => openTo('browser')}>
            <BrowserIcon browser={browser} className="size-3.75" />
            {t('link.openIn', { browser: browserName })}
            <ContextMenuShortcut>{shortcut('browser')}</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem disabled={!context.session} onClick={() => openTo('session')}>
            <AppWindowMacIcon />
            {t('link.openInSession')}
            {context.session && <ContextMenuShortcut>{shortcut('session')}</ContextMenuShortcut>}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => copy(url)}>
            <CopyIcon />
            {t('link.copy')}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => copy(markdownLink(textOf(label), url))}>
            <LinkIcon />
            {t('link.copyMarkdown')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {ask && (
        <Confirm
          key={ask.key}
          url={url}
          open={ask.open}
          destination={ask.destination}
          sessionId={context.session ? sessionId : null}
          onClose={() => setAsk((last) => last && { ...last, open: false })}
          onOpen={(destination, remember) => {
            if (remember) rememberDestination(url, destination)
            openLinkIn(url, destination, sessionId)
          }}
        />
      )}
    </>
  )
}
