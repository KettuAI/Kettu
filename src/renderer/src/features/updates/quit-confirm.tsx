import { useEffect, useRef, useState } from 'react'
import { ComputerTerminal01Icon } from '@hugeicons/core-free-icons'
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
import { RingSpinner, Spinner } from '@renderer/components/ui/spinner'
import { FileTypeIcon } from '@renderer/features/files/file-type-icon'
import { folderOf, nameOf } from '@renderer/features/files/paths'
import { runningFor } from '@renderer/lib/format'
import { saveAll } from '@renderer/stores/files'
import { sessionTitle } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import { Glyph } from '@renderer/features/shell/glyph'

/**
 * Main asks before a quit or an update restart would stop agents or terminal commands, or would
 * lose unsaved files; on macOS, also before closing the window with unsaved files. A quit with
 * work running offers to keep it running in the background, the default, since stopping can lose
 * work.
 */
export function QuitConfirm() {
  const { t } = useTranslation(['updates', 'common'])
  const [request, setRequest] = useState<QuitRequest | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const remote = useSettingsStore((s) => s.settings.remote.enabled)
  const keep = useRef<HTMLButtonElement>(null)
  useEffect(
    () =>
      window.kettu.app.onConfirmQuit((next) => {
        setSaveFailed(false)
        setNow(Date.now())
        setRequest(next)
      }),
    [],
  )
  const open = request !== null
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [open])

  const answer = (value: boolean | 'background') => {
    if (!request) return
    void window.kettu.app.respondQuit(request.id, value)
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
  const restarts = reason === 'update' || reason === 'restart'
  const sessions = request?.sessions ?? []
  const terminals = request?.terminals ?? []
  const busy = sessions.length + terminals.length > 0
  const unsaved = request?.unsaved ?? []
  const keepRunning = !!request?.keepRunning
  const title =
    reason === 'update'
      ? t('quit.titleUpdate')
      : reason === 'restart'
        ? t('quit.titleRestart')
        : reason === 'close'
          ? t('quit.titleClose')
          : busy
            ? sessions.length > 0
              ? t('quit.sessionsRunning', { count: sessions.length })
              : t('quit.terminalsRunning', { count: terminals.length })
            : t('quit.titleQuit')
  return (
    <AlertDialog open={open} onOpenChange={(open) => !open && !saving && answer(false)}>
      <AlertDialogContent
        initialFocus={keepRunning ? keep : true}
        className="gap-0 px-5.5 pt-5 pb-4.5 data-[size=default]:sm:max-w-[440px]"
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {!keepRunning && (
            <AlertDialogDescription>
              {busy
                ? restarts
                  ? t('quit.stopsUpdate')
                  : t('quit.stopsQuit')
                : t('quit.unsavedFiles')}
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {busy && (
          <ul className="mt-3.5 flex flex-col text-ui">
            {sessions.map((s) => (
              <li
                key={s.sessionId}
                className="flex h-8.5 items-center gap-2.5 border-b border-border-soft"
              >
                <AgentMark agent={s.agentId} size={16} />
                <span className="min-w-0 flex-1 truncate">{sessionTitle(s)}</span>
                {s.turnStartedAt !== null && (
                  <span className="flex shrink-0 items-center gap-2 text-small text-tertiary tabular">
                    <RingSpinner aria-hidden />
                    {runningFor(now - s.turnStartedAt)}
                  </span>
                )}
              </li>
            ))}
            {terminals.map((terminal) => (
              <li
                key={terminal.id}
                className="flex h-8.5 items-center gap-2.5 border-b border-border-soft"
              >
                <Glyph icon={ComputerTerminal01Icon} className="text-icon" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{terminal.title}</span>
                <span className="text-small text-tertiary">{t('quit.terminal')}</span>
              </li>
            ))}
          </ul>
        )}
        {busy && unsaved.length > 0 && (
          <p className="mt-3 text-control leading-normal text-secondary">
            {t('quit.unsavedFiles')}
          </p>
        )}
        {unsaved.length > 0 && (
          <ul className="mt-3 rounded-code bg-subtle py-0.5 text-ui">
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
          <p className="mt-3 text-control leading-normal text-danger">{t('quit.saveFailed')}</p>
        ) : keepRunning ? (
          <AlertDialogDescription className="mt-3 text-control leading-normal text-secondary">
            {remote ? t('quit.keepRunningRemote') : t('quit.keepRunning')}
          </AlertDialogDescription>
        ) : (
          busy && (
            <p className="mt-3 text-control leading-normal text-secondary">
              {restarts ? t('quit.comeBackUpdate') : t('quit.comeBackQuit')}
            </p>
          )
        )}
        <AlertDialogFooter className="mt-4.5 items-center">
          <AlertDialogCancel variant="ghost" disabled={saving} onClick={() => answer(false)}>
            {t('common:actions.cancel')}
          </AlertDialogCancel>
          <span aria-hidden className="hidden flex-1 sm:block" />
          {unsaved.length > 0 ? (
            <>
              <Button
                variant="outline"
                size="dialog"
                disabled={saving}
                onClick={() => answer(true)}
              >
                {t('quit.dontSave')}
              </Button>
              <AlertDialogAction disabled={saving} onClick={() => void saveThenAnswer()}>
                {saving && <Spinner />}
                {restarts
                  ? t('quit.saveAndRestart')
                  : reason === 'close'
                    ? t('quit.saveAndClose')
                    : t('quit.saveAndQuit')}
              </AlertDialogAction>
            </>
          ) : keepRunning ? (
            <>
              <Button variant="outline" size="dialog" onClick={() => answer(true)}>
                {t('quit.stopAndQuit')}
              </Button>
              <AlertDialogAction ref={keep} onClick={() => answer('background')}>
                {t('quit.keepRunningAction')}
              </AlertDialogAction>
            </>
          ) : (
            <AlertDialogAction onClick={() => answer(true)}>
              {restarts ? t('quit.restart') : t('quit.quit')}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
