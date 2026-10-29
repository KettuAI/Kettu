import type { ReactNode } from 'react'
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
import { Kbd } from '@renderer/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { AgentUpdateCard } from '@renderer/features/updates/agent-update-notice'
import { NoticeCard, UpdateNoticeCard } from '@renderer/features/updates/update-notice'
import { bugReportUrl } from '@renderer/lib/bug-report'
import { formatShortcut } from '@renderer/lib/platform'
import { useAppInfo } from '@renderer/lib/use-app-info'
import { useUpdatesStore } from '@renderer/stores/updates'
import { openSettings, showShortcuts } from '@renderer/stores/view'
import { NavRow } from './app-sidebar'
import { signInLabel, useNotices } from './notices'

const README_URL = 'https://github.com/KettuAI/Kettu#readme'

/**
 * The footer: the notices as cards, over the Settings row and, at its end, small buttons that
 * leave Settings its whole name at the sidebar's narrowest.
 */
export function SidebarFooterContent() {
  const { t } = useTranslation('sidebar')
  const notices = useNotices()
  return (
    <>
      {notices.signIn.length > 0 && <SignInCard names={notices.signIn} />}
      {notices.agentUpdate && <AgentUpdateCard notice={notices.agentUpdate} />}
      {notices.appUpdate && <UpdateNoticeCard notice={notices.appUpdate} />}
      <div className="flex items-center gap-0.5">
        <NavRow
          icon={<SettingsIcon />}
          label={t('footer.settings')}
          ariaLabel={t('footer.settings')}
          shortcut="Mod+,"
          onClick={() => openSettings()}
        />
        <FooterButton label={t('footer.archived')} onClick={() => openSettings('archived')}>
          <ArchiveIcon className="size-4" />
        </FooterButton>
        <FooterButton
          label={t('footer.shortcuts')}
          shortcut="Mod+/"
          onClick={() => showShortcuts(true)}
        >
          <KeyboardIcon className="size-4" />
        </FooterButton>
        <HelpMenu />
      </div>
    </>
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
            variant="quiet"
            size="icon-xs"
            aria-label={label}
            onClick={onClick}
            className="text-icon"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && <Kbd>{formatShortcut(shortcut)}</Kbd>}
      </TooltipContent>
    </Tooltip>
  )
}

function HelpMenu() {
  const { t } = useTranslation('sidebar')
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  variant="quiet"
                  size="icon-xs"
                  aria-label={t('footer.help')}
                  className="text-icon"
                />
              }
            />
          }
        >
          <CircleHelpIcon className="size-4" />
        </TooltipTrigger>
        <TooltipContent>{t('footer.help')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="top" align="end">
        <HelpMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Inside the menu's content, so the app's information is read when the menu opens. */
function HelpMenuItems() {
  const { t } = useTranslation('sidebar')
  const info = useAppInfo()
  const version = useUpdatesStore((s) => s.status?.current)
  const links = [
    { label: t('footer.documentation'), href: README_URL },
    { label: t('footer.reportProblem'), href: bugReportUrl(info) },
    { label: t('footer.whatsNew'), href: version ? releaseUrl(version) : RELEASES_URL },
  ]
  return (
    <>
      {links.map((link) => (
        <DropdownMenuItem
          key={link.href}
          render={<a href={link.href} target="_blank" rel="noreferrer" />}
        >
          <ExternalLinkIcon />
          {link.label}
        </DropdownMenuItem>
      ))}
    </>
  )
}

/** An agent needs sign-in: something to do, so it takes the warning color, and it cannot be dismissed. */
function SignInCard({ names }: { names: string[] }) {
  const { t } = useTranslation('sidebar')
  const label = signInLabel(names)
  return (
    <NoticeCard
      icon={<span aria-hidden className="size-1.5 rounded-full bg-current text-warning" />}
      text={label}
      label={label}
      detail={t('footer.signInDetail')}
      onOpen={() => openSettings('agents')}
    />
  )
}
