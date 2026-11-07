import { useEffect, useState } from 'react'
import { Bug01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Icon } from '@renderer/components/affect/app-shell'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { TITLE_BUTTON } from '@renderer/features/shell/title-button'
import { errorMessage } from '@renderer/lib/host'
import { confirmDebugRestart, useDebugStore } from '@renderer/stores/debug'
import { openSettings } from '@renderer/stores/view'

/**
 * Debug mode's mark among the corner's controls, there for the whole debug run; it opens Settings ›
 * Advanced, which lists the ports and restarts normally.
 */
export function DebugMarker() {
  const { t } = useTranslation('shell')
  const on = useDebugStore((s) => s.status.on)
  // A head in the corner keeps clear of one more control.
  useEffect(() => {
    document.documentElement.toggleAttribute('data-debug', on)
  }, [on])
  if (!on) return null
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-debug-marker=""
            aria-label={t('debugMode.label')}
            onClick={() => openSettings('advanced')}
            className={TITLE_BUTTON}
          />
        }
      >
        <Icon icon={Bug01Icon} size={16} />
      </TooltipTrigger>
      <TooltipContent className="px-2.25 py-1.5">{t('debugMode.tooltip')}</TooltipContent>
    </Tooltip>
  )
}

/**
 * The confirmation before restarting in debug mode, which says what the ports let others do; from
 * Settings, or when Kettu was started again with `--debug`.
 */
export function DebugRestartDialog() {
  const { t } = useTranslation(['settings', 'common'])
  const open = useDebugStore((s) => s.confirming)
  const [error, setError] = useState<string | null>(null)
  const restart = () => {
    setError(null)
    window.kettu.debug.restart(true).then(
      () => confirmDebugRestart(false),
      (e: unknown) => setError(errorMessage(e)),
    )
  }
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && confirmDebugRestart(false)}>
      <AlertDialogContent className="data-[size=default]:sm:max-w-105">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('advanced.debugMode.confirm.title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('advanced.debugMode.confirm.body')}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-control leading-normal break-words text-danger">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          {/* Closes once main takes the request; its quit flow may ask about running work next. */}
          <AlertDialogAction onClick={restart}>
            {t('advanced.debugMode.confirm.action')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
