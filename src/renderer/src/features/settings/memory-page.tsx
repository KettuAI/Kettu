import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ArrowLeft01Icon,
  ArrowUpRight01Icon,
  Delete02Icon,
  Edit02Icon,
  Folder01Icon,
  Globe02Icon,
  MoreHorizontalIcon,
  RefreshIcon,
  UserIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import {
  MEMORY_BODY_CHARS,
  MEMORY_DESCRIPTION_CHARS,
  MEMORY_TITLE_CHARS,
  type MemoryEntry,
  type MemoryScope,
} from '@shared/memory'
import { Dropdown, Icon, type MenuItem } from '@renderer/components/affect/app-shell'
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
import { toast } from '@renderer/components/ui/toast'
import { Markdown } from '@renderer/features/session/markdown'
import { fullTime, mediumAgo } from '@renderer/lib/format'
import { memoryErrorText } from '@renderer/lib/memory-errors'
import { modLabel } from '@renderer/lib/platform'
import { useNow } from '@renderer/lib/use-now'
import { useHostScope } from '@renderer/stores/host-scope'
import { chooseMemoryProject } from '@renderer/stores/memory'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { openSession, openSettingsItem } from '@renderer/stores/view'
import { CONFIRM, ControlError, SetButton, Skel } from './controls'
import { useMemoryEntries, useProjectName, writerName } from './memory-data'
import { memoryItemKey, NEW_MEMORY, parseMemoryItem } from './memory-items'
import { Notice } from './rows'

const back = () => openSettingsItem('memory', null)

/**
 * A memory entry's page, read as a short document: its layer, title, summary, who wrote it and
 * its text; or, for `NEW_MEMORY`, an empty one being written.
 */
export function MemoryEntryPage({ item }: { item: string }) {
  const { t } = useTranslation('settings')
  const { hostId } = useHostScope()
  const parsed = useMemo(() => parseMemoryItem(item), [item])
  const adding = parsed?.id === NEW_MEMORY
  const read = useMemoryEntries(parsed && !adding ? parsed.scope : null)
  const project = parsed?.scope.layer === 'project' ? parsed.scope.project : null
  // Back on the list, the project of the entry shown is the one listed.
  useEffect(() => {
    if (project !== null) chooseMemoryProject(hostId, project)
  }, [hostId, project])
  if (parsed && adding) {
    return (
      <Page item={item} scope={parsed.scope}>
        <Editor scope={parsed.scope} entry={null} onDone={back} />
      </Page>
    )
  }
  const entry = read.value?.find((one) => one.id === parsed?.id) ?? null
  if (parsed && entry) return <EntryPage item={item} scope={parsed.scope} entry={entry} />
  if (parsed && read.value === null && read.error === null) {
    return (
      <Page item={item} scope={parsed.scope}>
        <div className="k-mem__pending" aria-busy="true">
          <Skel width={320} className="k-mem__skel-title" />
          <Skel width="60%" />
          <div className="k-mem__body">
            <Skel width="90%" />
            <Skel width="75%" />
          </div>
        </div>
      </Page>
    )
  }
  return (
    <Page item={item} scope={parsed?.scope ?? null}>
      {parsed && read.value === null ? (
        <ReadFailed error={read.error ?? ''} onRetry={read.retry} />
      ) : (
        <p className="ui-sg-hint">{t('memory.entry.gone')}</p>
      )}
    </Page>
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

/** The way back, then the page with its layer's tag and what sits at its top right. */
function Page({
  item,
  scope,
  actions,
  children,
}: {
  item: string
  scope: MemoryScope | null
  actions?: ReactNode
  children: ReactNode
}) {
  const { t } = useTranslation('settings')
  return (
    <>
      <button type="button" onClick={back} className="k-back">
        <Icon icon={ArrowLeft01Icon} size={14} />
        {t('sections.memory')}
      </button>
      <article data-setting-row={item} className="k-mem">
        <div className="k-mem__bar">
          {scope ? <LayerTag scope={scope} /> : <span />}
          {actions && <span className="k-mem__actions">{actions}</span>}
        </div>
        {children}
      </article>
    </>
  )
}

function LayerTag({ scope }: { scope: MemoryScope }) {
  const { t } = useTranslation('settings')
  const { hostId } = useHostScope()
  const projectName = useProjectName(hostId, scope.layer === 'project' ? scope.project : null)
  return (
    <span className="k-mem__layer">
      <Icon icon={scope.layer === 'global' ? UserIcon : Folder01Icon} size={13} />
      {scope.layer === 'global' ? t('memory.entry.globalTag') : projectName}
    </span>
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
  const { hostId, request } = useHostScope()
  const now = useNow()
  const [editing, setEditing] = useState(false)
  const [removing, setRemoving] = useState(false)
  const who = writerName(entry, hostId) ?? t('memory.you')
  const moveToGlobal = async (project: string): Promise<void> => {
    try {
      const moved = await request('memory.moveToGlobal', { project, id: entry.id })
      toast(t('memory.entry.move.done'), undefined, { tone: 'success' })
      openSettingsItem('memory', memoryItemKey({ layer: 'global' }, moved.id))
    } catch (failure) {
      toast(memoryErrorText(failure))
    }
  }
  const items: MenuItem[] = []
  // Moving is the user's own consent, which a global write needs.
  if (scope.layer === 'project')
    items.push({
      label: t('memory.entry.move.button'),
      icon: Globe02Icon,
      onSelect: () => void moveToGlobal(scope.project),
    })
  items.push({
    label: t('memory.entry.remove.button'),
    icon: Delete02Icon,
    danger: true,
    divider: items.length > 0,
    onSelect: () => setRemoving(true),
  })
  // An entry saved once has both times a moment apart; only a later change counts as one.
  const changed = entry.updatedAt - entry.createdAt > 60_000
  const actions = editing ? undefined : (
    <>
      <SetButton icon={<Icon icon={Edit02Icon} size={14} />} onClick={() => setEditing(true)}>
        {t('memory.entry.edit')}
      </SetButton>
      <Dropdown
        align="end"
        items={items}
        trigger={({ open, toggle }) => (
          <button
            type="button"
            className="ui-as-icon-btn"
            aria-label={t('memory.entry.more')}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={toggle}
          >
            <Icon icon={MoreHorizontalIcon} size={16} />
          </button>
        )}
      />
    </>
  )
  return (
    <Page item={item} scope={scope} actions={actions}>
      {editing ? (
        <Editor scope={scope} entry={entry} onDone={() => setEditing(false)} />
      ) : (
        <>
          <h1 className="k-mem__title">{entry.title}</h1>
          {entry.description && <p className="k-mem__summary">{entry.description}</p>}
          <p className="k-mem__meta">
            {entry.source.agentId !== null ? (
              <AgentMark agent={entry.source.agentId} size={14} hostId={hostId} />
            ) : (
              <Icon icon={UserIcon} size={14} />
            )}
            <span>{who}</span>
            <span className="k-mem__dot">·</span>
            <span title={fullTime(entry.updatedAt)}>
              {t(changed ? 'memory.entry.changed' : 'memory.entry.written', {
                when: mediumAgo(entry.updatedAt, now),
              })}
            </span>
            {entry.source.sessionId !== null && <SessionLink sessionId={entry.source.sessionId} />}
          </p>
          <div className="k-mem__body" data-selectable="">
            {entry.body ? (
              <Markdown markdown={entry.body} className="k-mem__prose" />
            ) : (
              <p className="k-mem__empty">{t('memory.entry.noBody')}</p>
            )}
          </div>
        </>
      )}
      <RemoveDialog scope={scope} entry={entry} open={removing} onOpenChange={setRemoving} />
    </Page>
  )
}

/** The session that wrote the entry, as a link while the window still knows it. */
function SessionLink({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('settings')
  const summary = useSessionsStore((s) => s.byId[sessionId])
  if (!summary) return null
  const title = sessionTitle(summary)
  return (
    <>
      <span className="k-mem__dot">·</span>
      <button
        type="button"
        className="k-mem__session"
        aria-label={t('memory.entry.openSession', { title })}
        onClick={() => openSession(summary.id, summary.projectPath)}
      >
        <span>{title}</span>
        <Icon icon={ArrowUpRight01Icon} size={12} />
      </button>
    </>
  )
}

function RemoveDialog({
  scope,
  entry,
  open,
  onOpenChange,
}: {
  scope: MemoryScope
  entry: MemoryEntry
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const { request } = useHostScope()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remove = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await request('memory.remove', { scope, id: entry.id })
      onOpenChange(false)
      toast(t('memory.entry.remove.done'))
      back()
    } catch (failure) {
      setError(memoryErrorText(failure))
      setBusy(false)
    }
  }
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (next) setError(null)
        onOpenChange(next)
      }}
    >
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
  )
}

