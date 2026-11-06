import { useEffect, useMemo, useState, type RefObject } from 'react'
import type { TFunction } from 'i18next'
import {
  Add01Icon,
  FolderLinksIcon,
  GitBranchIcon,
  Search01Icon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { BranchInfo, BranchList, GitStatus } from '@shared/git'
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxSeparator,
  useComboboxFilter,
} from '@renderer/components/ui/combobox'
import { InputGroupAddon } from '@renderer/components/ui/input-group'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { toast } from '@renderer/components/ui/toast'
import { shortAgo } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { hostOfPath, onHost } from '@renderer/lib/host-paths'
import { useNow } from '@renderer/lib/use-now'
import { openGitDialog } from '@renderer/stores/git'
import { useSessionsStore } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'
import { runStep } from './steps'
import { isBranchName, recentBranches, sameFolder } from './switcher-model'
import { Glyph } from '@renderer/features/session/composer/glyph'

// The New branch item's value, which no branch name can take.
const NEW_BRANCH = '\0new-branch'

interface Group {
  value: 'session' | 'recent' | 'new'
  items: string[]
}

type Loaded = { list: BranchList; error: null } | { list: null; error: string } | null

/**
 * Switches the session's branch: a search field over the branches, this session's first, the
 * rest by their last commit, and New branch from here…. A branch checked out in another worktree
 * opens that worktree's session instead.
 */
