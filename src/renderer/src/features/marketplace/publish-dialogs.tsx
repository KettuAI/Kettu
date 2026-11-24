// Marketplace › Published's dialogs: a folder checked and confirmed as a session's card does, the
// publisher name, a listing's details, unlisting, deleting, withdrawing a version and its files.

import { useEffect, useId, useState, type FormEvent } from 'react'
import { Alert02Icon, RefreshIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { PublishPlan } from '@shared/agent-host'
import {
  HANDLE,
  LISTING_ABOUT_CHARS,
  LISTING_DESCRIPTION_CHARS,
  LISTING_NAME_CHARS,
  type ListingChange,
  type ListingVisibility,
  type MarketProblem,
  type MarketVersionFiles,
  type MineListing,
  type PublishVisibility,
} from '@shared/market-publish'
import { isAgentId } from '@shared/thread'
import { Icon } from '@renderer/components/affect/app-shell'
import { Dialog, DialogClose } from '@renderer/components/ui/dialog'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { toast } from '@renderer/components/ui/toast'
import { PublishForm } from '@renderer/features/session/entries/market-publish-entry'
import { Segmented, SetButton } from '@renderer/features/settings/controls'
import {
  DIALOG_FIELD,
  DIALOG_MONO_FIELD,
  SettingsDialogBody,
  SettingsDialogContent,
  SettingsDialogFooter,
  SettingsDialogHeader,
  SettingsField,
} from '@renderer/features/settings/settings-dialog'
import { bytes } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useHostScope } from '@renderer/stores/host-scope'
import { publishedStore } from '@renderer/stores/market-published'
import { ConfirmDialog } from './dialogs'
import { useAgentName } from './hooks'
import { homeShort } from './model'
import type { FolderChoice } from './published-hooks'

/** What a failed request's problems were, as the host passed them on. */
function problemsOf(error: unknown): MarketProblem[] {
  const data = (error as { data?: { problems?: unknown } } | null)?.data
  return Array.isArray(data?.problems) ? (data.problems as MarketProblem[]) : []
}

function useStore() {
  const { hostId, request } = useHostScope()
  return publishedStore(hostId, request)
}

function Problems({ problems }: { problems: MarketProblem[] }) {
  if (problems.length === 0) return null
  return (
    <ul className="k-pub-problems" data-selectable="">
      {problems.map((problem, i) => (
        <li key={i}>
          {problem.path && <span className="k-mkt-mono">{problem.path}</span>}
          <span>{problem.text ?? problem.message}</span>
        </li>
      ))}
    </ul>
  )
}

/** From a folder: Kettu checks it, then the user confirms what a session's card would show. */
export function PublishFolderDialog({
  choice,
  onClose,
}: {
  choice: FolderChoice | null
  onClose: () => void
}) {
  return (
    <Dialog open={choice !== null} onOpenChange={(open) => !open && onClose()}>
      <SettingsDialogContent className="k-pub-dialog">
        {choice && (
          <PublishFolderForm
            key={`${choice.path}|${choice.draftId ?? ''}`}
            choice={choice}
            onDone={onClose}
          />
        )}
      </SettingsDialogContent>
    </Dialog>
  )
}

