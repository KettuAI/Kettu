import { useRef, useState, type ReactNode } from 'react'
import { AppWindowMacIcon, GlobeIcon } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import type { LinkDestination } from '@shared/settings'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { Badge } from '@renderer/components/ui/badge'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { RadioGroup, RadioGroupTile } from '@renderer/components/ui/radio-group'
import { addressParts, readableRest } from '@renderer/features/browser/address'
import { CopyButton } from '@renderer/features/git/copy-button'
import { agentName } from '@renderer/stores/agents'
import { hostOfSession, sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { useDefaultBrowser, useSiteIcon } from '@renderer/stores/site-icons'
import { hasUserinfo, linkHost, linkSite } from './link-open'
import { BrowserIcon, WebLink, type LinkConfirmProps } from './markdown/web-link'

/** The site's icon on a 32 px tile, or a globe for a site Kettu's browser never opened. */
function SiteIcon({ url }: { url: string }) {
  const icon = useSiteIcon(url)
  if (icon) {
    return (
      <span className="size-8 shrink-0 overflow-hidden rounded-xl shadow-[0_0_0_var(--hairline)_var(--border-subtle)]">
        <img src={icon} alt="" draggable={false} className="size-full object-contain" />
      </span>
    )
  }
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-card text-secondary shadow-outline">
      <GlobeIcon className="size-4" />
    </span>
  )
}

function Destination({
  value,
  icon,
  name,
  hint,
  disabled,
}: {
  value: LinkDestination
  icon: ReactNode
  name: string
  hint: string
  disabled?: boolean
}) {
  return (
    <RadioGroupTile value={value} disabled={disabled}>
      <span className="flex items-center gap-1.5 font-medium text-primary [&_img]:size-3.75 [&_svg]:size-3.75 [&_svg]:text-secondary">
        {icon}
        {name}
      </span>
      <span className="mt-0.5 block text-small leading-[1.4] text-tertiary">{hint}</span>
    </RadioGroupTile>
  )
}

/**
 * "Open link?": the address with the site's owner, its registrable domain, set apart, where it
 * opens, and whether to remember that for the site. The host is the URL parser's, so text before
 * "@" or a look-alike host cannot pass for another site; an address with a user name or a password
 * says so and starts on Cancel.
 */
export function LinkConfirm({
  url,
  open,
  destination,
  sessionId,
  onClose,
  onOpen,
}: LinkConfirmProps) {
  const { t } = useTranslation(['session', 'common'])
  const cancel = useRef<HTMLButtonElement>(null)
  const confirm = useRef<HTMLButtonElement>(null)
  const [choice, setChoice] = useState<LinkDestination>(destination)
  const [remember, setRemember] = useState(false)
  const browser = useDefaultBrowser()
  const firstVisit = useSiteIcon(url) === undefined
  const summary = useSessionsStore((s) => (sessionId ? s.byId[sessionId] : undefined))
  const host = linkHost(url)
  const parts = addressParts(url)
  if (!host || !parts) return null
  const userinfo = hasUserinfo(url)
  const site = userinfo ? null : linkSite(url)
  const session = sessionId !== null
  const agent = summary ? agentName(summary.agentId, hostOfSession(summary)) : null
  const browserName = browser.name ?? t('link.yourBrowser')
  const inSession = choice === 'session'
  const always =
    site === null
      ? null
      : host.prefix === ''
        ? inSession
          ? t('link.alwaysHostSession')
          : t('link.alwaysHost', { browser: browserName })
        : inSession
          ? t('link.alwaysSiteSession', { site })
          : t('link.alwaysSite', { site, browser: browserName })
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onClose()}>
      <AlertDialogContent
        initialFocus={userinfo ? cancel : confirm}
        className="gap-0 p-0 data-[size=default]:sm:max-w-105"
      >
        <AlertDialogTitle className="px-5.5 pt-5">{t('link.title')}</AlertDialogTitle>
        <div className="px-5.5 pt-3.5">
          <div className="flex items-start gap-3 rounded-xl bg-subtle py-3 pr-2.5 pl-3">
            <SiteIcon url={url} />
            <div dir="ltr" className="min-w-0 flex-1" data-selectable="">
              <div className="text-row leading-[1.4] font-semibold text-primary">
                {host.prefix && (
                  <span className="font-normal break-all text-secondary">{host.prefix}</span>
                )}
                <span className="whitespace-nowrap">{host.domain}</span>
                {host.port && <span className="font-normal text-secondary">{host.port}</span>}
                {firstVisit && (
                  <Badge
                    variant="warning"
                    className="relative -top-px ml-2 h-4.5 px-1.5 font-semibold"
                  >
                    {t('link.firstVisit')}
                  </Badge>
                )}
              </div>
              <div className="mt-0.5 truncate font-mono text-code leading-4 text-tertiary">
                {readableRest(parts.rest)}
              </div>
            </div>
            <CopyButton text={url} label={t('link.copy')} size="icon-sm" />
          </div>
          {(userinfo || firstVisit) && (
            <AlertDialogDescription
              className={
                userinfo
                  ? 'mt-2.5 text-hint text-danger'
                  : 'mt-2.5 text-hint leading-normal text-tertiary'
              }
            >
              {userinfo ? t('link.userinfo') : t('link.firstVisitNote')}
            </AlertDialogDescription>
          )}
          <RadioGroup
            value={choice}
            onValueChange={(value) => setChoice(value as LinkDestination)}
            aria-label={t('link.title')}
            className="mt-3 grid-cols-2 gap-2"
          >
            <Destination
              value="browser"
              icon={<BrowserIcon browser={browser} />}
              name={browser.name ?? t('link.defaultBrowser')}
              hint={t('link.browserHint')}
            />
            <Destination
              value="session"
              icon={<AppWindowMacIcon />}
              name={t('link.sessionBrowser')}
              hint={agent ? t('link.sessionHint', { agent }) : t('link.sessionHintGeneric')}
              disabled={!session}
            />
          </RadioGroup>
          {summary && agent && (
            <div className="mt-3 flex items-center gap-1.75 text-hint text-tertiary">
              <AgentMark agent={summary.agentId} />
              <span className="min-w-0 truncate">
                <Trans
                  t={t}
                  i18nKey="link.writtenBy"
                  values={{ agent, title: sessionTitle(summary) }}
                  components={{ title: <span className="text-secondary" /> }}
                />
              </span>
            </div>
          )}
          {always && (
            <label className="mt-3.5 flex items-center gap-2.25 text-control text-primary">
              <Checkbox checked={remember} onCheckedChange={setRemember} />
              {always}
            </label>
          )}
        </div>
        <AlertDialogFooter className="px-5.5 pt-4.5 pb-4.5">
          <AlertDialogCancel ref={cancel}>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            ref={confirm}
            onClick={() => {
              onOpen(choice, remember && always !== null)
              onClose()
            }}
          >
            {inSession ? t('link.openInSession') : t('link.openIn', { browser: browserName })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * A web link that opens as a reply's does, through the "Open link?" dialog when it asks: a link
 * in a reply, a remote image's, or a web address in a notice's text.
 */
export function ConfirmedLink({ url, children }: { url: string; children?: ReactNode }) {
  return (
    <WebLink url={url} confirm={LinkConfirm}>
      {children}
    </WebLink>
  )
}
