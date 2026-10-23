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
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { FileTypeIcon } from '@renderer/features/files/file-type-icon'
import { folderOf, nameOf } from '@renderer/features/files/paths'
import { saveAll } from '@renderer/stores/files'
import { sessionTitle } from '@renderer/stores/sessions'

/**
 * Main asks before a quit or an update restart would stop agents or terminal commands, or would
 * lose unsaved files; on macOS, also before closing the window with unsaved files.
 */
export function QuitConfirm() {
  const { t } = useTranslation(['updates', 'common'])
  const [request, setRequest] = useState<QuitRequest | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  useEffect(
    () =>
      window.overbench.app.onConfirmQuit((next) => {
        setSaveFailed(false)
        setRequest(next)
      }),
    [],
  )

  const answer = (confirmed: boolean) => {
    if (!request) return
    void window.overbench.app.respondQuit(request.id, confirmed)
    setRequest(null)
  }

  const saveThenAnswer = async () => {
    setSaving(true)
    const saved = await saveAll()
    setSaving(false)
    if (saved) answer(true)
    else setSaveFailed(true)
  }

  const reason = request?.reason ?? 'quit'
  const busy = !!request && request.sessions.length + request.terminals.length > 0
  const unsaved = request?.unsaved ?? []
  const title =
    reason === 'update'
      ? t('quit.titleUpdate')
      : reason === 'close'
        ? t('quit.titleClose')
        : t('quit.titleQuit')
  return (
    <AlertDialog open={!!request} onOpenChange={(open) => !open && !saving && answer(false)}>
      <AlertDialogContent className="sm:max-w-[380px]">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>
            {busy
              ? reason === 'update'
                ? t('quit.stopsUpdate')
                : t('quit.stopsQuit')
              : t('quit.unsavedFiles')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {busy && (
          <ul className="rounded-[9px] bg-subtle py-0.5 text-ui">
            {request?.sessions.map((s) => (
              <li key={s.sessionId} className="flex h-8 items-center gap-2 px-2.5">
                <AgentMark agent={s.agentId} size={14} />
                <span className="min-w-0 flex-1 truncate">{sessionTitle(s)}</span>
                <span className="text-xs text-tertiary">{t('quit.working')}</span>
              </li>
            ))}
            {request?.terminals.map((terminal) => (
              <li key={terminal.id} className="flex h-8 items-center gap-2 px-2.5">
                <SquareTerminalIcon className="size-3.5 text-icon" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{terminal.title}</span>
                <span className="text-xs text-tertiary">{t('quit.terminal')}</span>
              </li>
            ))}
          </ul>
        )}
        {busy && unsaved.length > 0 && (
          <p className="text-[12.5px] leading-normal text-secondary">{t('quit.unsavedFiles')}</p>
        )}
        {unsaved.length > 0 && (
          <ul className="rounded-[9px] bg-subtle py-0.5 text-ui">
            {unsaved.map((file) => (
              <li
                key={`${file.projectPath}\0${file.path}`}
                className="flex h-8 items-center gap-2 px-2.5"
                title={file.path}
              >
                <FileTypeIcon path={file.path} className="size-3.5" />
                <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                  <span className="shrink-0">{nameOf(file.path)}</span>
                  <span className="truncate text-xs text-tertiary">{folderOf(file.path)}</span>
                </span>
                <span className="text-xs text-tertiary">{t('quit.unsaved')}</span>
              </li>
            ))}
          </ul>
        )}
        {saveFailed ? (
          <p className="text-[12.5px] leading-normal text-danger">{t('quit.saveFailed')}</p>
        ) : (
          busy && (
            <p className="text-[12.5px] leading-normal text-secondary">
              {reason === 'update' ? t('quit.comeBackUpdate') : t('quit.comeBackQuit')}
            </p>
          )
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving} onClick={() => answer(false)}>
            {t('common:actions.cancel')}
          </AlertDialogCancel>
          {unsaved.length > 0 ? (
            <>
              <Button variant="outline" disabled={saving} onClick={() => answer(true)}>
                {t('quit.dontSave')}
              </Button>
              <AlertDialogAction disabled={saving} onClick={() => void saveThenAnswer()}>
                {saving && <Spinner />}
                {reason === 'update'
                  ? t('quit.saveAndRestart')
                  : reason === 'close'
                    ? t('quit.saveAndClose')
                    : t('quit.saveAndQuit')}
              </AlertDialogAction>
            </>
          ) : (
            <AlertDialogAction onClick={() => answer(true)}>
              {reason === 'update' ? t('quit.restart') : t('quit.quit')}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
