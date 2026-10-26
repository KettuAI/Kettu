import { useRef, useState, type ReactNode, type RefObject } from 'react'
import {
  ArchiveIcon,
  CircleHelpIcon,
  ExternalLinkIcon,
  KeyboardIcon,
  SettingsIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { RELEASES_URL, releaseUrl } from '@shared/updates'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { AgentUpdateRow } from '@renderer/features/updates/agent-update-notice'
import { NoticeRow, UpdateNoticeRow } from '@renderer/features/updates/update-notice'
import { formatShortcut } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { useUpdatesStore } from '@renderer/stores/updates'
import { openSettings } from '@renderer/stores/view'
import { CloseNoticesContext, signInLabel, useNotices } from './notices'

const README_URL = 'https://github.com/overbench/overbench#readme'
const REPORT_URL = 'https://github.com/overbench/overbench/issues/new?template=bug.yml'

/** The footer's row of icon buttons, with the notices pill at its end. */
export function SidebarFooterContent() {
  const { t } = useTranslation('sidebar')
  const help = useRef<HTMLButtonElement>(null)
  return (
    <div className="flex items-center gap-0.5">
      <FooterButton label={t('footer.settings')} shortcut="Mod+," onClick={() => openSettings()}>
        <SettingsIcon />
      </FooterButton>
      <FooterButton label={t('footer.archived')} onClick={() => openSettings('archived')}>
        <ArchiveIcon />
      </FooterButton>
      <FooterButton label={t('footer.shortcuts')} onClick={() => openSettings('shortcuts')}>
        <KeyboardIcon />
      </FooterButton>
      <HelpMenu buttonRef={help} />
      <div className="@container/notices flex min-w-0 flex-1 justify-end">
        <NoticesPill afterLast={help} />
      </div>
    </div>
  )
}

function FooterButton({
  label,
  shortcut,
  onClick,
  children,
}: {
  label: string
  shortcut?: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-compact"
            aria-label={label}
            onClick={onClick}
            className="text-icon"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        <span>
          {label}
          {shortcut && <span className="opacity-60"> {formatShortcut(shortcut)}</span>}
        </span>
      </TooltipContent>
    </Tooltip>
  )
}

function HelpMenu({ buttonRef }: { buttonRef: RefObject<HTMLButtonElement | null> }) {
  const { t } = useTranslation('sidebar')
  const version = useUpdatesStore((s) => s.status?.current)
  const links = [
    { label: t('footer.documentation'), href: README_URL },
    { label: t('footer.reportProblem'), href: REPORT_URL },
    { label: t('footer.whatsNew'), href: version ? releaseUrl(version) : RELEASES_URL },
  ]
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  ref={buttonRef}
                  variant="ghost"
                  size="icon-compact"
                  aria-label={t('footer.help')}
                  className="text-icon"
                />
              }
            />
          }
        >
          <CircleHelpIcon />
        </TooltipTrigger>
        <TooltipContent>{t('footer.help')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="top" align="start">
        {links.map((link) => (
          <DropdownMenuItem
            key={link.href}
            render={<a href={link.href} target="_blank" rel="noreferrer" />}
          >
            <ExternalLinkIcon />
            {link.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Every notice behind one pill, which opens them in a popover. When the row cannot hold its words
 * the pill shows the dot and the count alone, and its tooltip names the count.
 */
function NoticesPill({ afterLast }: { afterLast: RefObject<HTMLButtonElement | null> }) {
  const { t } = useTranslation('sidebar')
  const notices = useNotices()
  const { summary } = notices
  const [open, setOpen] = useState(false)
  const [tip, setTip] = useState(false)
  const words = useRef<HTMLSpanElement>(null)
  const shown = open && summary !== null
  return (
    <Popover open={shown} onOpenChange={setOpen}>
      {summary && (
        <Tooltip
          open={tip && !shown}
          onOpenChange={(next) =>
            setTip(next && words.current !== null && words.current.getClientRects().length === 0)
          }
        >
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <button
                    type="button"
                    aria-label={summary.name}
                    className="flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-card px-2 text-xs font-medium whitespace-nowrap shadow-card outline-none transition-colors duration-(--duration-fast) hover:bg-hover focus-ring aria-expanded:bg-accent"
                  />
                }
              />
            }
          >
            <span
              aria-hidden
              className={cn(
                'size-1.5 shrink-0 rounded-full bg-current',
                summary.tone === 'warning' ? 'text-warning' : 'text-info',
              )}
            />
            <span className="flex items-baseline gap-1">
              <span className="tabular">{summary.count}</span>
              <span ref={words} className="@max-[5.25rem]/notices:hidden">
                {t('footer.noticeWords', { count: summary.count })}
              </span>
            </span>
          </TooltipTrigger>
          <TooltipContent>{t('footer.noticesCount', { count: summary.count })}</TooltipContent>
        </Tooltip>
      )}
      {/* Once the last notice goes the pill goes too, so focus moves to the button before it. */}
      <PopoverContent
        side="top"
        align="end"
        collisionAvoidance={{ align: 'shift' }}
        aria-label={t('footer.notices')}
        finalFocus={summary ? true : afterLast}
        className="w-80 gap-0 p-1.5"
      >
        <CloseNoticesContext value={() => setOpen(false)}>
          {notices.signIn.length > 0 && <SignInRow names={notices.signIn} />}
          {notices.agentUpdate && <AgentUpdateRow notice={notices.agentUpdate} />}
          {notices.appUpdate && <UpdateNoticeRow notice={notices.appUpdate} />}
        </CloseNoticesContext>
      </PopoverContent>
    </Popover>
  )
}

/** An agent needs sign-in: something to do, so it takes the warning color, and it cannot be dismissed. */
function SignInRow({ names }: { names: string[] }) {
  const { t } = useTranslation('sidebar')
  const label = signInLabel(names)
  return (
    <NoticeRow
      icon={<span aria-hidden className="size-1.5 rounded-full bg-current text-warning" />}
      text={label}
      label={label}
      detail={t('footer.signInDetail')}
      onOpen={() => openSettings('agents')}
    />
  )
}
