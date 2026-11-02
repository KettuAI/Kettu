// The folder and program picker for a host reached over the channel: a path on the host typed with
// completion from `paths.complete`, in place of the system dialog, which shows this device's files.

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Autocomplete } from '@base-ui/react/autocomplete'
import { ChevronRightIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PathCompletion } from '@shared/remote/host-admin'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@renderer/components/ui/field'
import { Input } from '@renderer/components/ui/input'
import { Spinner } from '@renderer/components/ui/spinner'
import { FileTypeIcon } from '@renderer/features/files/file-type-icon'
import { errorMessage, hostAt } from '@renderer/lib/host'
import { hostPlatform } from '@renderer/lib/platform'
import { useWebHostStore } from '@renderer/stores/web-host'
import {
  canChoose,
  chosenPath,
  isCompletable,
  lastPart,
  pathEntries,
  restarted,
  tabComplete,
  type PathEntry,
} from './host-path'
import { answerHostPath, PATH_KINDS, usePathRequest, type AskedPath } from './host-path-request'

/** How long typing pauses before the host is asked. */
const TYPING_MS = 120

export default function HostPathDialog() {
  const asked = usePathRequest((s) => s.asked)
  // The last request stays shown while the dialog closes.
  const [shown, setShown] = useState(asked)
  if (asked && asked !== shown) setShown(asked)
  return (
    <Dialog open={asked !== null} onOpenChange={(open) => !open && answerHostPath(null)}>
      <DialogContent className="sm:max-w-lg">
        {shown && <PathForm key={shown.id} asked={shown} />}
      </DialogContent>
    </Dialog>
  )
}

type Answer = { typed: string; completion: PathCompletion } | { typed: string; error: string }

