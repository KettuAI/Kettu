import { useRef } from 'react'
import { InformationCircleIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { releaseUrl } from '@shared/updates'
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
import { errorMessage } from '@renderer/lib/host'
import { openUpdateDialog, useUpdatesStore } from '@renderer/stores/updates'
import { Glyph } from '@renderer/features/shell/glyph'

/**
 * A downloaded update, before the restart into it: its version, what it changed in the user's
 * language, and Restart now or Later. Restart on the update card opens it; it never opens itself.
 */
export function UpdateDialog() {
  const { t, i18n } = useTranslation('updates')
  const restartButton = useRef<HTMLButtonElement>(null)
  const open = useUpdatesStore((s) => s.dialogOpen)
  const state = useUpdatesStore((s) => s.status?.state ?? null)
  const ready = state?.kind === 'ready' ? state : null
  const notes = ready?.notes
  const highlights =
    (i18n.language.startsWith('zh') ? notes?.['zh-CN'] : undefined) ?? notes?.en ?? []

  const restart = () => {
    openUpdateDialog(false)
    window.kettu.updates
      .restart()
      .catch((error: unknown) =>
        console.warn(`Could not restart to update: ${errorMessage(error)}`),
      )
  }

  return (
    <AlertDialog open={open && !!ready} onOpenChange={(next) => openUpdateDialog(next)}>
      <AlertDialogContent
        initialFocus={restartButton}
        className="gap-0 px-5.5 pt-5 pb-4.5 data-[size=default]:sm:max-w-[420px]"
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
        <AlertDialogDescription className="mt-3 flex gap-2 rounded-[10px] bg-(--shell-chip) px-3 py-2.5 text-hint leading-normal text-secondary">
          <Glyph icon={InformationCircleIcon} size={14} className="mt-0.5 shrink-0 text-tertiary" />
          {t('dialog.note')}
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
          <AlertDialogCancel variant="outline">{t('dialog.later')}</AlertDialogCancel>
          <AlertDialogAction ref={restartButton} onClick={restart}>
            {t('dialog.restart')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
