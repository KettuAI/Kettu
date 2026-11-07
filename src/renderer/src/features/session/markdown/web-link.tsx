import {
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Copy01Icon, Globe02Icon, Link01Icon, LinkSquare02Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
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
import { formatShortcut, isMod, isWeb } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { useSettingsStore } from '@renderer/stores/settings'
import {
  iconFor,
  loadSiteIcons,
  requestSiteIcon,
  useDefaultBrowser,
  useSiteIcon,
  useSiteIconsStore,
} from '@renderer/stores/site-icons'
import {
  bareParts,
  defaultDestination,
  isBareLink,
  isLocalLink,
  markdownLink,
  planLinkOpen,
  planLinkOpenIn,
  type LinkContext,
  type LinkPlan,
} from '../link-open'
import { openLinkIn, rememberDestination } from '../open-link'

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

/** The default browser's own icon, or a generic one where it is not known. */
export function BrowserIcon({
  browser,
  className,
}: {
  browser: DefaultBrowser
  className?: string
}) {
  if (!browser.icon)
    return (
      <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={1.9} aria-hidden className={className} />
    )
  return <img src={browser.icon} alt="" draggable={false} className={cn('shrink-0', className)} />
}

/**
 * A link's 16 px tile: the session browser's glyph on the fox's tint for a local address, its
 * site's icon, or a bare globe where it has none.
 */
function SiteTile({ url }: { url: string }) {
  const icon = useSiteIcon(url)
  useEffect(() => requestSiteIcon(url), [url])
  const tile =
    'relative -top-[1.5px] mr-1.5 inline-flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-[3px] align-middle leading-none'
  if (isLocalLink(url)) {
    return (
      <span
        aria-hidden
        className={cn(
          tile,
          'bg-[color-mix(in_srgb,var(--thread-fox)_14%,transparent)] text-(--thread-fox)',
        )}
      >
        <HugeiconsIcon icon={Globe02Icon} strokeWidth={1.9} aria-hidden className="size-2.5" />
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
    <span aria-hidden className={cn(tile, 'text-tertiary')}>
      <HugeiconsIcon icon={Globe02Icon} strokeWidth={1.9} aria-hidden className="size-3.5" />
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

interface WebLinkProps {
  url: string
  children?: ReactNode
  confirm: ComponentType<LinkConfirmProps>
}

// Set within a link's text, where another link, such as a linked badge's image, is drawn as text.
const InsideLink = createContext(false)

/**
 * A web link in the thread: its site's icon and its text over one line. A click opens it where
 * Settings > Browser says, a Mod-click (Cmd on macOS, Ctrl elsewhere) in the other place, and
 * the "Open link?" dialog asks first where the settings want it to. Its menu offers both places
 * and copies it. Inside another link's text it is only its text, so a click opens one link.
 */
export function WebLink(props: WebLinkProps) {
  if (useContext(InsideLink)) return props.children ?? props.url
  return <OuterWebLink {...props} />
}

function OuterWebLink({ url, children, confirm: Confirm }: WebLinkProps) {
  const { t } = useTranslation('session')
  const { sessionId, context } = useLinkContext()
  const thread = useSettingsStore((s) => s.settings.thread)
  const browser = useDefaultBrowser()
  const [menuOpen, setMenuOpen] = useState(false)
  // The dialog's run: a new key each time, so its choices start afresh.
  const [ask, setAsk] = useState<{ key: number; destination: LinkDestination; open: boolean }>()
  const link = useRef<HTMLAnchorElement>(null)
  // A link that wraps has a box per line; the tooltip starts at the first, where the link does.
  const firstLine = useMemo(
    () => ({
      getBoundingClientRect: () =>
        link.current?.getClientRects()[0] ?? link.current?.getBoundingClientRect() ?? new DOMRect(),
      get contextElement() {
        return link.current ?? undefined
      },
    }),
    [],
  )
  useEffect(loadSiteIcons, [])

  const label = children ?? url
  const primary = defaultDestination(url, thread, context)
  const browserName = browser.name ?? t('link.yourBrowser')

  const run = (plan: LinkPlan) => {
    const { destination } = plan
    if (plan.ask) setAsk((last) => ({ key: (last?.key ?? 0) + 1, destination, open: true }))
    else openLinkIn(url, destination, sessionId)
  }
  const prefs = () => useSettingsStore.getState().settings.thread
  // Known once opened from Kettu in either place, as the dialog's "First visit" reads it.
  const known = () => iconFor(useSiteIconsStore.getState().sites, url) !== undefined
  const openTo = (destination: LinkDestination) =>
    run(planLinkOpenIn(url, prefs(), context, known(), destination))
  const openFromClick = (other: boolean) => run(planLinkOpen(url, prefs(), context, known(), other))
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
                    ref={link}
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
            <InsideLink value>
              <LinkText url={url}>{label}</LinkText>
            </InsideLink>
          </TooltipTrigger>
          <TooltipContent anchor={firstLine} align="start" sideOffset={6} className="max-w-md">
            {primary === 'session' ? (
              <HugeiconsIcon
                icon={Globe02Icon}
                strokeWidth={1.9}
                aria-hidden
                className="size-2.75"
              />
            ) : (
              <HugeiconsIcon
                icon={LinkSquare02Icon}
                strokeWidth={1.9}
                aria-hidden
                className="size-2.75"
              />
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
            <HugeiconsIcon icon={Globe02Icon} strokeWidth={1.9} aria-hidden />
            {t('link.openInSession')}
            {context.session && <ContextMenuShortcut>{shortcut('session')}</ContextMenuShortcut>}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => copy(url)}>
            <HugeiconsIcon icon={Copy01Icon} strokeWidth={1.9} aria-hidden />
            {t('link.copy')}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => copy(markdownLink(textOf(label), url))}>
            <HugeiconsIcon icon={Link01Icon} strokeWidth={1.9} aria-hidden />
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
