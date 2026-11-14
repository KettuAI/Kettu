import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { Edit02Icon, RefreshIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import {
  MEMORY_BODY_CHARS,
  MEMORY_DESCRIPTION_CHARS,
  MEMORY_TITLE_CHARS,
  type MemoryEntry,
  type MemoryScope,
} from '@shared/memory'
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
import { Dialog, DialogClose } from '@renderer/components/ui/dialog'
import { toast } from '@renderer/components/ui/toast'
import { MEMORY_GLYPH } from '@renderer/features/session/entries/tool-call-model'
import { fullTime, mediumAgo } from '@renderer/lib/format'
import { memoryErrorText } from '@renderer/lib/memory-errors'
import { useNow } from '@renderer/lib/use-now'
import { useHostScope } from '@renderer/stores/host-scope'
import { chooseMemoryProject } from '@renderer/stores/memory'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { openSession, openSettingsItem } from '@renderer/stores/view'
import { Fact } from './agent-parts'
import { CONFIRM, ControlError, DangerButton, SetButton, Skel } from './controls'
import { useMemoryEntries, useProjectName, writerName } from './memory-data'
import { memoryItemKey, parseMemoryItem } from './memory-items'
import { GroupLabel, ItemPageHeader, Notice, RowFrame, RowGroup, RowText } from './rows'
import {
  DIALOG_FIELD,
  SettingsDialogBody,
  SettingsDialogContent,
  SettingsDialogFooter,
  SettingsDialogHeader,
  SettingsField,
} from './settings-dialog'

const back = () => openSettingsItem('memory', null)

/** A memory entry's page: its text, who wrote it and in which session, and what to do with it. */
export function MemoryEntryPage({ item }: { item: string }) {
  const { t } = useTranslation('settings')
  const { hostId } = useHostScope()
  const parsed = useMemo(() => parseMemoryItem(item), [item])
  const read = useMemoryEntries(parsed?.scope ?? null)
  const project = parsed?.scope.layer === 'project' ? parsed.scope.project : null
  // Back on the list, the project of the entry shown is the one listed.
  useEffect(() => {
    if (project !== null) chooseMemoryProject(hostId, project)
  }, [hostId, project])
  const entry = read.value?.find((one) => one.id === parsed?.id) ?? null
  if (parsed && entry) return <EntryPage item={item} scope={parsed.scope} entry={entry} />
  const header = (title: ReactNode) => (
    <ItemPageHeader
      back={t('sections.memory')}
      onBack={back}
      item={item}
      icon={<Icon icon={MEMORY_GLYPH} size={24} />}
      title={title}
    />
  )
  if (parsed && read.value === null && read.error === null) {
    return (
      <>
        {header(<Skel width={180} className="mt-1.5" />)}
        <div className="ui-sg-card k-pending" aria-busy="true">
          <div className="ui-sg-row">
            <span className="ui-sg-label k-lines">
              <Skel width="70%" />
              <Skel width="45%" />
            </span>
          </div>
        </div>
      </>
    )
  }
  if (parsed && read.value === null) {
    return (
      <>
        {header(null)}
        <ReadFailed error={read.error ?? ''} onRetry={read.retry} />
      </>
    )
  }
  return (
    <>
      {header(null)}
      <p className="ui-sg-hint">{t('memory.entry.gone')}</p>
    </>
  )
}

/** In place of what could not be read: why, and Try again. */
export function ReadFailed({ error, onRetry }: { error: string; onRetry: () => void }) {
  const { t } = useTranslation('settings')
  return (
    <Notice
      variant="error"
      className="k-pending"
      title={t('memory.loadFailed', { error })}
      action={
        <SetButton icon={<Icon icon={RefreshIcon} size={14} />} onClick={onRetry}>
          {t('memory.retry')}
        </SetButton>
      }
    />
  )
}

function EntryPage({
  item,
  scope,
  entry,
}: {
  item: string
  scope: MemoryScope
  entry: MemoryEntry
}) {
  const { t } = useTranslation('settings')
  const { hostId } = useHostScope()
  const now = useNow()
  const [editing, setEditing] = useState(false)
  const projectName = useProjectName(hostId, scope.layer === 'project' ? scope.project : null)
  const who = writerName(entry, hostId) ?? t('memory.you')
  const layer =
    scope.layer === 'global'
      ? t('memory.entry.global')
      : t('memory.entry.project', { project: projectName })
  return (
    <>
      <ItemPageHeader
        back={t('sections.memory')}
        onBack={back}
        item={item}
        icon={<Icon icon={MEMORY_GLYPH} size={24} />}
        title={entry.title}
        subtitle={entry.description || undefined}
        actions={
          <SetButton icon={<Icon icon={Edit02Icon} size={14} />} onClick={() => setEditing(true)}>
            {t('memory.entry.edit')}
          </SetButton>
        }
      >
        <span className="k-name">
          {layer} · {t('memory.line', { who, when: mediumAgo(entry.updatedAt, now) })}
        </span>
      </ItemPageHeader>

      <div className="k-groups">
        <section aria-label={t('memory.entry.body')} className="k-group">
          <GroupLabel group={{ id: 'body', label: t('memory.entry.body') }} />
          <RowGroup>
            <div className="ui-sg-row">
              <p className="k-memory-text" data-empty={!entry.body || undefined} data-selectable="">
                {entry.body || t('memory.entry.noBody')}
              </p>
            </div>
          </RowGroup>
        </section>
        <section aria-label={t('memory.entry.details')} className="k-group">
          <GroupLabel group={{ id: 'details', label: t('memory.entry.details') }} />
          <RowGroup>
            <Fact name={t('memory.entry.writtenBy')}>{who}</Fact>
            {entry.source.sessionId !== null && <SessionRow sessionId={entry.source.sessionId} />}
            <Fact name={t('memory.entry.created')}>{fullTime(entry.createdAt)}</Fact>
            <Fact name={t('memory.entry.updated')}>{fullTime(entry.updatedAt)}</Fact>
          </RowGroup>
        </section>
        <section aria-label={t('memory.entry.remove.name')} className="k-group">
          <RowGroup>
            {scope.layer === 'project' && <MoveToGlobal project={scope.project} entry={entry} />}
            <RemoveEntry scope={scope} entry={entry} />
          </RowGroup>
        </section>
      </div>
      <MemoryEditor
        open={editing}
        onOpenChange={setEditing}
        scope={scope}
        entry={entry}
        projectName={projectName}
      />
    </>
  )
}

/** The session that wrote the entry, and the way back to it while the window knows it. */
function SessionRow({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('settings')
  const summary = useSessionsStore((s) => s.byId[sessionId])
  return (
    <RowFrame
      text={
        <RowText
          name={t('memory.entry.session')}
          description={summary ? sessionTitle(summary) : t('memory.entry.sessionGone')}
        />
      }
    >
      {summary && (
        <SetButton onClick={() => openSession(summary.id, summary.projectPath)}>
          {t('memory.entry.openSession')}
        </SetButton>
      )}
    </RowFrame>
  )
}

/** Moves a project's entry to global memory and shows it there; asking is the user's consent. */
function MoveToGlobal({ project, entry }: { project: string; entry: MemoryEntry }) {
  const { t } = useTranslation('settings')
  const { request } = useHostScope()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const move = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const moved = await request('memory.moveToGlobal', { project, id: entry.id })
      toast(t('memory.entry.move.done'), undefined, { tone: 'success' })
      openSettingsItem('memory', memoryItemKey({ layer: 'global' }, moved.id))
    } catch (failure) {
      setError(memoryErrorText(failure))
      setBusy(false)
    }
  }
  return (
    <RowFrame
      text={
        <RowText
          name={t('memory.entry.move.name')}
          description={t('memory.entry.move.description')}
        />
      }
    >
      <ControlError error={error} />
      <SetButton loading={busy} onClick={() => void move()}>
        {t('memory.entry.move.button')}
      </SetButton>
    </RowFrame>
  )
}

