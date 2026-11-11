import { Trans, useTranslation } from 'react-i18next'
import type { SessionWorktree } from '@shared/git'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { CopyButton } from '@renderer/features/git/copy-button'
import { Glyph } from '@renderer/features/shell/glyph'
import { hostPath } from '@renderer/lib/host-paths'
import { WORKTREE_ICON } from './worktree-icon'

/** The tooltip of a worktree's mark: its branch, then its folder. */
export function WorktreeHint({ worktree }: { worktree: Pick<SessionWorktree, 'path' | 'branch'> }) {
  const { t } = useTranslation('session')
  return (
    <span className="flex flex-col gap-0.5">
      <span>{t('worktree.inWorktree', { branch: worktree.branch })}</span>
      <span className="font-mono text-meta break-all opacity-80">{hostPath(worktree.path)}</span>
    </span>
  )
}

/** The worktree a session works in, on a tray: its mark and branch, the folder on hover. */
export function WorktreeTrayTag({
  worktree,
}: {
  worktree: Pick<SessionWorktree, 'path' | 'branch'>
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="ui-as-tray-link kettu-tray-link--branch" data-static="" />}
      >
        <Glyph icon={WORKTREE_ICON} size={13} />
        <span className="kettu-tray-link__text">{worktree.branch}</span>
      </TooltipTrigger>
      <TooltipContent>
        <WorktreeHint worktree={worktree} />
      </TooltipContent>
    </Tooltip>
  )
}

/** The same on the session's top bar, as a chip beside its pull request. */
export function WorktreeBarChip({ worktree }: { worktree: SessionWorktree }) {
  const { t } = useTranslation('session')
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={t('worktree.inWorktree', { branch: worktree.branch })}
            className="ks-chip app-region-no-drag"
          />
        }
      >
        <Glyph icon={WORKTREE_ICON} size={13} className="shrink-0" />
        <span className="ks-chip__text">{worktree.branch}</span>
      </TooltipTrigger>
      <TooltipContent>
        <WorktreeHint worktree={worktree} />
      </TooltipContent>
    </Tooltip>
  )
}

/** On a sidebar row: the mark alone, the branch and folder on hover. */
export function WorktreeRowMark({
  worktree,
  onEnter,
}: {
  worktree: SessionWorktree
  /** The pointer came onto the mark, whose tooltip takes the place of the row's card. */
  onEnter: () => void
}) {
  const { t } = useTranslation('session')
  return (
    <Tooltip>
      <TooltipTrigger
        delay={400}
        render={
          // As an image, its label goes into the name of the row's button around it.
          <span
            role="img"
            aria-label={t('worktree.inWorktree', { branch: worktree.branch })}
            onPointerEnter={onEnter}
            className="inline-flex h-5 shrink-0 items-center px-[3px] text-tertiary"
          />
        }
      >
        <Glyph icon={WORKTREE_ICON} size={13} />
      </TooltipTrigger>
      <TooltipContent side="right">
        <WorktreeHint worktree={worktree} />
      </TooltipContent>
    </Tooltip>
  )
}

/** Under a sub-agent's bar: the worktree its agent made for it, the folder on hover to copy. */
export function AgentWorktreeLine({
  worktree,
}: {
  worktree: { path: string; branch: string | null }
}) {
  const { t } = useTranslation('session')
  const path = hostPath(worktree.path)
  return (
    <div className="flex min-w-0 items-center gap-1.5 px-2 pt-1 text-xs text-secondary">
      <Glyph icon={WORKTREE_ICON} size={12} className="shrink-0 text-icon" />
      <Tooltip>
        <TooltipTrigger render={<span className="min-w-0 truncate" />}>
          {worktree.branch ? (
            <Trans
              t={t}
              i18nKey="worktree.agentWorktree"
              components={{
                branch: <b className="font-mono text-code font-normal">{worktree.branch}</b>,
              }}
            />
          ) : (
            t('worktree.agentWorktreeUnnamed')
          )}
        </TooltipTrigger>
        <TooltipContent>
          <span className="font-mono break-all">{path}</span>
        </TooltipContent>
      </Tooltip>
      <CopyButton text={path} label={t('worktree.copyPath')} />
    </div>
  )
}
