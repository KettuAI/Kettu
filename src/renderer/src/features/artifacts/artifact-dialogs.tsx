import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ARTIFACT_TITLE_CHARS, longer } from '@shared/artifacts'
import { CLOUDFLARE_FREE_WORKERS } from '@shared/sharing'
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
import { Checkbox } from '@renderer/components/ui/checkbox'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Field, FieldError, FieldLabel } from '@renderer/components/ui/field'
import { Input } from '@renderer/components/ui/input'
import { errorMessage } from '@renderer/lib/host'
import {
  askArtifactDialog,
  deleteArtifact,
  eraseArtifact,
  renameArtifact,
  useArtifactsStore,
  type ArtifactDialog,
} from '@renderer/stores/artifacts'
import { unpublishArtifact } from '@renderer/stores/sharing'

/** Renaming and deleting permanently, asked from any artifact's menu. */
export function ArtifactDialogs() {
  const dialog = useArtifactsStore((s) => s.dialog)
  const close = (): void => askArtifactDialog(null)
  return (
    <>
      <Dialog open={dialog?.kind === 'rename'} onOpenChange={(open) => !open && close()}>
        <DialogContent className="sm:max-w-md">
          {dialog?.kind === 'rename' && <RenameForm key={dialog.id} dialog={dialog} />}
        </DialogContent>
      </Dialog>
      <DeleteDialog dialog={dialog?.kind === 'delete' ? dialog : null} onClose={close} />
      <EraseDialog dialog={dialog?.kind === 'erase' ? dialog : null} onClose={close} />
    </>
  )
}

function RenameForm({ dialog }: { dialog: Extract<ArtifactDialog, { kind: 'rename' }> }) {
  const { t } = useTranslation(['artifacts', 'common'])
  const [title, setTitle] = useState(dialog.title)
  const [failed, setFailed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const trimmed = title.trim()
  const tooLong = longer(trimmed, ARTIFACT_TITLE_CHARS)
  const valid = trimmed.length > 0 && !tooLong

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!valid || busy) return
    if (trimmed === dialog.title) return askArtifactDialog(null)
    setBusy(true)
    try {
      await renameArtifact(dialog.id, trimmed)
      askArtifactDialog(null)
    } catch (error) {
      setFailed(errorMessage(error))
      setBusy(false)
    }
  }

  return (
    <form className="contents" onSubmit={(event) => void submit(event)}>
      <DialogHeader>
        <DialogTitle>{t('dialog.renameTitle')}</DialogTitle>
      </DialogHeader>
      <Field data-invalid={tooLong || failed !== null || undefined}>
        <FieldLabel htmlFor="artifact-title">{t('dialog.title')}</FieldLabel>
        <Input
          id="artifact-title"
          value={title}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          aria-invalid={tooLong || failed !== null || undefined}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => {
            setTitle(event.target.value)
            setFailed(null)
          }}
        />
        {tooLong && (
          <FieldError>{t('dialog.titleTooLong', { count: ARTIFACT_TITLE_CHARS })}</FieldError>
        )}
        {failed !== null && <FieldError>{failed}</FieldError>}
      </Field>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>
          {t('common:actions.cancel')}
        </DialogClose>
        <Button type="submit" disabled={!valid || busy}>
          {t('dialog.rename')}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** The checkbox that takes a published page down with its artifact; checked by default. */
function UnpublishToo({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  const { t } = useTranslation('artifacts')
  return (
    <label className="flex items-start gap-2.5 px-1 text-left text-ui">
      <Checkbox
        checked={checked}
        onCheckedChange={(value) => onChange(value === true)}
        className="mt-0.5"
      />
      <span className="text-secondary">{t('dialog.unpublishToo')}</span>
    </label>
  )
}

function DeleteDialog({
  dialog,
  onClose,
}: {
  dialog: Extract<ArtifactDialog, { kind: 'delete' }> | null
  onClose: () => void
}) {
  const { t } = useTranslation(['artifacts', 'common'])
  // Kept while the dialog closes, so its text does not empty during the exit.
  const [shown, setShown] = useState(dialog)
  const [unpublish, setUnpublish] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (dialog && dialog !== shown) {
    setShown(dialog)
    setUnpublish(true)
    setBusy(false)
    setError(null)
  }
  const remove = async (): Promise<void> => {
    if (!shown || busy) return
    setBusy(true)
    setError(null)
    try {
      if (unpublish) {
        const result = await unpublishArtifact(shown.id)
        if ('failed' in result) {
          setError(t(`share.failures.${result.failed}`, { count: CLOUDFLARE_FREE_WORKERS }))
          return
        }
      }
      await deleteArtifact(shown.id)
      shown.onDeleted?.()
      onClose()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <AlertDialog open={dialog !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('dialog.deleteTitle', { title: shown?.title ?? '' })}
          </AlertDialogTitle>
          <AlertDialogDescription>{t('dialog.deleteDescription')}</AlertDialogDescription>
        </AlertDialogHeader>
        {shown && <UnpublishToo checked={unpublish} onChange={setUnpublish} />}
        {error && <p className="text-xs text-danger">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void remove()}>
            {t('dialog.delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function EraseDialog({
  dialog,
  onClose,
}: {
  dialog: Extract<ArtifactDialog, { kind: 'erase' }> | null
  onClose: () => void
}) {
  const { t } = useTranslation(['artifacts', 'common'])
  // Kept while the dialog closes, so its text does not empty during the exit.
  const [shown, setShown] = useState(dialog)
  const [unpublish, setUnpublish] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (dialog && dialog !== shown) {
    setShown(dialog)
    setUnpublish(true)
    setBusy(false)
    setError(null)
  }
  const remove = async (): Promise<void> => {
    if (!shown || busy) return
    setBusy(true)
    setError(null)
    try {
      if (unpublish && shown.published) {
        const result = await unpublishArtifact(shown.id)
        if ('failed' in result) {
          setError(t(`share.failures.${result.failed}`, { count: CLOUDFLARE_FREE_WORKERS }))
          return
        }
      }
      await eraseArtifact(shown.id)
      onClose()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <AlertDialog open={dialog !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('dialog.eraseTitle', { title: shown?.title ?? '' })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('dialog.eraseDescription', { count: shown?.versions ?? 1 })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {shown?.published && <UnpublishToo checked={unpublish} onChange={setUnpublish} />}
        {error && <p className="text-xs text-danger">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void remove()}>
            {t('dialog.erase')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
