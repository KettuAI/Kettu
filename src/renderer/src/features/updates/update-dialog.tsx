import { useEffect, useRef, useState } from 'react'
import { InformationCircleIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { RunningWork } from '@shared/ipc'
import { releaseUrl, restartWaitsFor } from '@shared/updates'
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
import { errorMessage } from '@renderer/lib/host'
import { openUpdateDialog, useUpdatesStore } from '@renderer/stores/updates'
import { Glyph } from '@renderer/features/shell/glyph'
import { RunningWorkList } from './running-work'

// The list follows the sessions while the dialog is open, as they start and finish.
const WORK_POLL_MS = 2000

/** What a restart would stop, read again while `open`; null until the first answer. */
function useRunningWork(open: boolean): RunningWork | null {
  const [work, setWork] = useState<RunningWork | null>(null)
  useEffect(() => {
    if (!open) return
    let live = true
    const read = (): void => {
      window.kettu.updates
        .runningWork()
        .then((next) => live && setWork(next))
        .catch((error: unknown) =>
          console.warn(`Could not read the running work: ${errorMessage(error)}`),
        )
    }
    read()
    const timer = setInterval(read, WORK_POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
      // The next opening starts without the list it showed before.
      setWork(null)
    }
  }, [open])
  return work
}

function useNow(open: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!open) return
    const tick = (): void => setNow(Date.now())
    const first = setTimeout(tick, 0)
    const timer = setInterval(tick, 1000)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [open])
  return now
}

function warnOnFailure(call: Promise<void>, what: string): void {
  call.catch((error: unknown) => console.warn(`Could not ${what}: ${errorMessage(error)}`))
}

/**
 * A downloaded update, before the restart into it: its version, what it changed in the user's
 * language, the work a restart would stop, and Restart now or Later. With sessions working it
 * offers to restart once they finish instead, and while that waits it can stop waiting. Restart on
 * the update card opens it; it never opens itself.
 */
export function UpdateDialog() {
  const { t, i18n } = useTranslation('updates')
  const defaultButton = useRef<HTMLButtonElement>(null)
  const open = useUpdatesStore((s) => s.dialogOpen)
  const state = useUpdatesStore((s) => s.status?.state ?? null)
  const waiting = useUpdatesStore((s) => s.status?.restartWhenIdle ?? null) !== null
  const ready = state?.kind === 'ready' ? state : null
  const shown = open && !!ready
  const work = useRunningWork(shown)
  const now = useNow(shown)
  const notes = ready?.notes
  const highlights =
    (i18n.language.startsWith('zh') ? notes?.['zh-CN'] : undefined) ?? notes?.en ?? []
  const sessions = work?.sessions ?? []
  const terminals = work?.terminals ?? []
  const busy = sessions.length + terminals.length > 0
  const waitable = sessions.some(restartWaitsFor)
  // Waiting covers turns and subagents; terminal commands and background tasks still stop.
  const notWaited = terminals.length > 0 || sessions.some((s) => !restartWaitsFor(s))

  const restartNow = () => {
    openUpdateDialog(false)
    // The work shown was confirmed here; with none shown, main still asks if some has started.
    const updates = window.kettu.updates
    warnOnFailure(busy ? updates.restartConfirmed() : updates.restart(), 'restart to update')
  }
  const restartWhenIdle = () => {
    openUpdateDialog(false)
    warnOnFailure(window.kettu.updates.restartWhenIdle(), 'wait to restart to update')
  }
  const stopWaiting = () => {
    openUpdateDialog(false)
    warnOnFailure(window.kettu.updates.cancelRestartWhenIdle(), 'stop waiting to restart')
  }

  const note = waiting
    ? t('dialog.waiting')
    : waitable
      ? `${t('dialog.waitable')}${notWaited ? t('dialog.notWaited') : ''}`
      : busy
        ? t('dialog.stops')
        : t('dialog.note')

  return (
    <AlertDialog open={shown} onOpenChange={(next) => openUpdateDialog(next)}>
      <AlertDialogContent
        initialFocus={defaultButton}
        className="gap-0 px-5.5 pt-5 pb-4.5 data-[size=default]:sm:max-w-[460px]"
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('dialog.title', { version: ready?.version ?? '' })}
          </AlertDialogTitle>
        </AlertDialogHeader>
        {highlights.length > 0 && (
          <ul className="mt-3.5 list-disc pl-4.5 text-ui leading-relaxed text-foreground">
            {highlights.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        {busy && (
          <>
            <p className="mt-4 text-control text-secondary">
              {waiting || waitable ? t('dialog.working') : t('dialog.running')}
            </p>
            <RunningWorkList sessions={sessions} terminals={terminals} now={now} />
          </>
        )}
        <AlertDialogDescription className="mt-3 flex gap-2 rounded-[10px] bg-(--shell-chip) px-3 py-2.5 text-hint leading-normal text-secondary">
          <Glyph icon={InformationCircleIcon} size={14} className="mt-0.5 shrink-0 text-tertiary" />
          {note}
        </AlertDialogDescription>
        <AlertDialogFooter className="mt-4.5 items-center">
          {ready && (
            <a
              href={releaseUrl(ready.version)}
              target="_blank"
              rel="noreferrer"
              className="mr-auto text-control text-secondary underline underline-offset-2 hover:text-foreground focus-ring"
            >
              {t('dialog.releaseNotes')}
            </a>
          )}
          {waiting ? (
            <>
              <Button variant="ghost" size="dialog" onClick={stopWaiting}>
                {t('dialog.stopWaiting')}
              </Button>
              <Button variant="outline" size="dialog" onClick={restartNow}>
                {t('dialog.restart')}
              </Button>
              <AlertDialogCancel ref={defaultButton} variant="default">
                {t('dialog.keepWaiting')}
              </AlertDialogCancel>
            </>
          ) : waitable ? (
            <>
              <AlertDialogCancel variant="ghost">{t('dialog.later')}</AlertDialogCancel>
              <Button variant="outline" size="dialog" onClick={restartNow}>
                {t('dialog.restart')}
              </Button>
              <AlertDialogAction ref={defaultButton} onClick={restartWhenIdle}>
                {t('dialog.restartWhenIdle')}
              </AlertDialogAction>
            </>
          ) : (
            <>
              <AlertDialogCancel variant="outline">{t('dialog.later')}</AlertDialogCancel>
              <AlertDialogAction ref={defaultButton} onClick={restartNow}>
                {t('dialog.restart')}
              </AlertDialogAction>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
