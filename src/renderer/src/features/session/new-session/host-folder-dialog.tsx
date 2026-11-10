// Open project on another host: a browser of that host's folders, which lists only folders and
// marks Git repositories. The chosen folder becomes a project on that host; nothing is copied here.

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import {
  AlertCircleIcon,
  ArrowRight01Icon,
  ArrowUp02Icon,
  GitBranchIcon,
  InformationCircleIcon,
  ReloadIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { Platform } from '@shared/platform'
import type { PathCompletion } from '@shared/remote/host-admin'
import { FolderClosedMark } from '@renderer/components/affect/app-shell'
import { FolderMark } from '@renderer/components/affect/assistant-home'
import { GlideHighlight } from '@renderer/components/glide-highlight'
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
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@renderer/components/ui/empty'
import { Kbd } from '@renderer/components/ui/kbd'
import { Separator } from '@renderer/components/ui/separator'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { HostIcon } from '@renderer/features/settings/remote-parts'
import { Glyph } from '@renderer/features/shell/glyph'
import { errorMessage, hostAt } from '@renderer/lib/host'
import { onHost } from '@renderer/lib/host-paths'
import { cn } from '@renderer/lib/utils'
import { useOtherHost } from '@renderer/stores/hosts'
import { useProjectsStore } from '@renderer/stores/projects'
import { homeStart, separator } from '@renderer/web/host-path'
import { crumbs, foldersOf, listing, parentOf, type HostFolder } from './host-folders'

type Read = { folder: string; completion: PathCompletion } | { folder: string; error: string }

// The widths of the placeholder rows while a folder is read.
const SKELETON_WIDTHS = ['w-2/5', 'w-3/5', 'w-1/3', 'w-2/3', 'w-1/2', 'w-2/5', 'w-7/12']

export function HostFolderDialog({
  hostId,
  open,
  onOpenChange,
  onOpened,
}: {
  hostId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The project added on the host, by the path the window names it with. */
  onOpened: (projectPath: string) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="@container gap-0 overflow-hidden p-0 sm:max-w-[560px]">
        {hostId && <Browser key={hostId} hostId={hostId} onOpened={onOpened} />}
      </DialogContent>
    </Dialog>
  )
}

function Browser({ hostId, onOpened }: { hostId: string; onOpened: (path: string) => void }) {
  const { t } = useTranslation(['session', 'common'])
  const host = useOtherHost(hostId)
  const platform = host?.platform ?? 'linux'
  const name = host?.name ?? ''
  const listId = useId()
  // The home folder, as `~` until the host's answer says where it is.
  const [folder, setFolder] = useState(() => homeStart(platform))
  const [read, setRead] = useState<Read | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const trail = useRef<HTMLElement>(null)

  useEffect(() => {
    let live = true
    hostAt(hostId, 'paths.complete', { path: listing(folder, platform) }).then(
      (completion) => live && setRead({ folder, completion }),
      (error: unknown) => live && setRead({ folder, error: errorMessage(error) }),
    )
    return () => {
      live = false
    }
  }, [hostId, folder, platform, attempt])

  const current = read && read.folder === folder ? read : null
  const completion = current && 'completion' in current ? current.completion : null
  const folders = completion ? foldersOf(completion, platform) : []
  const shownFolder = completion?.folder ?? folder
  const path = selected ?? (completion ? completion.folder : null)
  // A folder that cannot be read still has a parent to go back to.
  const parent = completion
    ? parentOf(completion.folder, platform)
    : current
      ? parentOf(folder, platform)
      : null

  // A deep path keeps its end, the folder shown, in view.
  useEffect(() => {
    const nav = trail.current
    if (nav) nav.scrollLeft = nav.scrollWidth
  }, [shownFolder])

  const go = (next: string) => {
    setSelected(null)
    setFailed(null)
    setFolder(next)
    list.current?.focus()
  }

  const retry = () => {
    setRead(null)
    setAttempt((n) => n + 1)
  }

  const openProject = async () => {
    if (!path || opening) return
    setOpening(true)
    setFailed(null)
    try {
      const project = await useProjectsStore.getState().add(onHost(hostId, path))
      onOpened(project.path)
    } catch (error) {
      setFailed(errorMessage(error))
      setOpening(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = folders.findIndex((f) => f.path === selected)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (folders.length === 0) return
      const next =
        event.key === 'ArrowDown'
          ? Math.min(folders.length - 1, at + 1)
          : at < 0
            ? folders.length - 1
            : Math.max(0, at - 1)
      setSelected(folders[next]!.path)
      document.getElementById(`${listId}-${next}`)?.scrollIntoView({ block: 'nearest' })
    } else if (event.key === 'Enter' && selected) {
      event.preventDefault()
      go(selected)
    } else if (event.key === 'Backspace' && parent) {
      event.preventDefault()
      go(parent)
    }
  }

  const activeIndex = folders.findIndex((f) => f.path === selected)
  const note = t('newSession.hostFolders.note', { host: name })
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-48 bg-[radial-gradient(180px_100px_at_40px_36px,color-mix(in_srgb,var(--control-on)_13%,transparent),transparent)]"
      />
      <DialogHeader className="flex-row items-start gap-3.5 px-5 pt-5 pr-12 pb-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-(--shell-logo-bg) text-primary shadow-card">
          <HostIcon platform={platform} className="size-5" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <DialogTitle>{t('newSession.hostFolders.title', { host: name })}</DialogTitle>
          <DialogDescription>
            {t('newSession.hostFolders.description', { host: name })}
          </DialogDescription>
        </div>
      </DialogHeader>
      <div className="px-5 pb-4">
        <div className="flex h-9 items-center rounded-xl bg-card px-1 shadow-outline">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('newSession.hostFolders.up')}
            disabled={!parent}
            onClick={() => parent && go(parent)}
          >
            <Glyph icon={ArrowUp02Icon} />
          </Button>
          <Separator orientation="vertical" className="mx-1.5 h-4 data-vertical:self-center" />
          <nav
            ref={trail}
            aria-label={t('newSession.hostFolders.location')}
            className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto scroll-fade-x font-mono text-xs whitespace-nowrap text-tertiary"
          >
            {crumbs(shownFolder, platform).map((crumb, i, all) =>
              i === all.length - 1 ? (
                <span
                  key={crumb.path}
                  aria-current="location"
                  className="shrink-0 px-1.5 font-medium text-primary"
                >
                  {crumb.name}
                </span>
              ) : (
                <span key={crumb.path} className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => go(crumb.path)}
                    className="rounded-md px-1.5 py-0.5 outline-none hover:bg-hover hover:text-primary focus-ring"
                  >
                    {crumb.name}
                  </button>
                  {i > 0 && <span aria-hidden>{platform === 'win32' ? '\\' : '/'}</span>}
                </span>
              ),
            )}
          </nav>
        </div>
      </div>
      <div className="flex h-7 items-center justify-between gap-3 px-6 text-hint text-tertiary">
        <span className="inline-flex items-center gap-1.5">
          {t('newSession.hostFolders.folders')}
          {completion && <span className="tabular-nums">{folders.length}</span>}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={note}
                  className="grid size-4 place-items-center rounded-full outline-none hover:text-primary focus-ring"
                />
              }
            >
              <Glyph icon={InformationCircleIcon} size={13} />
            </TooltipTrigger>
            <TooltipContent>{note}</TooltipContent>
          </Tooltip>
        </span>
        {folders.length > 0 && (
          <span className="hidden items-center gap-3.5 @md:inline-flex">
            <span className="inline-flex items-center gap-1.5">
              <Kbd>↵</Kbd>
              {t('newSession.hostFolders.goIn')}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Kbd>⌫</Kbd>
              {t('newSession.hostFolders.goUp')}
            </span>
          </span>
        )}
      </div>
      <div
        ref={list}
        role="listbox"
        tabIndex={0}
        aria-label={t('newSession.hostFolders.list', {
          folder: crumbs(shownFolder, platform).at(-1)?.name ?? shownFolder,
        })}
        aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
        aria-busy={!current || opening}
        onKeyDown={onKeyDown}
        className={cn(
          'relative mx-5 h-68 overflow-y-auto overscroll-contain rounded-xl bg-(--tray) p-1 shadow-sunk outline-none [--tray:var(--bg-subtle)] focus-ring dark:[--tray:var(--bg-app)]',
          opening && 'pointer-events-none opacity-60',
        )}
      >
        {!current ? (
          SKELETON_WIDTHS.map((width, i) => (
            <div key={i} className="flex h-9 items-center gap-2.5 px-2.5">
              <Skeleton className="size-6.5 rounded-md bg-selected" />
              <Skeleton className={cn('h-2.5 rounded-full bg-selected', width)} />
            </div>
          ))
        ) : 'error' in current ? (
          <Empty className="h-full border-0 p-6">
            <EmptyHeader>
              <EmptyMedia variant="icon" className="text-danger">
                <Glyph icon={AlertCircleIcon} />
              </EmptyMedia>
              <EmptyTitle className="text-control">{current.error}</EmptyTitle>
              <EmptyDescription>{t('newSession.hostFolders.errorHint')}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" size="dialog" onClick={retry}>
                <Glyph icon={ReloadIcon} data-icon="inline-start" />
                {t('newSession.hostFolders.retry')}
              </Button>
            </EmptyContent>
          </Empty>
        ) : folders.length === 0 ? (
          <Empty className="h-full border-0 p-6">
            <EmptyHeader>
              <EmptyMedia className="size-14 [&_svg]:size-full!">
                <FolderMark />
              </EmptyMedia>
              <EmptyTitle className="text-control">{t('newSession.hostFolders.empty')}</EmptyTitle>
              <EmptyDescription>{t('newSession.hostFolders.emptyHint')}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <GlideHighlight className="bg-raised shadow-raised" />
            {folders.map((entry, i) => (
              <FolderRow
                key={entry.path}
                id={`${listId}-${i}`}
                entry={entry}
                selected={entry.path === selected}
                onSelect={() => setSelected(entry.path)}
                onEnter={() => go(entry.path)}
              />
            ))}
          </>
        )}
      </div>
      <DialogFooter className="flex-row items-center justify-between gap-3 px-5 pt-4 pb-5 sm:justify-between">
        {failed ? (
          <p role="alert" className="flex min-w-0 items-center gap-1.5 text-xs text-danger">
            <Glyph icon={AlertCircleIcon} size={14} className="shrink-0" />
            <span className="truncate">{failed}</span>
          </p>
        ) : (
          <Target path={path ?? shownFolder} platform={platform} dim={!path} />
        )}
        <div className="flex shrink-0 gap-1.5">
          <DialogClose render={<Button variant="outline" size="dialog" />}>
            {t('common:actions.cancel')}
          </DialogClose>
          <Button
            size="dialog"
            disabled={!path || opening || !completion}
            onClick={() => void openProject()}
          >
            {opening && <Spinner data-icon="inline-start" />}
            {t('newSession.hostFolders.open')}
          </Button>
        </div>
      </DialogFooter>
    </>
  )
}

