import { useEffect, useState } from 'react'
import { SquareTerminalIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { QuitRequest } from '@shared/ipc'
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
import { sessionTitle } from '@renderer/stores/sessions'

/** Main asks before a quit or an update restart would stop agents or terminal commands. */
export function QuitConfirm() {
  const { t } = useTranslation(['updates', 'common'])
  const [request, setRequest] = useState<QuitRequest | null>(null)
  useEffect(() => window.overbench.app.onConfirmQuit(setRequest), [])

  const answer = (confirmed: boolean) => {
    if (!request) return
    void window.overbench.app.respondQuit(request.id, confirmed)
    setRequest(null)
  }

  const update = request?.reason === 'update'
  return (
    <AlertDialog open={!!request} onOpenChange={(open) => !open && answer(false)}>
      <AlertDialogContent className="sm:max-w-[380px]">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {update ? t('quit.titleUpdate') : t('quit.titleQuit')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {update ? t('quit.stopsUpdate') : t('quit.stopsQuit')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="rounded-[9px] bg-muted py-0.5 text-ui">
          {request?.sessions.map((s) => (
            <li key={s.sessionId} className="flex h-8 items-center gap-2 px-2.5">
              <AgentMark agent={s.agentId} size={14} />
              <span className="min-w-0 flex-1 truncate">{sessionTitle(s)}</span>
              <span className="text-xs text-muted-foreground">{t('quit.working')}</span>
            </li>
          ))}
          {request?.terminals.map((terminal) => (
            <li key={terminal.id} className="flex h-8 items-center gap-2 px-2.5">
              <SquareTerminalIcon className="size-3.5 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{terminal.title}</span>
              <span className="text-xs text-muted-foreground">{t('quit.terminal')}</span>
            </li>
          ))}
        </ul>
        <p className="text-[12.5px] leading-normal text-muted-foreground">
          {update ? t('quit.comeBackUpdate') : t('quit.comeBackQuit')}
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => answer(false)}>
            {t('common:actions.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction onClick={() => answer(true)}>
            {update ? t('quit.restart') : t('quit.quit')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
