import { Message01Icon, Store01Icon } from '@hugeicons/core-free-icons'
import { Trans, useTranslation } from 'react-i18next'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { Glyph, MenuGlyph } from '@renderer/features/shell/glyph'
import { useHostSops } from '@renderer/stores/sops'
import { openMarketplace } from '@renderer/stores/view'
import { WORKTREE_ICON } from '../worktree/worktree-icon'
import { SOP_ICON, sopBlocked, sopName, stepChain } from './sop-picks'

const CHAT = ''

/**
 * New session's way of working, on the tray before the worktree: Chat, one agent as a session
 * is, or an SOP of the host's library that runs the message as a task, one session per step.
 * An SOP waiting for approval, changed since, or unreadable is listed but cannot be chosen.
 */
export function SopMenu({
  hostId,
  sopId,
  onChoose,
}: {
  hostId: string | null
  /** The chosen SOP, null for Chat. */
  sopId: string | null
  onChoose: (sopId: string | null) => void
}) {
  const { t } = useTranslation('session')
  const { entries, loaded, error } = useHostSops(hostId)
  const chosen = sopId ? entries.find((entry) => entry.id === sopId) : undefined

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={t('newSession.sop.label')}
            className="ui-as-tray-link kettu-tray-link--sop"
          />
        }
      >
        <Glyph icon={chosen ? SOP_ICON : Message01Icon} size={13} />
        <span className="kettu-tray-link__text">
          {chosen ? sopName(chosen) : t('newSession.sop.chat')}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-80">
        <DropdownMenuRadioGroup
          value={sopId ?? CHAT}
          onValueChange={(value) => onChoose(value === CHAT ? null : String(value))}
        >
          <DropdownMenuRadioItem value={CHAT} closeOnClick className="py-1.5">
            <MenuGlyph icon={Message01Icon} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{t('newSession.sop.chat')}</span>
              <span className="truncate text-meta text-tertiary">
                {t('newSession.sop.chatHint')}
              </span>
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t('newSession.sop.heading')}</DropdownMenuLabel>
            {!loaded ? (
              <div className="flex flex-col gap-1 px-1 pb-1" aria-hidden>
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-10 w-full rounded-lg" />
                ))}
              </div>
            ) : error && entries.length === 0 ? (
              <p className="px-2 py-1.5 text-meta text-danger">{error}</p>
            ) : (
              entries.map((entry) => {
                const blocked = sopBlocked(entry)
                return (
                  <DropdownMenuRadioItem
                    key={entry.id}
                    value={entry.id}
                    closeOnClick
                    disabled={blocked !== null}
                    className="py-1.5 data-disabled:opacity-100"
                  >
                    <MenuGlyph icon={SOP_ICON} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className={blocked ? 'truncate text-tertiary' : 'truncate'}>
                        {sopName(entry)}
                      </span>
                      <span className="truncate text-meta text-tertiary">
                        {entry.sop ? stepChain(entry.sop) : t('newSession.sop.unreadableHint')}
                      </span>
                    </span>
                    {blocked && (
                      <span
                        className={
                          blocked === 'unreadable'
                            ? 'shrink-0 text-small text-danger'
                            : 'shrink-0 text-small text-warning'
                        }
                      >
                        {t(`newSession.sop.blocked.${blocked}`)}
                      </span>
                    )}
                  </DropdownMenuRadioItem>
                )
              })
            )}
          </DropdownMenuGroup>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => openMarketplace()}>
          <MenuGlyph icon={Store01Icon} />
          {t('newSession.sop.findMore')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * A task's place to work, shown and not chosen: in a Git project a task always gets a worktree of
 * its own, cut from the branch checked out.
 */
export function TaskWorktreeTag({ base }: { base: string | null }) {
  const { t } = useTranslation('session')
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="ui-as-tray-link kettu-tray-link--branch" data-static="" />}
      >
        <Glyph icon={WORKTREE_ICON} size={13} />
        <span className="kettu-tray-link__text">
          {base ? (
            <Trans
              t={t}
              i18nKey="worktree.newTrigger"
              values={{ branch: base }}
              components={{ name: <span className="font-mono" /> }}
            />
          ) : (
            t('worktree.new')
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent>{t('newSession.sop.worktreeHint')}</TooltipContent>
    </Tooltip>
  )
}

/** Under the composer, where the worktree's note is: where a task in a Git project works. */
export function TaskWorktreeNote({ base }: { base: string | null }) {
  const { t } = useTranslation('session')
  if (!base) return <p aria-hidden className={NOTE} />
  return (
    <p className={NOTE}>
      <Glyph icon={WORKTREE_ICON} size={12} className="shrink-0 text-icon" />
      <span className="min-w-0 truncate">
        <Trans
          t={t}
          i18nKey="newSession.sop.worktreeNote"
          components={{ base: <b className="font-medium" /> }}
          values={{ base }}
        />
      </span>
    </p>
  )
}

const NOTE = 'flex h-5 min-w-0 items-center gap-1.5 px-2.75 text-xs text-secondary'