function PublishFolderForm({ choice, onDone }: { choice: FolderChoice; onDone: () => void }) {
  const { t } = useTranslation(['marketplace', 'session', 'common'])
  const scope = useHostScope()
  const store = useStore()
  const agentName = useAgentName()
  const fieldId = useId()
  const [plan, setPlan] = useState<PublishPlan | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [checking, setChecking] = useState(true)
  const [visibility, setVisibility] = useState<PublishVisibility>('public')
  const [notes, setNotes] = useState('')
  const [handle, setHandle] = useState('')
  const [handleInvalid, setHandleInvalid] = useState(false)
  const [busy, setBusy] = useState(false)
  const [converting, setConverting] = useState(false)
  const [failure, setFailure] = useState<{ message: string; problems: MarketProblem[] } | null>(
    null,
  )
  // A harness plugin's conversion is a folder of its own, which the rest of the dialog follows.
  const [target, setTarget] = useState(choice.path)
  const draft = store.getState().published?.drafts.find((d) => d.id === choice.draftId) ?? null
  const folder = homeShort(target)

  // Each check answers only while it is the latest; Check again starts another.
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    scope
      .request('market.checkFolder', {
        path: target,
        ...(choice.draftId ? { draftId: choice.draftId } : {}),
      })
      .then(
        (next) => {
          if (!live) return
          setPlan(next)
          if (next.ask) {
            setVisibility(next.ask.visibility === 'private' ? 'private' : 'public')
            setNotes(next.ask.notes ?? '')
            setHandle((h) => h || next.ask?.publisher?.suggested || '')
          }
        },
        (error: unknown) => live && setCheckError(errorMessage(error)),
      )
      .finally(() => live && setChecking(false))
    return () => {
      live = false
    }
  }, [scope, choice.draftId, target, attempt])

  const checkAgain = () => {
    setChecking(true)
    setCheckError(null)
    setFailure(null)
    setAttempt((n) => n + 1)
  }

  const convert = async () => {
    setConverting(true)
    setFailure(null)
    try {
      const converted = await scope.request('market.convertFolder', { path: target })
      setPlan(null)
      setChecking(true)
      setTarget(converted.path)
    } catch (error) {
      setFailure({ message: errorMessage(error), problems: [] })
    } finally {
      setConverting(false)
    }
  }

  const ask = plan?.ask ?? null
  const fresh = ask !== null && ask.listingId === null
  const newVersion = ask !== null && ask.listingId !== null
  const ready = ask !== null && plan!.problems.length === 0 && !checking

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!ready || busy) return
    if (ask.publisher && !HANDLE.test(handle.trim())) {
      setHandleInvalid(true)
      setFailure({ message: t('session:marketPublish.handleInvalid'), problems: [] })
      return
    }
    setBusy(true)
    setFailure(null)
    try {
      const result = await scope.request('market.publishFolder', {
        path: target,
        ...(choice.draftId ? { draftId: choice.draftId } : {}),
        ...(fresh ? { visibility } : {}),
        ...(newVersion ? { notes } : {}),
        ...(ask.publisher ? { handle: handle.trim() } : {}),
      })
      if (result.held !== undefined) {
        toast(t('published.toast.held', { name: ask.item.name, version: result.held }))
      } else {
        toast(
          t('published.toast.published', { name: ask.item.name, version: ask.version }),
          undefined,
          {
            tone: 'success',
          },
        )
      }
      void store.getState().load()
      onDone()
    } catch (error) {
      setFailure({ message: errorMessage(error), problems: problemsOf(error) })
    } finally {
      setBusy(false)
    }
  }

  const title = newVersion
    ? t('session:marketPublish.title.version', { name: ask.item.name, version: ask.version })
    : t('session:marketPublish.title.new')
  const description =
    newVersion && ask.installs > 0
      ? t('session:marketPublish.description.version', {
          count: ask.installs,
          version: ask.version,
        })
      : t('session:marketPublish.description.new')

  return (
    <form onSubmit={(event) => void submit(event)}>
      <SettingsDialogHeader title={title}>{description}</SettingsDialogHeader>
      <SettingsDialogBody className="k-pub-body">
        {checking && !plan ? (
          <p className="k-pub-checking" role="status">
            <Spinner className="size-4" />
            {t('published.dialogs.folder.checking', { folder })}
          </p>
        ) : checkError ? (
          <p role="alert" className="k-mkt-error" data-selectable="">
            {checkError}
          </p>
        ) : ask === null && plan?.convertible ? (
          <div className="k-pub-nothing">
            <b>
              {t('published.dialogs.folder.convertTitle', {
                harness: t(`session:marketPublish.harness.${plan.convertible}`),
              })}
            </b>
            <span>{t('published.dialogs.folder.convertText')}</span>
            <span className="k-mkt-mono">{folder}</span>
            <SetButton
              size="md"
              variant="secondary"
              loading={converting}
              onClick={() => void convert()}
            >
              {t('published.dialogs.folder.convert')}
            </SetButton>
          </div>
        ) : ask === null ? (
          <div className="k-pub-nothing">
            <b>{t('published.dialogs.folder.nothing')}</b>
            <span>{t('published.dialogs.folder.nothingText')}</span>
            <span className="k-mkt-mono">{folder}</span>
            <Problems problems={plan?.problems ?? []} />
          </div>
        ) : (
          <PublishForm
            ask={ask}
            fieldId={fieldId}
            agentName={draft?.agentId && isAgentId(draft.agentId) ? agentName(draft.agentId) : null}
            visibility={visibility}
            onVisibility={setVisibility}
            notes={notes}
            onNotes={setNotes}
            handle={handle}
            onHandle={(next) => {
              setHandle(next)
              setHandleInvalid(false)
            }}
            handleInvalid={handleInvalid}
          />
        )}
        {ask && plan!.problems.length > 0 && (
          <div className="k-pub-alert" role="alert">
            <Icon icon={Alert02Icon} size={15} />
            <span>
              <b>{t('published.dialogs.folder.problems')}</b>
              <Problems problems={plan!.problems} />
            </span>
          </div>
        )}
        {failure && (
          <div className="k-pub-alert" role="alert">
            <Icon icon={Alert02Icon} size={15} />
            <span>
              <b>{t('published.dialogs.folder.failed', { error: failure.message })}</b>
              <Problems problems={failure.problems} />
            </span>
          </div>
        )}
      </SettingsDialogBody>
      <SettingsDialogFooter
        start={
          plan && (plan.problems.length > 0 || checkError) ? (
            <SetButton
              size="md"
              variant="ghost"
              loading={checking}
              icon={<Icon icon={RefreshIcon} size={14} />}
              onClick={checkAgain}
            >
              {t('published.dialogs.folder.checkAgain')}
            </SetButton>
          ) : null
        }
      >
        <DialogClose render={<SetButton size="md" variant="ghost" />}>
          {t('common:actions.cancel')}
        </DialogClose>
        <SetButton size="md" variant="primary" type="submit" loading={busy} disabled={!ready}>
          {newVersion && ask.version
            ? t('session:marketPublish.publishVersion', { version: ask.version })
            : t('session:marketPublish.publish')}
        </SetButton>
      </SettingsDialogFooter>
    </form>
  )
}