/** What Open will open: the folder's own name in ink, the path above it quiet and cut at its start. */
function Target({ path, platform, dim }: { path: string; platform: Platform; dim: boolean }) {
  const { t } = useTranslation('session')
  const sep = separator(platform)
  const cut = path.lastIndexOf(sep, path.length - 2) + 1
  const head = path.slice(0, cut)
  const tail = path.slice(cut)
  return (
    <div
      className={cn('flex min-w-0 items-center gap-2 text-hint text-tertiary', dim && 'opacity-50')}
    >
      <span className="hidden shrink-0 @md:inline">{t('newSession.hostFolders.opens')}</span>
      <code className="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-lg bg-(--tray) pr-2.5 pl-1.5 font-mono text-xs shadow-sunk [--tray:var(--bg-subtle)] dark:[--tray:var(--bg-app)]">
        <span className="size-4.5 shrink-0 [&_svg]:size-full!">
          <FolderClosedMark />
        </span>
        <span className="min-w-0 truncate text-left direction-rtl">
          <bdo dir="ltr">
            {head}
            <b className="font-medium text-primary">{tail}</b>
          </bdo>
        </span>
      </code>
    </div>
  )
}

function FolderRow({
  id,
  entry,
  selected,
  onSelect,
  onEnter,
}: {
  id: string
  entry: HostFolder
  selected: boolean
  onSelect: () => void
  onEnter: () => void
}) {
  const { t } = useTranslation('session')
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      // The list's glide highlight draws on the row marked so.
      data-highlighted={selected ? '' : undefined}
      onClick={onSelect}
      onDoubleClick={onEnter}
      className="group/row relative flex h-9 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-ui select-none not-data-highlighted:hover:bg-hover"
    >
      <span className="relative size-6.5 shrink-0 [&_svg]:size-full!">
        <FolderClosedMark />
        {entry.repo && (
          <span
            role="img"
            aria-label={t('newSession.hostFolders.repo')}
            className="absolute top-[62%] left-1/2 -translate-x-1/2 -translate-y-1/2 text-(--on-fill)"
          >
            <HugeiconsIcon
              icon={GitBranchIcon}
              size={12}
              strokeWidth={2}
              color="currentColor"
              aria-hidden
            />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      {entry.repo && (
        <span className="shrink-0 text-small text-tertiary opacity-0 group-hover/row:opacity-100 group-data-highlighted/row:opacity-100">
          {t('newSession.hostFolders.repo')}
        </span>
      )}
      <Glyph
        icon={ArrowRight01Icon}
        size={13}
        className="shrink-0 text-tertiary opacity-0 group-hover/row:opacity-100 group-data-highlighted/row:opacity-100"
      />
    </div>
  )
}
