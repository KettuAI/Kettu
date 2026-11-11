import { useEffect, useState, type ReactNode } from 'react'
import {
  GitBranchIcon,
  GitCommitIcon,
  InformationCircleIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { Trans, useTranslation } from 'react-i18next'
import type { BranchInfo, GitStatus } from '@shared/git'
import { FolderMark } from '@renderer/components/affect/assistant-home'
import { Input } from '@renderer/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { Glyph } from '@renderer/features/shell/glyph'
import { errorMessage, host } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import {
  chooseBase,
  chooseWhere,
  useWorktreeChoice,
  writeBranch,
} from '@renderer/stores/worktree-choice'
import { shortOid, WORKTREE_ICON } from '../worktree/worktree-icon'
import { branchNameInvalid, currentBase } from './worktree-base'

/**
 * New session's place to work, in the tray where the branch was: Local, the project folder, or a
 * new worktree, with its base and branch name. Remembered per project.
 */
export function WorktreeMenu({ projectPath, status }: { projectPath: string; status: GitStatus }) {
  const { t } = useTranslation('session')
  const where = useWorktreeChoice((s) => s.where[projectPath] ?? 'local')
  const picked = useWorktreeChoice((s) => s.base[projectPath] ?? null)
  const draft = useWorktreeChoice((s) => s.branch)
  const [open, setOpen] = useState(false)
  const [branches, setBranches] = useState<BranchInfo[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const current = currentBase(status)
  const base = picked ?? current
  const worktree = where === 'worktree'

  useEffect(() => {
    if (!open || !worktree) return
    let live = true
    host('git.branches', { projectPath }).then(
      (list) => {
        if (!live) return
        setBranches(list.branches)
        setListError(null)
      },
      (error: unknown) => live && setListError(errorMessage(error)),
    )
    return () => {
      live = false
    }
  }, [open, worktree, projectPath])

  const baseLabel = (value: string | null): string => {
    if (!value) return ''
    return value === status.head.oid && !status.head.branch
      ? t('worktree.commit', { oid: shortOid(value) })
      : value
  }
  // The current branch or commit first, then the other local branches as git lists them.
  const bases = current
    ? [current, ...(branches ?? []).map((b) => b.name).filter((name) => name !== current)]
    : (branches ?? []).map((b) => b.name)
  if (picked && !bases.includes(picked)) bases.push(picked)
  const invalid = branchNameInvalid(draft)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={t('worktree.where')}
            className="ui-as-tray-link kettu-tray-link--branch"
          />
        }
      >
        <Glyph
          icon={worktree ? WORKTREE_ICON : status.head.branch ? GitBranchIcon : GitCommitIcon}
          size={13}
        />
        <span
          className={cn('kettu-tray-link__text', !status.head.branch && !worktree && 'font-mono')}
        >
          {worktree
            ? t('worktree.newTrigger', { base: baseLabel(base) })
            : t('worktree.localTrigger', { branch: baseLabel(current) })}
        </span>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-76 gap-1 p-1.5">
        <div role="radiogroup" aria-label={t('worktree.where')} className="flex flex-col">
          <Choice
            checked={!worktree}
            icon={<FolderMark />}
            title={t('worktree.local')}
            hint={t('worktree.localHint')}
            onChoose={() => chooseWhere(projectPath, 'local')}
          />
          <Choice
            checked={worktree}
            icon={<Glyph icon={WORKTREE_ICON} size={15} className="text-icon" />}
            title={t('worktree.new')}
            hint={t('worktree.newHint')}
            onChoose={() => chooseWhere(projectPath, 'worktree')}
          />
        </div>
        {worktree && (
          <div className="mt-1 flex flex-col gap-2 border-t border-subtle px-2 pt-2.5 pb-1.5">
            <label className="flex items-center gap-3">
              <span className="w-12 shrink-0 text-meta text-tertiary">{t('worktree.from')}</span>
              <Select
                value={base}
                items={bases.map((value) => ({ value, label: baseLabel(value) }))}
                onValueChange={(next) => {
                  if (next !== null) chooseBase(projectPath, next === current ? null : next)
                }}
              >
                <SelectTrigger size="sm" className="min-w-0 flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {bases.map((value) => (
                    <SelectItem key={value} value={value}>
                      <span className={cn('truncate', value === status.head.oid && 'font-mono')}>
                        {baseLabel(value)}
                      </span>
                      {value === current && (
                        <span className="text-meta text-tertiary">{t('worktree.current')}</span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="flex items-center gap-3">
              <span className="w-12 shrink-0 text-meta text-tertiary">{t('worktree.branch')}</span>
              <Input
                value={draft ?? ''}
                maxLength={100}
                spellCheck={false}
                aria-invalid={invalid || undefined}
                placeholder={t('worktree.branchPlaceholder')}
                onChange={(event) => writeBranch(event.target.value.trim())}
                className="h-control-sm min-w-0 flex-1 font-mono text-code"
              />
            </label>
            {invalid && <p className="text-meta text-danger">{t('worktree.branchInvalid')}</p>}
            {listError && (
              <p className="text-meta text-danger" title={listError}>
                {t('worktree.branchesFailed', { message: listError })}
              </p>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function Choice({
  checked,
  icon,
  title,
  hint,
  onChoose,
}: {
  checked: boolean
  icon: ReactNode
  title: string
  hint: string
  onChoose: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onChoose}
      className="relative flex min-h-10 w-full cursor-default items-center gap-2.5 rounded-lg py-1.5 pr-8 pl-2 text-left text-menu outline-hidden select-none hover:bg-accent focus-visible:bg-accent"
    >
      <span className="grid size-4 shrink-0 place-items-center">{icon}</span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{title}</span>
        <span className="truncate text-meta text-tertiary">{hint}</span>
      </span>
      {checked && (
        <Glyph icon={Tick02Icon} size={12} className="absolute top-1/2 right-2 -translate-y-1/2" />
      )}
    </button>
  )
}

/**
 * Under the tray while New worktree is chosen: where the worktree is cut from, and the project
 * folder's uncommitted changes, which stay behind.
 */
export function WorktreeNote({ projectPath, status }: { projectPath: string; status: GitStatus }) {
  const { t } = useTranslation('session')
  const where = useWorktreeChoice((s) => s.where[projectPath] ?? 'local')
  const picked = useWorktreeChoice((s) => s.base[projectPath] ?? null)
  if (where !== 'worktree') return null
  const current = currentBase(status)
  const base = picked ?? current
  if (!base) return null
  // Only the current branch's or commit's oid is known here.
  const oid = base === current ? status.head.oid : null
  const detached = !status.head.branch && base === status.head.oid
  const { staged, unstaged, untracked, conflicted } = status.changes
  const uncommitted = staged + unstaged + untracked + conflicted
  const code = (text: string) => <b className="font-mono text-code font-normal">{text}</b>
  return (
    <ul className="flex flex-col gap-0.5 px-2.75">
      <li className="flex min-w-0 items-start gap-1.5 text-xs text-secondary">
        <Glyph icon={WORKTREE_ICON} size={12} className="mt-0.5 shrink-0 text-icon" />
        <span className="min-w-0">
          <Trans
            t={t}
            i18nKey={oid && !detached ? 'worktree.cutFromAt' : 'worktree.cutFrom'}
            components={{
              base: detached ? code(shortOid(base)) : <b className="font-medium">{base}</b>,
              oid: code(oid ? shortOid(oid) : ''),
            }}
          />
        </span>
      </li>
      {uncommitted > 0 && (
        <li className="flex min-w-0 items-start gap-1.5 text-xs text-secondary">
          <Glyph icon={InformationCircleIcon} size={12} className="mt-0.5 shrink-0 text-icon" />
          <span className="min-w-0">{t('worktree.uncommitted', { count: uncommitted })}</span>
        </li>
      )}
    </ul>
  )
}
