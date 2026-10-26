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
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { AgentUpdateCard } from '@renderer/features/updates/agent-update-notice'
import { NoticeCard, UpdateNoticeCard } from '@renderer/features/updates/update-notice'
import { useUpdatesStore } from '@renderer/stores/updates'
import { openSettings } from '@renderer/stores/view'
import { NavRow } from './app-sidebar'
import { signInLabel, useNotices } from './notices'

const README_URL = 'https://github.com/overbench/overbench#readme'
const REPORT_URL = 'https://github.com/overbench/overbench/issues/new?template=bug.yml'

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
        <FooterButton label={t('footer.shortcuts')} onClick={() => openSettings('shortcuts')}>
          <KeyboardIcon className="size-4" />
        </FooterButton>
        <HelpMenu />
      </div>
    </>
  )
}

function FooterButton({
  label,
  onClick,
  children,
}: {
  label: string
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
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function HelpMenu() {
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
