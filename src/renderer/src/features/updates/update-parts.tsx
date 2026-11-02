import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentId } from '@shared/thread'
import kettuGlyph from '@renderer/assets/kettu-glyph-on-dark.svg'
import { AgentMark } from '@renderer/components/agents/agent-mark'
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
import type { UpdateItem } from './card-model'
import { runningSessions, updateHarnessNow } from './harness-updates'
import { CARD_BUTTON, runAppAction } from './update-actions'

/** Kettu's own mark: the fox on its dark tile. */
export function KettuTile({ size }: { size: number }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className="grid shrink-0 place-items-center overflow-hidden rounded-tile bg-(--kettu-tile) shadow-[0_0_0_var(--hairline)_var(--border-subtle)]"
    >
      <img
        src={kettuGlyph}
        alt=""
        draggable={false}
        style={{ width: Math.round(size * 0.66), height: Math.round(size * 0.66) }}
      />
    </span>
  )
}

/** A harness's mark on an opaque tile, so marks can overlap in a stack. */
export function HarnessTile({ agentId, size }: { agentId: AgentId; size: number }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className="grid shrink-0 place-items-center rounded-tile bg-tile shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)]"
    >
      <AgentMark agent={agentId} size={Math.round(size * 0.62)} />
    </span>
  )
}

export function ItemTile({ item, size }: { item: UpdateItem; size: number }) {
  return item.kind === 'app' ? (
    <KettuTile size={size} />
  ) : (
    <HarnessTile agentId={item.offer.agentId} size={size} />
  )
}

/** A card's small button: Kettu's own action in ink, a harness's on the subtle fill. */
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

/** The app's action: Restart and Update run here, Download and What's new open the browser. */
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
          <AlertDialogAction onClick={() => void updateHarnessNow(agentId)}>
            {t('harness.nowConfirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
