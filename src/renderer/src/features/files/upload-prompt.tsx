import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { useUploadStore, type ReplaceAsk, type ReplaceChoice } from './upload'

/** Asks whether an upload replaces what has its name, for the side panel `panel`'s uploads. */
export function ReplacePrompt({ panel }: { panel: string }) {
  const { t } = useTranslation('files')
  const asking = useUploadStore((s) => s.asks.find((ask) => ask.panel === panel) ?? null)
  // The last question stays in the box while it fades; the box for the rest starts unticked.
  const [shown, setShown] = useState<ReplaceAsk | null>(asking)
  const [all, setAll] = useState(false)
  if (asking && asking !== shown) {
    setShown(asking)
    setAll(false)
  }
  const answer = (choice: ReplaceChoice) => asking?.answer(choice, all)
  const what = { name: shown?.name ?? '', place: shown?.place ?? '' }
  // Enter replaces, as a file manager's question does; Esc stops.
  const replace = useRef<HTMLButtonElement>(null)
  return (
    <AlertDialog open={asking !== null} onOpenChange={(open) => !open && answer('stop')}>
      <AlertDialogContent className="sm:max-w-[420px]" initialFocus={replace}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('upload.replaceTitle', { name: what.name })}</AlertDialogTitle>
          <AlertDialogDescription>
            {shown?.folder ? t('upload.replaceFolder', what) : t('upload.replaceFile', what)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {!!shown?.rest && (
          <label className="flex items-center gap-2.5 text-ui text-secondary">
            <Checkbox checked={all} onCheckedChange={(checked) => setAll(checked === true)} />
            {t('upload.forTheRest')}
          </label>
        )}
        {/* Stop apart on the left, away from the answers for this item. */}
        <AlertDialogFooter>
          <Button
            variant="outline"
            size="dialog"
            className="sm:mr-auto"
            onClick={() => answer('stop')}
          >
            {t('upload.stop')}
          </Button>
          <Button variant="outline" size="dialog" onClick={() => answer('skip')}>
            {t('upload.skip')}
          </Button>
          <AlertDialogAction ref={replace} onClick={() => answer('replace')}>
            {t('upload.replace')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
