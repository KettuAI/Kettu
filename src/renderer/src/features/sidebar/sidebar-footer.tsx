import { ArrowRightIcon, SettingsIcon } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { UpdateNotice } from '@renderer/features/updates/update-notice'
import { useAgentsStore } from '@renderer/stores/agents'
import { openSettings, useViewStore } from '@renderer/stores/view'
import { NavRow } from './app-sidebar'

export function SidebarFooterContent() {
  const settingsOpen = useViewStore((s) => s.settings.open)
  return (
    <>
      <SignInNotice />
      <UpdateNotice />
      <NavRow
        icon={<SettingsIcon className="text-muted-foreground" />}
        label="Settings"
        shortcut="Mod+,"
        current={settingsOpen}
        onClick={() => openSettings()}
      />
    </>
  )
}

function SignInNotice() {
  const names = useAgentsStore(
    useShallow((s) =>
      s.order.filter((id) => s.byId[id]?.signIn === 'required').map((id) => s.byId[id]!.name),
    ),
  )
  if (!names.length) return null
  const text =
    names.length === 1
      ? `${names[0]} needs you to sign in`
      : `${names.length} agents need you to sign in`
  return (
    <button
      type="button"
      onClick={() => openSettings('agents')}
      className="flex min-h-8 animate-in items-center gap-2 rounded-lg bg-attention-tint pr-2 pl-2.5 text-left text-xs text-attention-text duration-(--duration-slow) ease-out-quint fade-in slide-in-from-bottom-1 outline-none hover:bg-attention-tint/80 focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-attention" />
      <span className="flex-1">{text}</span>
      <ArrowRightIcon className="size-3.5" />
    </button>
  )
}
