import { ArrowRightIcon, SettingsIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { UpdateNotice } from '@renderer/features/updates/update-notice'
import { useAgentsStore } from '@renderer/stores/agents'
import { openSettings, useViewStore } from '@renderer/stores/view'
import { NavRow } from './app-sidebar'
import { PlanUsageStrip } from './plan-usage-strip'

export function SidebarFooterContent() {
  const { t } = useTranslation('sidebar')
  const settingsOpen = useViewStore((s) => s.settings.open)
  return (
    <>
      <SignInNotice />
      <UpdateNotice />
      <PlanUsageStrip />
      <NavRow
        icon={<SettingsIcon className="text-muted-foreground" />}
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
      className="flex min-h-8 animate-in items-center gap-2 rounded-lg bg-attention-tint pr-2 pl-2.5 text-left text-xs text-attention-text animation-duration-(--duration-slow) ease-out-quint fade-in slide-in-from-bottom-1 outline-none transition-colors duration-(--duration-fast) hover:bg-attention-tint/80 focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-attention" />
      <span className="flex-1">{text}</span>
      <ArrowRightIcon className="size-3.5" />
    </button>
  )
}