/** A dialog of a listing, or of the publisher, that a page or a row opened. */
export type ListingDialog =
  | { kind: 'profile'; handle: string }
  | { kind: 'details'; listing: MineListing }
  | { kind: 'unlist'; listing: MineListing }
  | { kind: 'delete'; listing: MineListing; onDeleted?: () => void }
  | { kind: 'withdraw'; listing: MineListing; version: string }
  | { kind: 'files'; listing: MineListing; version: string }

export function ListingDialogs({
  dialog,
  onClose,
}: {
  dialog: ListingDialog | null
  onClose: () => void
}) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const store = useStore()
  const close = (open: boolean) => {
    if (!open) onClose()
  }
  const reload = () => void store.getState().load()
  const listing = dialog && 'listing' in dialog ? dialog.listing : null
  return (
    <>
      <Dialog open={dialog?.kind === 'profile'} onOpenChange={close}>
        <SettingsDialogContent>
          {dialog?.kind === 'profile' && <ProfileForm handle={dialog.handle} onDone={onClose} />}
        </SettingsDialogContent>
      </Dialog>
      <Dialog open={dialog?.kind === 'details'} onOpenChange={close}>
        <SettingsDialogContent>
          {dialog?.kind === 'details' && <DetailsForm listing={dialog.listing} onDone={onClose} />}
        </SettingsDialogContent>
      </Dialog>
      <Dialog open={dialog?.kind === 'files'} onOpenChange={close}>
        <SettingsDialogContent>
          {dialog?.kind === 'files' && (
            <FilesView listing={dialog.listing} version={dialog.version} />
          )}
        </SettingsDialogContent>
      </Dialog>
      <ConfirmDialog
        open={dialog?.kind === 'unlist'}
        onOpenChange={close}
        title={t('published.dialogs.unlist.title', { name: listing?.name ?? '' })}
        body={t('published.dialogs.unlist.body', { count: listing?.installs.total ?? 0 })}
        confirm={t('published.dialogs.unlist.confirm')}
        action={async () => {
          if (!listing) return
          await scope.request('market.updateListing', {
            id: listing.id,
            change: { visibility: 'unlisted' },
          })
          toast(t('published.toast.unlisted', { name: listing.name }), undefined, {
            tone: 'success',
          })
          reload()
        }}
      />
      <ConfirmDialog
        open={dialog?.kind === 'delete'}
        onOpenChange={close}
        title={t('published.dialogs.delete.title', { name: listing?.name ?? '' })}
        body={t('published.dialogs.delete.body')}
        confirm={t('published.dialogs.delete.confirm')}
        action={async () => {
          if (dialog?.kind !== 'delete') return
          await scope.request('market.deleteListing', { id: dialog.listing.id })
          toast(t('published.toast.deleted', { name: dialog.listing.name }), undefined, {
            tone: 'success',
          })
          dialog.onDeleted?.()
          reload()
        }}
      />
      <ConfirmDialog
        open={dialog?.kind === 'withdraw'}
        onOpenChange={close}
        title={t('published.dialogs.withdraw.title', {
          version: dialog?.kind === 'withdraw' ? dialog.version : '',
        })}
        body={t('published.dialogs.withdraw.body', { current: listing?.current ?? '' })}
        confirm={t('published.dialogs.withdraw.confirm')}
        action={async () => {
          if (dialog?.kind !== 'withdraw') return
          await scope.request('market.withdrawVersion', {
            id: dialog.listing.id,
            version: dialog.version,
          })
          toast(
            t('published.toast.withdrawn', { name: dialog.listing.name, version: dialog.version }),
            undefined,
            { tone: 'success' },
          )
          reload()
        }}
      />
    </>
  )
}