function RemoveEntry({ scope, entry }: { scope: MemoryScope; entry: MemoryEntry }) {
  const { t } = useTranslation(['settings', 'common'])
  const { request } = useHostScope()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remove = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await request('memory.remove', { scope, id: entry.id })
      setOpen(false)
      toast(t('memory.entry.remove.done'))
      back()
    } catch (failure) {
      setError(memoryErrorText(failure))
      setBusy(false)
    }
  }
  return (
    <RowFrame
      text={
        <RowText
          name={t('memory.entry.remove.name')}
          description={t('memory.entry.remove.description')}
        />
      }
    >
      <DangerButton
        onClick={() => {
          setError(null)
          setOpen(true)
        }}
      >
        {t('memory.entry.remove.button')}
      </DangerButton>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent className={CONFIRM}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('memory.entry.remove.title', { title: entry.title })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('memory.entry.remove.body')}</AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p className="text-xs text-danger">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void remove()}>
              {t('memory.entry.remove.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </RowFrame>
  )
}

/** Adds an entry to a layer, or with `entry` changes that one: its title, summary and text. */
export function MemoryEditor({
  open,
  onOpenChange,
  scope,
  entry,
  projectName,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  scope: MemoryScope
  entry: MemoryEntry | null
  projectName: string
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SettingsDialogContent className="sm:max-w-140">
        <EditorBody
          scope={scope}
          entry={entry}
          projectName={projectName}
          onDone={() => onOpenChange(false)}
        />
      </SettingsDialogContent>
    </Dialog>
  )
}