function PathForm({ asked }: { asked: AskedPath }) {
  const { t } = useTranslation(['web', 'common'])
  const id = useId()
  const webHostName = useWebHostStore((s) => s.host?.name) ?? ''
  const platform = asked.on?.platform ?? hostPlatform()
  const hostName = asked.on?.name ?? webHostName
  const hostId = asked.on?.hostId ?? null
  const kind = PATH_KINDS[asked.purpose]
  const [text, setText] = useState(asked.initial)
  const [answered, setAnswered] = useState<Answer | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // A ref: Base UI reports the highlight on each render with new entries, so state would loop.
  const highlighted = useRef<PathEntry | null>(null)
  const placed = useRef(false)
  const completable = isCompletable(text, platform)

  useEffect(() => {
    if (!completable) return
    let live = true
    const timer = setTimeout(() => {
      hostAt(hostId, 'paths.complete', { path: text }).then(
        (completion) => live && setAnswered({ typed: text, completion }),
        (error: unknown) => live && setAnswered({ typed: text, error: errorMessage(error) }),
      )
    }, TYPING_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [text, completable, hostId])

  const current = completable && answered?.typed === text ? answered : null
  const completion = current && 'completion' in current ? current.completion : null
  // The last answer's entries stay listed while the next is asked for, so typing does not flash.
  const listed = completable && answered && 'completion' in answered ? answered.completion : null
  const entries = listed ? pathEntries(text, listed, kind, platform) : []
  const choosable = completion !== null && canChoose(kind, completion.exact)
  const last = lastPart(text, platform)
  const exact = completion?.exact ?? null
  const problem =
    failed ??
    (current && 'error' in current
      ? current.error
      : exact && !choosable
        ? kind === 'folder'
          ? t('path.notFolder')
          : exact.kind === 'folder'
            ? t('path.folderNotProgram')
            : t('path.notRunnable', { host: hostName })
        : null)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!completion || !choosable || busy) return
    const path = chosenPath(text, completion, platform)
    if (!asked.commit) return answerHostPath(path)
    setBusy(true)
    setFailed(null)
    try {
      await asked.commit(path)
      answerHostPath(path)
    } catch (error) {
      setFailed(errorMessage(error))
      setBusy(false)
    }
  }

  // Base UI fills the field from a pressed item only in a popup, and this list is inline.
  const pick = (entry: PathEntry): void => {
    setText(entry.path)
    setFailed(null)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter' && highlighted.current) {
      event.preventDefault()
      return pick(highlighted.current)
    }
    if (event.key !== 'Tab' || event.shiftKey || !completion) return
    const next = tabComplete(
      text,
      pathEntries(text, completion, kind, platform),
      completion,
      platform,
    )
    if (next === null) return
    event.preventDefault()
    setText(next)
  }

  return (
    <form className="contents" onSubmit={(event) => void submit(event)}>
      <DialogHeader>
        <DialogTitle>{t(`path.${asked.purpose}.title`)}</DialogTitle>
        <DialogDescription>
          {t(`path.${asked.purpose}.description`, { host: hostName })}
        </DialogDescription>
      </DialogHeader>
      <Autocomplete.Root
        inline
        open
        items={entries}
        filter={null}
        value={text}
        onItemHighlighted={(entry: PathEntry | undefined) => {
          highlighted.current = entry ?? null
        }}
        onValueChange={(next) => {
          setText(restarted(next, platform))
          setFailed(null)
        }}
        itemToStringValue={(entry: PathEntry) => entry.path}
      >
        <div className="flex min-w-0 flex-col gap-3">
          <Field data-invalid={problem !== null || undefined}>
            <FieldLabel htmlFor={id}>{t('path.label', { host: hostName })}</FieldLabel>
            <Autocomplete.Input
              id={id}
              render={<Input />}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={platform === 'win32' ? 'C:\\…' : '/…'}
              aria-invalid={problem !== null || undefined}
              className="font-mono text-code md:text-code"
              onKeyDown={onKeyDown}
              onFocus={(event) => {
                // The caret starts after the text, where typing goes on.
                if (placed.current) return
                placed.current = true
                const end = event.currentTarget.value.length
                event.currentTarget.setSelectionRange(end, end)
              }}
            />
            {problem !== null ? (
              <FieldError>{problem}</FieldError>
            ) : (
              <FieldDescription className="text-xs">
                {completable ? t('path.keys') : t('path.start')}
              </FieldDescription>
            )}
          </Field>
          <div className="h-56 overflow-y-auto overscroll-contain rounded-lg p-1 shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)]">
            <Autocomplete.List aria-label={t('path.list')}>
              {(entry: PathEntry) => (
                <Autocomplete.Item
                  key={entry.path}
                  value={entry}
                  onClick={() => pick(entry)}
                  className="flex min-h-row cursor-default items-center gap-2 rounded-md px-2 py-1 text-ui outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                >
                  <FileTypeIcon
                    path={entry.name}
                    folder={entry.kind === 'folder'}
                    className="size-4"
                  />
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  {entry.kind === 'folder' && <ChevronRightIcon className="size-3.5 text-icon" />}
                </Autocomplete.Item>
              )}
            </Autocomplete.List>
            {entries.length === 0 && completable && (
              <Autocomplete.Status className="flex h-full items-center justify-center px-4 text-center text-small text-tertiary">
                {!current ? (
                  <Spinner className="size-4 text-icon" />
                ) : !completion ? null : last !== '' ? (
                  t('path.noMatch', { name: last })
                ) : exact ? (
                  t('path.empty')
                ) : (
                  t('path.missing', { host: hostName })
                )}
              </Autocomplete.Status>
            )}
          </div>
        </div>
      </Autocomplete.Root>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>
          {t('common:actions.cancel')}
        </DialogClose>
        <Button type="submit" disabled={!choosable || busy}>
          {busy && <Spinner data-icon="inline-start" />}
          {asked.purpose === 'project' ? t('path.open') : t('path.choose')}
        </Button>
      </DialogFooter>
    </form>
  )
}