/** The publisher name, which every listing of the account shows. */
function ProfileForm({ handle: was, onDone }: { handle: string; onDone: () => void }) {
  const { t } = useTranslation(['marketplace', 'session', 'common'])
  const scope = useHostScope()
  const store = useStore()
  const id = useId()
  const [handle, setHandle] = useState(was)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const valid = HANDLE.test(handle.trim())
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!valid) return setError(t('session:marketPublish.handleInvalid'))
    if (handle.trim() === was) return onDone()
    setBusy(true)
    setError(null)
    try {
      const publisher = await scope.request('market.setPublisher', { handle: handle.trim() })
      toast(t('published.toast.profile', { handle: publisher.handle }), undefined, {
        tone: 'success',
      })
      void store.getState().load()
      onDone()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={(event) => void submit(event)}>
      <SettingsDialogHeader title={t('published.dialogs.profile.title')}>
        {t('published.dialogs.profile.description')}
      </SettingsDialogHeader>
      <SettingsDialogBody>
        <SettingsField
          label={t('published.dialogs.profile.name')}
          htmlFor={`${id}-handle`}
          hint={error ?? t('session:marketPublish.handleInvalid')}
        >
          <span className="k-pub-handle-field">
            <span aria-hidden>@</span>
            <input
              id={`${id}-handle`}
              className={DIALOG_MONO_FIELD}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              maxLength={32}
              aria-invalid={error ? true : undefined}
              value={handle}
              onChange={(event) => {
                setHandle(event.target.value.toLowerCase())
                setError(null)
              }}
            />
          </span>
        </SettingsField>
      </SettingsDialogBody>
      <SettingsDialogFooter>
        <DialogClose render={<SetButton size="md" variant="ghost" />}>
          {t('common:actions.cancel')}
        </DialogClose>
        <SetButton size="md" variant="primary" type="submit" loading={busy} disabled={!valid}>
          {t('published.dialogs.profile.save')}
        </SetButton>
      </SettingsDialogFooter>
    </form>
  )
}

const oneLine = (text: string, max: number) =>
  text.trim() !== '' && text.length <= max && !/[\r\n]/.test(text)

