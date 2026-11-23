import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentId } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { BrandFox } from '@renderer/components/brand'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { appUpdateText, type AppUpdateNotice } from './app-updates'
import { runningSessions, updateHarnessNow } from './harness-updates'
import { CARD_BUTTON, runAppAction } from './update-actions'

/** A harness's mark, or Kettu's fox for `null`, drawn bare at `size`, without a tile. */
export function UpdateMark({ agentId, size }: { agentId: AgentId | null; size: number }) {
  if (agentId === null) {
    return (
      <span aria-hidden style={{ width: size, height: size }} className="flex shrink-0">
        <BrandFox className="size-full" />
      </span>
    )
  }
  return <AgentMark agent={agentId} size={size} dot={null} />
}

/** A card's small button: its own action primary, a quiet one plain, others on the subtle fill. */
export function CardButton({
  primary,
  quiet,
  onClick,
  children,
}: {
  primary?: boolean
  quiet?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Button
      size="xs"
      variant={primary ? 'default' : quiet ? 'ghost' : 'secondary'}
      onClick={onClick}
      className={CARD_BUTTON}
    >
      {children}
    </Button>
  )
}

/** The app's action: Restart, Update and Download run here, What's new opens the browser. */
export function AppAction({ notice }: { notice: AppUpdateNotice }) {
  const text = appUpdateText(notice)
  if (!text.action) return null
  if (text.href) {
    return (
      <a
        href={text.href}
        target="_blank"
        rel="noreferrer"
        className={buttonVariants({ variant: 'secondary', size: 'xs', className: CARD_BUTTON })}
      >
        {text.actionLabel}
      </a>
    )
  }
  return (
    <CardButton primary onClick={() => runAppAction(text.action)}>
      {text.actionLabel}
    </CardButton>
  )
}

/** "Now" on an update that waits: stopping the harness's running sessions asks first. */
export function UpdateNowDialog({
  agentId,
  name,
  open,
  onOpenChange,
}: {
  agentId: AgentId
  name: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation(['updates', 'common'])
  const count = open ? runningSessions(agentId).length : 0
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('harness.nowTitle', { name, count })}</AlertDialogTitle>
          <AlertDialogDescription>{t('harness.nowBody', { name })}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              onOpenChange(false)
              void updateHarnessNow(agentId)
            }}
          >
            {t('harness.nowConfirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