/**
 * An entry written where it is read: the title and summary as fields in place, the text as its
 * Markdown source. With no entry it adds one and shows its page.
 */
function Editor({
  scope,
  entry,
  onDone,
}: {
  scope: MemoryScope
  entry: MemoryEntry | null
  onDone: () => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const { request } = useHostScope()
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
      const saved = await request('memory.save', {
        scope,
        id: entry?.id ?? null,
        draft: { title, description, body },
      })
      if (entry === null) openSettingsItem('memory', memoryItemKey(scope, saved.id))
      else onDone()
    } catch (failure) {
      setError(memoryErrorText(failure))
      setBusy(false)
    }
  }
  return (
    <div
      className="k-mem__edit"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Escape') {
          event.stopPropagation()
          onDone()
        }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          void save()
        }
      }}
    >
      <input
        value={title}
        autoFocus
        autoComplete="off"
        aria-label={t('memory.editor.title')}
        placeholder={t('memory.editor.titlePlaceholder')}
        maxLength={MEMORY_TITLE_CHARS}
        className="k-mem__title k-mem__field"
        onChange={(event) => setTitle(event.target.value)}
      />
      <textarea
        value={description}
        rows={1}
        aria-label={t('memory.editor.description')}
        placeholder={t('memory.editor.descriptionPlaceholder')}
        maxLength={MEMORY_DESCRIPTION_CHARS}
        className="k-mem__summary k-mem__field k-mem__field--grow"
        // The summary is one line in the index agents read, so a pasted break becomes a space.
        onChange={(event) => setDescription(event.target.value.replace(/\s*\n\s*/g, ' '))}
      />
      <div className="k-mem__body k-mem__body--edit">
        <span className="k-mem__hint" aria-hidden>
          {t('memory.editor.markdown')}
        </span>
        <textarea
          value={body}
          aria-label={t('memory.editor.body')}
          placeholder={t('memory.editor.bodyPlaceholder')}
          maxLength={MEMORY_BODY_CHARS}
          className="k-mem__source"
          onChange={(event) => setBody(event.target.value)}
        />
      </div>
      <div className="k-mem__savebar">
        <span className="k-mem__keys">{t('memory.editor.keys', { mod: modLabel })}</span>
        <ControlError error={error} />
        <SetButton size="md" variant="ghost" onClick={onDone}>
          {t('common:actions.cancel')}
        </SetButton>
        <SetButton
          size="md"
          variant="primary"
          loading={busy}
          disabled={!ready}
          onClick={() => void save()}
        >
          {entry ? t('memory.editor.save') : t('memory.add')}
        </SetButton>
      </div>
    </div>
  )
}
