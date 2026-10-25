import { ArrowRightIcon, SettingsIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { AgentUpdateNotice } from '@renderer/features/updates/agent-update-notice'
import { UpdateNotice } from '@renderer/features/updates/update-notice'
import { useAgentsStore } from '@renderer/stores/agents'
import { openSettings, useViewStore } from '@renderer/stores/view'
import { NavRow } from './app-sidebar'

export function SidebarFooterContent() {
  const { t } = useTranslation('sidebar')
  const settingsOpen = useViewStore((s) => s.settings.open)
  return (
    <>
      <SignInNotice />
      <AgentUpdateNotice />
      <UpdateNotice />
      <NavRow
        icon={<SettingsIcon />}
        label={t('footer.settings')}
        current={settingsOpen}
        onClick={() => openSettings()}
      />
    </>
  )
}

function SignInNotice() {
  const { t } = useTranslation('sidebar')
  const names = useAgentsStore(
    useShallow((s) =>
      s.order.filter((id) => s.byId[id]?.signIn === 'required').map((id) => s.byId[id]!.name),
    ),
  )
  if (!names.length) return null
  const text =
    names.length === 1
      ? t('footer.signInOne', { name: names[0] })
      : t('footer.signInMany', { count: names.length })
  return (
    <button
      type="button"
      onClick={() => openSettings('agents')}
      className="flex min-h-8 animate-in items-center gap-2 rounded-lg bg-subtle pr-2 pl-2.5 text-left text-xs text-secondary animation-duration-(--duration-slow) ease-out-quint fade-in slide-in-from-bottom-1 outline-none transition-colors duration-(--duration-fast) hover:bg-hover focus-ring"
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current text-warning" />
      <span className="flex-1">{text}</span>
      <ArrowRightIcon className="size-3.5" />
    </button>
  )
}