/** A listing's name, one line, about and who can see it; its files change only with a version. */
function DetailsForm({ listing, onDone }: { listing: MineListing; onDone: () => void }) {
  const { t } = useTranslation(['marketplace', 'common'])
  const scope = useHostScope()
  const store = useStore()
  const id = useId()
  const [name, setName] = useState(listing.name)
  const [line, setLine] = useState(listing.description)
  const [about, setAbout] = useState(listing.about ?? '')
  const [visibility, setVisibility] = useState<ListingVisibility>(listing.visibility)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameOk = oneLine(name, LISTING_NAME_CHARS)
  const lineOk = oneLine(line, LISTING_DESCRIPTION_CHARS)
  const change: ListingChange = {
    ...(name.trim() !== listing.name ? { name: name.trim() } : {}),
    ...(line.trim() !== listing.description ? { description: line.trim() } : {}),
    ...(about !== (listing.about ?? '') ? { about } : {}),
    ...(visibility !== listing.visibility ? { visibility } : {}),
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!nameOk || !lineOk) return
    if (Object.keys(change).length === 0) return onDone()
    setBusy(true)
    setError(null)
    try {
      const saved = await scope.request('market.updateListing', { id: listing.id, change })
      toast(t('published.toast.saved', { name: saved.name }), undefined, { tone: 'success' })
      void store.getState().load()
      onDone()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const options: { value: ListingVisibility; label: string }[] = [
    { value: 'public', label: t('published.visibility.public') },
    { value: 'private', label: t('published.visibility.private') },
    ...(listing.visibility === 'unlisted'
      ? [{ value: 'unlisted' as const, label: t('published.visibility.unlisted') }]
      : []),
  ]
  return (
    <form onSubmit={(event) => void submit(event)}>
      <SettingsDialogHeader title={t('published.dialogs.details.title', { name: listing.name })}>
        {t('published.dialogs.details.description')}
      </SettingsDialogHeader>
      <SettingsDialogBody>
        <SettingsField
          label={t('published.dialogs.details.name')}
          htmlFor={`${id}-name`}
          hint={
            nameOk
              ? undefined
              : t('published.dialogs.details.lineInvalid', { count: LISTING_NAME_CHARS })
          }
        >
          <input
            id={`${id}-name`}
            className={DIALOG_FIELD}
            autoComplete="off"
            maxLength={LISTING_NAME_CHARS}
            aria-invalid={nameOk ? undefined : true}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </SettingsField>
        <SettingsField
          label={t('published.dialogs.details.line')}
          htmlFor={`${id}-line`}
          hint={
            lineOk
              ? undefined
              : t('published.dialogs.details.lineInvalid', { count: LISTING_DESCRIPTION_CHARS })
          }
        >
          <input
            id={`${id}-line`}
            className={DIALOG_FIELD}
            autoComplete="off"
            maxLength={LISTING_DESCRIPTION_CHARS}
            aria-invalid={lineOk ? undefined : true}
            value={line}
            onChange={(event) => setLine(event.target.value)}
          />
        </SettingsField>
        <SettingsField
          label={t('published.dialogs.details.about')}
          htmlFor={`${id}-about`}
          hint={t('published.dialogs.details.aboutHint')}
        >
          <textarea
            id={`${id}-about`}
            className={DIALOG_FIELD}
            rows={4}
            maxLength={LISTING_ABOUT_CHARS}
            value={about}
            onChange={(event) => setAbout(event.target.value)}
          />
        </SettingsField>
        <div className="kettu-sd__field">
          <span className="k-mkt-values__label">{t('published.dialogs.details.visibleTo')}</span>
          <Segmented
            label={t('published.dialogs.details.visibleTo')}
            value={visibility}
            options={options}
            onChange={setVisibility}
          />
          <span className="kettu-sd__hint">
            {t(`published.dialogs.details.hint.${visibility}`)}
          </span>
        </div>
        {error && (
          <p role="alert" className="k-mkt-error" data-selectable="">
            {error}
          </p>
        )}
      </SettingsDialogBody>
      <SettingsDialogFooter>
        <DialogClose render={<SetButton size="md" variant="ghost" />}>
          {t('common:actions.cancel')}
        </DialogClose>
        <SetButton
          size="md"
          variant="primary"
          type="submit"
          loading={busy}
          disabled={!nameOk || !lineOk}
        >
          {t('published.dialogs.details.save')}
        </SetButton>
      </SettingsDialogFooter>
    </form>
  )
}

/** The files a version uploaded, or the server it points to. */
function FilesView({ listing, version }: { listing: MineListing; version: string }) {
  const { t } = useTranslation(['marketplace', 'common'])
  const scope = useHostScope()
  const [files, setFiles] = useState<MarketVersionFiles | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    scope.request('market.versionFiles', { id: listing.id, version }).then(
      (next) => live && setFiles(next),
      (e: unknown) => live && setError(errorMessage(e)),
    )
    return () => {
      live = false
    }
  }, [scope, listing.id, version])
  return (
    <>
      <SettingsDialogHeader
        title={t('published.dialogs.files.title', { name: listing.name, version })}
      >
        {t('published.dialogs.files.description')}
      </SettingsDialogHeader>
      <SettingsDialogBody>
        {error ? (
          <p role="alert" className="k-mkt-error" data-selectable="">
            {error}
          </p>
        ) : !files ? (
          <Skeleton className="k-pub-skeleton__files" />
        ) : (
          <>
            {files.files.length === 0 ? (
              <p className="k-mkt-section-note">{t('published.dialogs.files.none')}</p>
            ) : (
              <ul className="k-pub-files" data-selectable="">
                {files.files.map((file) => (
                  <li key={file.path}>
                    <span className="k-mkt-mono">{file.path}</span>
                    <span className="k-pub-faint">{bytes(file.size)}</span>
                  </li>
                ))}
              </ul>
            )}
            {files.server && (
              <pre className="k-pub-server" data-selectable="">
                {JSON.stringify(files.server, null, 2)}
              </pre>
            )}
          </>
        )}
      </SettingsDialogBody>
      <SettingsDialogFooter>
        <DialogClose render={<SetButton size="md" variant="secondary" />}>
          {t('common:actions.close')}
        </DialogClose>
      </SettingsDialogFooter>
    </>
  )
}