export function BranchSwitcher({
  status,
  open,
  anchor,
  onOpenChange,
}: {
  status: GitStatus
  open: boolean
  anchor: RefObject<HTMLElement | null>
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation('git')
  const now = useNow()
  const { contains } = useComboboxFilter()
  const [loaded, setLoaded] = useState<Loaded>(null)
  const [query, setQuery] = useState('')
  const { projectPath } = status
  const current = status.head.detached ? null : status.head.branch
  const { defaultBranch } = status

  useEffect(() => {
    if (!open) return
    let live = true
    host('git.branches', { projectPath }).then(
      (list) => live && setLoaded({ list, error: null }),
      (error: unknown) => live && setLoaded({ list: null, error: errorMessage(error) }),
    )
    return () => {
      live = false
    }
  }, [open, projectPath])

  const byName = useMemo(
    () => new Map((loaded?.list?.branches ?? []).map((b) => [b.name, b])),
    [loaded],
  )
  const groups = useMemo((): Group[] => {
    const branches = loaded?.list?.branches ?? []
    return [
      { value: 'session', items: current ? [current] : [] },
      {
        value: 'recent',
        items: recentBranches(
          branches.map((b) => b.name),
          current,
          defaultBranch,
        ),
      },
      { value: 'new', items: [NEW_BRANCH] },
    ]
  }, [loaded, current, defaultBranch])

  const typed = query.trim()
  const creates = typed !== '' && !byName.has(typed) && isBranchName(typed)

  const choose = (value: string | null): void => {
    if (!value) return
    onOpenChange(false)
    if (value === NEW_BRANCH) {
      if (creates) void runStep(projectPath, { kind: 'switch', branch: typed, create: true })
      else openGitDialog(projectPath, { kind: 'newBranch' })
      return
    }
    if (value === current) return
    const branch = byName.get(value)
    if (branch?.worktree) {
      openWorktree(branch, projectPath, t)
      return
    }
    void runStep(projectPath, { kind: 'switch', branch: value, create: false })
  }

  const side = (name: string): string | null => {
    if (name === current) {
      const ahead = status.upstream?.ahead ?? 0
      return ahead > 0 ? `↑${ahead}` : null
    }
    const branch = byName.get(name)
    if (!branch) return null
    if (branch.worktree) return t('switcher.inWorktree')
    if (branch.name === status.defaultBranch) return t('switcher.default')
    return branch.committedAt ? shortAgo(branch.committedAt, now) : null
  }

  return (
    <Combobox
      items={groups}
      value={null}
      autoHighlight
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) setQuery('')
      }}
      inputValue={query}
      onInputValueChange={setQuery}
      onValueChange={(value: string | null) => choose(value)}
      itemToStringLabel={(value: string) => (value === NEW_BRANCH ? '' : value)}
      filter={(value: string, search: string) => value === NEW_BRANCH || contains(value, search)}
    >
      <ComboboxContent
        anchor={anchor}
        // Clears the top bar's edge by 6px, as the branch popover does.
        sideOffset={17}
        className="w-75 p-1.25 *:data-[slot=input-group]:mb-1 *:data-[slot=input-group]:h-8! *:data-[slot=input-group]:rounded-md! *:data-[slot=input-group]:bg-subtle! *:data-[slot=input-group]:shadow-none!"
      >
        <ComboboxInput
          showTrigger={false}
          autoFocus
          placeholder={t('switcher.search')}
          aria-label={t('switcher.searchLabel')}
          spellCheck={false}
        >
          <InputGroupAddon>
            <Glyph icon={Search01Icon} className="size-3.5" />
          </InputGroupAddon>
        </ComboboxInput>
        <ComboboxList className="max-h-[min(--spacing(90),calc(var(--available-height)---spacing(12)))] p-0">
          {(group: Group) =>
            group.value === 'new' ? (
              <ComboboxGroup key={group.value} items={group.items}>
                <ComboboxSeparator className="mx-0.75 my-1.25" />
                <ComboboxCollection>
                  {(value: string) => (
                    <ComboboxItem key={value} value={value} className={ITEM}>
                      <span className="flex w-4 justify-center text-secondary">
                        <Glyph icon={Add01Icon} className="size-3.5" />
                      </span>
                      <span className="min-w-0 truncate">
                        {creates ? t('switcher.create', { name: typed }) : t('switcher.newBranch')}
                      </span>
                    </ComboboxItem>
                  )}
                </ComboboxCollection>
              </ComboboxGroup>
            ) : (
              group.items.length > 0 && (
                <ComboboxGroup key={group.value} items={group.items}>
                  <ComboboxLabel className="h-6.5 text-small">
                    {t(group.value === 'session' ? 'switcher.thisSession' : 'switcher.recent')}
                  </ComboboxLabel>
                  <ComboboxCollection>
                    {(name: string) => {
                      const branch = byName.get(name)
                      const note = side(name)
                      return (
                        <ComboboxItem
                          key={name}
                          value={name}
                          className={ITEM}
                          title={branch?.worktree ?? undefined}
                        >
                          <span className="flex shrink-0 gap-2">
                            <span className="flex w-4 justify-center text-primary">
                              {name === current && <Glyph icon={Tick02Icon} className="size-3" />}
                            </span>
                            <span className="flex w-4 justify-center text-secondary">
                              {branch?.worktree ? (
                                <Glyph icon={FolderLinksIcon} className="size-3.5" />
                              ) : (
                                <Glyph icon={GitBranchIcon} className="size-3.5" />
                              )}
                            </span>
                          </span>
                          <span className="min-w-0 truncate">{name}</span>
                          {note && (
                            <span className="ml-auto shrink-0 pl-4 text-hint text-tertiary tabular">
                              {note}
                            </span>
                          )}
                        </ComboboxItem>
                      )
                    }}
                  </ComboboxCollection>
                </ComboboxGroup>
              )
            )
          }
        </ComboboxList>
        {loaded === null && (
          <div className="flex flex-col gap-2 px-2 py-2">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-28" />
          </div>
        )}
        {loaded?.error && (
          <p className="px-2 py-1.5 text-small text-danger" title={loaded.error}>
            {loaded.error.split('\n')[0]}
          </p>
        )}
      </ComboboxContent>
    </Combobox>
  )
}

const ITEM = 'h-7.5 gap-2.25 px-2 pr-2 text-control'

/** Opens the latest session in the worktree that has the branch, or says where it is. */
function openWorktree(branch: BranchInfo, projectPath: string, t: TFunction<'git'>): void {
  const folder = branch.worktree!
  const hostId = hostOfPath(projectPath)
  const sessions = Object.values(useSessionsStore.getState().byId)
    .filter(
      (s) =>
        s.archivedAt === null &&
        s.origin !== 'subagent' &&
        sameFolder(s.projectPath, onHost(hostId, folder)),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const session = sessions[0]
  if (session) {
    openSession(session.id, session.projectPath)
    return
  }
  toast(t('switcher.checkedOutIn', { branch: branch.name, folder }), undefined, { tone: 'info' })
}
