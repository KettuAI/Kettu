import { useState } from 'react'
import { Add01Icon, ArrowRight01Icon, Search01Icon, UserIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { MemoryEntry, MemoryImportScan, MemoryProject, MemoryScope } from '@shared/memory'
import { Icon } from '@renderer/components/affect/app-shell'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Dialog, DialogClose } from '@renderer/components/ui/dialog'
import { toast } from '@renderer/components/ui/toast'
import { MEMORY_GLYPH } from '@renderer/features/session/entries/tool-call-model'
import { mediumAgo } from '@renderer/lib/format'
import { memoryErrorText } from '@renderer/lib/memory-errors'
import { useNow } from '@renderer/lib/use-now'
import { useHostScope } from '@renderer/stores/host-scope'
import { chooseMemoryProject } from '@renderer/stores/memory'
import { openSettingsItem } from '@renderer/stores/view'
import { ControlError, SetButton, SettingSelect, SettingSwitch, Skel } from './controls'
import { useImportScan, writerName } from './memory-data'
import { memoryItemKey, NEW_MEMORY } from './memory-items'
import { EmptyRow, Notice } from './rows'
import {
  SettingsDialogBody,
  SettingsDialogContent,
  SettingsDialogFooter,
  SettingsDialogHeader,
  SettingsField,
} from './settings-dialog'