/** The editor's fields, mounted with each opening so they start from the entry as it is. */
function EditorBody({
  scope,
  entry,
  projectName,
  onDone,
}: {
  scope: MemoryScope
  entry: MemoryEntry | null
  projectName: string
  onDone: () => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const { request } = useHostScope()
  const id = useId()
  const [title, setTitle] = useState(entry?.title ?? '')
  const [description, setDescription] = useState(entry?.description ?? '')
  const [body, setBody] = useState(entry?.body ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const changed =
    entry === null ||
    title !== entry.title ||
    description !== entry.description ||
    body !== entry.body
  const ready = title.trim() !== '' && changed
  const save = async (): Promise<void> => {
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      await request('memory.save', {
        scope,
        id: entry?.id ?? null,
        draft: { title, description, body },
      })
      onDone()
    } catch (failure) {
      setError(memoryErrorText(failure))
      setBusy(false)
    }
  }
  const heading = entry
    ? t('memory.editor.edit')
    : scope.layer === 'global'
      ? t('memory.editor.addGlobal')
      : t('memory.editor.addProject', { project: projectName })
  return (
    <>
      <SettingsDialogHeader title={heading}>
        {entry ? undefined : t('memory.editor.addBody')}
      </SettingsDialogHeader>
      <SettingsDialogBody>
        <SettingsField label={t('memory.editor.title')} htmlFor={`${id}-title`}>
          <input
            id={`${id}-title`}
            value={title}
            autoFocus
            autoComplete="off"
            maxLength={MEMORY_TITLE_CHARS}
            placeholder={t('memory.editor.titlePlaceholder')}
            className={DIALOG_FIELD}
            onChange={(event) => setTitle(event.target.value)}
          />
        </SettingsField>
        <SettingsField
          label={t('memory.editor.description')}
          htmlFor={`${id}-description`}
          hint={t('memory.editor.descriptionHint')}
        >
          <input
            id={`${id}-description`}
            value={description}
            autoComplete="off"
            maxLength={MEMORY_DESCRIPTION_CHARS}
            className={DIALOG_FIELD}
            onChange={(event) => setDescription(event.target.value)}
          />
        </SettingsField>
        <SettingsField
          label={t('memory.editor.body')}
          htmlFor={`${id}-body`}
          hint={t('memory.editor.bodyHint')}
        >
          <textarea
            id={`${id}-body`}
            value={body}
            rows={8}
            maxLength={MEMORY_BODY_CHARS}
            className={DIALOG_FIELD}
            onChange={(event) => setBody(event.target.value)}
          />
        </SettingsField>
        <ControlError error={error} wrap />
      </SettingsDialogBody>
      <SettingsDialogFooter>
        <DialogClose render={<SetButton size="md" variant="ghost" />}>
          {t('common:actions.cancel')}
        </DialogClose>
        <SetButton
          size="md"
          variant="primary"
          loading={busy}
          disabled={!ready}
          onClick={() => void save()}
        >
          {entry ? t('memory.editor.save') : t('memory.editor.add')}
        </SetButton>
      </SettingsDialogFooter>
    </>
  )
}
