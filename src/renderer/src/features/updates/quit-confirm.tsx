import { useEffect, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { QuitRequest } from '@shared/ipc'
import { restartWaitsFor } from '@shared/updates'
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
import { cn } from '@renderer/lib/utils'
import { saveAll } from '@renderer/stores/files'
import { useSettingsStore } from '@renderer/stores/settings'
import { RunningWorkList } from './running-work'

export interface QuitConfirmViewProps {
  request: QuitRequest | null
  saving: boolean
  saveFailed: boolean
  remote: boolean
  now: number
  keepRef: RefObject<HTMLButtonElement | null>
  waitRef: RefObject<HTMLButtonElement | null>
  onAnswer: (value: boolean | 'background' | 'when-idle') => void
  onSaveThenAnswer: () => void
}

/**
 * Presentation for the quit/restart confirmation dialog: pins the header and footer actions while
 * letting long running-work and unsaved-file lists scroll inside a viewport-bounded body.
 */
export function QuitConfirmView({
  request,
  saving,
  saveFailed,
  remote,
  now,
  keepRef,
  waitRef,
  onAnswer,
  onSaveThenAnswer,
}: QuitConfirmViewProps) {
  const { t } = useTranslation(['updates', 'common'])
  const open = request !== null
  const reason = request?.reason ?? 'quit'
  const restarts = reason === 'update' || reason === 'restart'
  const sessions = request?.sessions ?? []
  const terminals = request?.terminals ?? []
  const busy = sessions.length + terminals.length > 0
  const unsaved = request?.unsaved ?? []
  const keepRunning = !!request?.keepRunning
  const whenIdle = !!request?.whenIdle && unsaved.length === 0
  // Waiting covers turns and subagents; terminal commands and background tasks still stop.
  const notWaited = terminals.length > 0 || sessions.some((s) => !restartWaitsFor(s))
  const hasBody = busy || unsaved.length > 0 || saveFailed || keepRunning
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
    <AlertDialog open={open} onOpenChange={(next) => !next && !saving && onAnswer(false)}>
      <AlertDialogContent
        initialFocus={keepRunning ? keepRef : whenIdle ? waitRef : true}
        className="flex flex-col gap-0 overflow-hidden px-0 pt-5 pb-4.5 data-[size=default]:sm:max-w-[440px]"
      >
        <AlertDialogHeader className="shrink-0 px-5.5">
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {!keepRunning && (
            <AlertDialogDescription>
              {busy
                ? whenIdle
                  ? t('quit.stillWorking')
                  : restarts
                    ? t('quit.stopsUpdate')
                    : t('quit.stopsQuit')
                : t('quit.unsavedFiles')}
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {hasBody && (
          <div
            data-slot="quit-confirm-body"
            className={cn(busy ? 'mt-3.5' : 'mt-3', 'min-h-0 flex-1 overflow-y-auto px-5.5')}
          >
            {busy && (
              <RunningWorkList
                sessions={sessions}
                terminals={terminals}
                now={now}
                className="mt-0"
              />
            )}
            {busy && unsaved.length > 0 && (
              <p className="mt-3 text-control leading-normal text-secondary">
                {t('quit.unsavedFiles')}
              </p>
            )}
            {unsaved.length > 0 && (
              <ul className={cn(busy && 'mt-3', 'rounded-code bg-subtle py-0.5 text-ui')}>
                {unsaved.map((file) => (
                  <li
                    key={`${file.projectPath}\0${file.path}`}
                    className="flex h-8 shrink-0 items-center gap-2 px-2.5"
                    title={file.path}
                  >
                    <FileTypeIcon path={file.path} className="size-3.5 shrink-0" />
                    <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                      <span className="shrink-0">{nameOf(file.path)}</span>
                      <span className="truncate text-xs text-tertiary">{folderOf(file.path)}</span>
                    </span>
                    <span className="shrink-0 text-xs text-tertiary">{t('quit.unsaved')}</span>
                  </li>
                ))}
              </ul>
            )}
            {saveFailed ? (
              <p
                className={cn(
                  (busy || unsaved.length > 0) && 'mt-3',
                  'text-control leading-normal text-danger',
                )}
              >
                {t('quit.saveFailed')}
              </p>
            ) : keepRunning ? (
              <AlertDialogDescription
                className={cn(
                  (busy || unsaved.length > 0) && 'mt-3',
                  'text-control leading-normal text-secondary',
                )}
              >
                {remote ? t('quit.keepRunningRemote') : t('quit.keepRunning')}
              </AlertDialogDescription>
            ) : (
              busy && (
                <p className="mt-3 text-control leading-normal text-secondary">
                  {whenIdle
                    ? `${t('quit.waitHint')}${notWaited ? t('quit.notWaited') : ''}`
                    : restarts
                      ? t('quit.comeBackUpdate')
                      : t('quit.comeBackQuit')}
                </p>
              )
            )}
          </div>
        )}
        <AlertDialogFooter className="mt-4.5 shrink-0 items-center px-5.5">
          <AlertDialogCancel variant="ghost" disabled={saving} onClick={() => onAnswer(false)}>
            {t('common:actions.cancel')}
          </AlertDialogCancel>
          <span aria-hidden className="hidden flex-1 sm:block" />
          {unsaved.length > 0 ? (
            <>
              <Button
                variant="outline"
                size="dialog"
                disabled={saving}
                onClick={() => onAnswer(true)}
              >
                {t('quit.dontSave')}
              </Button>
              <AlertDialogAction disabled={saving} onClick={onSaveThenAnswer}>
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
              <Button variant="outline" size="dialog" onClick={() => onAnswer(true)}>
                {t('quit.stopAndQuit')}
              </Button>
              <AlertDialogAction ref={keepRef} onClick={() => onAnswer('background')}>
                {t('quit.keepRunningAction')}
              </AlertDialogAction>
            </>
          ) : whenIdle ? (
            <>
              <Button variant="outline" size="dialog" onClick={() => onAnswer(true)}>
                {t('quit.restartNow')}
              </Button>
              <AlertDialogAction ref={waitRef} onClick={() => onAnswer('when-idle')}>
                {t('quit.restartWhenIdle')}
              </AlertDialogAction>
            </>
          ) : (
            <AlertDialogAction onClick={() => onAnswer(true)}>
              {restarts ? t('quit.restart') : t('quit.quit')}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * Main asks before a quit or an update restart would stop agents or terminal commands, or would
 * lose unsaved files; on macOS, also before closing the window with unsaved files. A quit with
 * work running offers to keep it running in the background, and a restart to update with sessions
 * working offers to wait for them; either is the default, since stopping can lose work.
 */
export function QuitConfirm() {
  const [request, setRequest] = useState<QuitRequest | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const remote = useSettingsStore((s) => s.settings.remote.enabled)
  const keep = useRef<HTMLButtonElement>(null)
  const wait = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const offAsk = window.kettu.app.onConfirmQuit((next) => {
      setSaveFailed(false)
      setNow(Date.now())
      setRequest(next)
    })
    const offResolved = window.kettu.app.onConfirmQuitResolved((id) => {
      setRequest((current) => (current?.id === id ? null : current))
    })
    return () => {
      offAsk()
      offResolved()
    }
  }, [])
  const open = request !== null
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [open])

  const answer = (value: boolean | 'background' | 'when-idle') => {
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

  return (
    <QuitConfirmView
      request={request}
      saving={saving}
      saveFailed={saveFailed}
      remote={remote}
      now={now}
      keepRef={keep}
      waitRef={wait}
      onAnswer={answer}
      onSaveThenAnswer={() => void saveThenAnswer()}
    />
  )
}