/** The switch: on, Kettu hands every agent its memory; off, each harness keeps its own. */
export function MemorySwitch({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation('settings')
  const { request } = useHostScope()
  const [wanted, setWanted] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The host's own answer replaces the one shown meanwhile once it arrives.
  const [seen, setSeen] = useState(enabled)
  if (seen !== enabled) {
    setSeen(enabled)
    setWanted(null)
  }
  const change = async (next: boolean): Promise<void> => {
    setWanted(next)
    setBusy(true)
    setError(null)
    try {
      await request('memory.setEnabled', { enabled: next })
    } catch (failure) {
      setWanted(null)
      setError(memoryErrorText(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <ControlError error={error} />
      <SettingSwitch
        label={t('memory.switch.name')}
        checked={wanted ?? enabled}
        disabled={busy}
        onChange={(next) => void change(next)}
      />
    </>
  )
}

/** An entry's row: its title and summary, then who wrote it last and when; the row opens its page. */
export function EntryRow({ item, entry }: { item: string; entry: MemoryEntry }) {
  const { t } = useTranslation('settings')
  const { hostId } = useHostScope()
  const now = useNow()
  const who = writerName(entry, hostId) ?? t('memory.you')
  return (
    <div className="ui-sg-row k-item k-mem-row">
      <button
        type="button"
        data-item-row={item}
        aria-label={entry.title}
        onClick={() => openSettingsItem('memory', item)}
        className="k-hit"
      />
      <span className="ui-sg-label k-lines k-mem-row__text">
        <b className="k-row-title">{entry.title}</b>
        {entry.description && <small>{entry.description}</small>}
      </span>
      <span className="k-end k-mem-row__end">
        <span className="k-mem-row__who" title={who}>
          {entry.source.agentId !== null ? (
            <AgentMark agent={entry.source.agentId} size={14} hostId={hostId} mono />
          ) : (
            <Icon icon={UserIcon} size={14} />
          )}
        </span>
        <span className="k-num">{mediumAgo(entry.updatedAt, now)}</span>
        <span className="k-chevron">
          <Icon icon={ArrowRight01Icon} size={14} />
        </span>
      </span>
    </div>
  )
}

const add = (scope: MemoryScope) => openSettingsItem('memory', memoryItemKey(scope, NEW_MEMORY))

/** Add, at a layer's heading, so it stays in reach however long the list is. */
export function AddButton({ scope }: { scope: MemoryScope }) {
  const { t } = useTranslation('settings')
  return (
    <SetButton icon={<Icon icon={Add01Icon} size={14} />} onClick={() => add(scope)}>
      {t('memory.add')}
    </SetButton>
  )
}

/** Searches both layers' titles, summaries and text. */
export function MemorySearch({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const { t } = useTranslation('settings')
  return (
    <label className="k-mem-search">
      <Icon icon={Search01Icon} size={15} />
      <input
        type="search"
        value={value}
        autoComplete="off"
        placeholder={t('memory.search.placeholder')}
        aria-label={t('memory.search.placeholder')}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // Esc clears the search before it closes Settings.
          if (event.key === 'Escape' && value !== '') {
            event.stopPropagation()
            onChange('')
          }
        }}
      />
    </label>
  )
}

/** The last row of a long layer cut short: how many more there are, all of them on a click. */
export function ShowMoreRow({ count, onClick }: { count: number; onClick: () => void }) {
  const { t } = useTranslation('settings')
  return (
    <button type="button" onClick={onClick} className="ui-sg-row k-add-row k-mem-more">
      {t('memory.showMore', { count })}
    </button>
  )
}

/** Where a search finds nothing in either layer. */
export function NoMatches({ query }: { query: string }) {
  const { t } = useTranslation('settings')
  return <EmptyRow title={t('memory.search.none', { query })} />
}

/** A layer with nothing in it yet: agents note things as they work, and the user can add some. */
export function EmptyLayer({ scope, projectName }: { scope: MemoryScope; projectName: string }) {
  const { t } = useTranslation('settings')
  const global = scope.layer === 'global'
  return (
    <EmptyRow
      title={
        global
          ? t('memory.empty.globalTitle')
          : t('memory.empty.projectTitle', { project: projectName })
      }
      hint={global ? t('memory.empty.globalHint') : t('memory.empty.projectHint')}
      action={
        <SetButton
          variant="primary"
          icon={<Icon icon={Add01Icon} size={14} />}
          onClick={() => add(scope)}
        >
          {t('memory.add')}
        </SetButton>
      }
    />
  )
}

export function NoProjects() {
  const { t } = useTranslation('settings')
  return (
    <EmptyRow title={t('memory.empty.noProjectsTitle')} hint={t('memory.empty.noProjectsHint')} />
  )
}

/** Which project's memory the list shows, with how many entries each holds. */
export function ProjectPicker({ projects, value }: { projects: MemoryProject[]; value: string }) {
  const { t } = useTranslation('settings')
  const { hostId } = useHostScope()
  return (
    <SettingSelect
      label={t('memory.project.picker')}
      value={value}
      options={projects.map((p) => ({
        value: p.path,
        label: p.name,
        hint: t('memory.project.count', { count: p.count }),
      }))}
      onChange={(path) => chooseMemoryProject(hostId, path)}
    />
  )
}

/** An entry's row while the list is read. */
export function PendingRow() {
  return (
    <div className="ui-sg-row k-mem-row" aria-busy="true">
      <span className="ui-sg-label k-lines">
        <Skel width={160} />
        <Skel width={240} />
      </span>
    </div>
  )
}

/** The page's rows while the first read is out. */
export function MemoryPending() {
  return (
    <div className="ui-sg-card k-pending" aria-busy="true">
      <PendingRow />
      <PendingRow />
    </div>
  )
}

export function ListFailed({ error, onRetry }: { error: string; onRetry: () => void }) {
  const { t } = useTranslation('settings')
  return (
    <div className="ui-sg-row">
      <ControlError error={t('memory.loadFailed', { error })} wrap />
      <span className="ui-sg-control">
        <SetButton onClick={onRetry}>{t('memory.retry')}</SetButton>
      </span>
    </div>
  )
}

const entryCount = (scan: MemoryImportScan): number =>
  scan.sources.reduce((sum, source) => sum + source.entries.length, 0)

/** Under the switch while the agents' own memories hold entries not imported yet. */
export function ImportNotice({ importable }: { importable: number }) {
  const { t } = useTranslation('settings')
  const scan = useImportScan(true)
  const [open, setOpen] = useState(false)
  const found = scan.value
  const title = found
    ? t('memory.import.found', {
        count: entryCount(found),
        agents: t('memory.import.agents', {
          count: new Set(found.sources.map((source) => source.agentId)).size,
        }),
      })
    : t('memory.import.foundSome', { count: importable })
  return (
    <>
      <Notice
        variant="info"
        icon={<Icon icon={MEMORY_GLYPH} size={16} />}
        title={title}
        action={<SetButton onClick={() => setOpen(true)}>{t('memory.import.button')}</SetButton>}
      >
        {t('memory.import.hint')}
      </Notice>
      <Dialog open={open} onOpenChange={setOpen}>
        <SettingsDialogContent className="sm:max-w-125">
          <ImportBody
            scan={found}
            error={scan.error}
            onRetry={scan.retry}
            onDone={() => setOpen(false)}
          />
        </SettingsDialogContent>
      </Dialog>
    </>
  )
}

/**
 * The import dialog: how many entries each agent remembers of each project, then those about the
 * user, each to put in global memory if ticked. Mounted with each opening, so nothing starts ticked.
 */
function ImportBody({
  scan,
  error,
  onRetry,
  onDone,
}: {
  scan: MemoryImportScan | null
  error: string | null
  onRetry: () => void
  onDone: () => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const { request } = useHostScope()
  const [global, setGlobal] = useState<ReadonlySet<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const aboutUser = scan?.sources.flatMap((source) => source.entries.filter((e) => e.aboutUser))
  const total = scan ? entryCount(scan) : 0

  const run = async (): Promise<void> => {
    if (!scan || busy) return
    setBusy(true)
    setFailure(null)
    try {
      const result = await request('memory.import', {
        sources: scan.sources.map((source) => ({
          agentId: source.agentId,
          project: source.project,
        })),
        global: (aboutUser ?? []).filter((entry) => global.has(entry.key)).map((e) => e.key),
      })
      onDone()
      toast(
        result.skipped > 0
          ? t('memory.import.importedSkipped', {
              count: result.imported,
              skipped: result.skipped,
            })
          : t('memory.import.imported', { count: result.imported }),
        undefined,
        { tone: 'success' },
      )
    } catch (caught) {
      setFailure(memoryErrorText(caught))
      setBusy(false)
    }
  }

  return (
    <>
      <SettingsDialogHeader title={t('memory.import.title')}>
        {t('memory.import.body')}
      </SettingsDialogHeader>
      <SettingsDialogBody>
        {scan === null ? (
          error === null ? (
            <div aria-busy="true" className="flex flex-col gap-2.5">
              <Skel width="60%" />
              <Skel width="45%" />
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <ControlError error={t('memory.import.scanFailed', { error })} wrap />
              <SetButton onClick={onRetry}>{t('memory.retry')}</SetButton>
            </div>
          )
        ) : total === 0 ? (
          <p className="kettu-sd__text">{t('memory.import.nothing')}</p>
        ) : (
          <>
            <SettingsField label={t('memory.import.sources')}>
              <ul className="kettu-sd__list">
                {scan.sources.map((source) => (
                  <li key={`${source.agentId}\n${source.project}`} className="kettu-sd__row">
                    <AgentMark agent={source.agentId} size={16} />
                    <span className="ui-sg-label">
                      <b>
                        {t('memory.import.source', {
                          agent: source.agentName,
                          project: source.projectName,
                        })}
                      </b>
                    </span>
                    <span className="k-muted k-num">
                      {t('memory.import.entries', { count: source.entries.length })}
                    </span>
                  </li>
                ))}
              </ul>
            </SettingsField>
            {aboutUser && aboutUser.length > 0 && (
              <SettingsField
                label={t('memory.import.aboutYou')}
                hint={t('memory.import.aboutYouHint')}
              >
                <ul className="kettu-sd__list">
                  {aboutUser.map((entry) => (
                    <li key={entry.key} className="kettu-sd__row">
                      <span className="ui-sg-label">
                        <b>{entry.title}</b>
                        {entry.description && <small>{entry.description}</small>}
                      </span>
                      <label className="flex flex-none items-center gap-2 text-control text-secondary">
                        <Checkbox
                          checked={global.has(entry.key)}
                          disabled={busy}
                          onCheckedChange={(on) =>
                            setGlobal((current) => {
                              const next = new Set(current)
                              if (on) next.add(entry.key)
                              else next.delete(entry.key)
                              return next
                            })
                          }
                        />
                        {t('memory.import.putGlobal')}
                      </label>
                    </li>
                  ))}
                </ul>
              </SettingsField>
            )}
          </>
        )}
        <ControlError error={failure} wrap />
      </SettingsDialogBody>
      <SettingsDialogFooter>
        <DialogClose render={<SetButton size="md" variant="ghost" />}>
          {t('common:actions.cancel')}
        </DialogClose>
        <SetButton
          size="md"
          variant="primary"
          loading={busy}
          disabled={scan === null || total === 0}
          onClick={() => void run()}
        >
          {t('memory.import.import')}
        </SetButton>
      </SettingsDialogFooter>
    </>
  )
}
