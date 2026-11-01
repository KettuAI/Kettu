// Open project on another host: a browser of that host's folders, which lists only folders and
// marks Git repositories. The chosen folder becomes a project on that host; nothing is copied here.

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowUpIcon, FolderIcon, GitBranchIcon } from 'lucide-react'
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
import { Spinner } from '@renderer/components/ui/spinner'
import { errorMessage, hostAt } from '@renderer/lib/host'
import { onHost } from '@renderer/lib/host-paths'
import { cn } from '@renderer/lib/utils'
import { useOtherHost } from '@renderer/stores/hosts'
import { useProjectsStore } from '@renderer/stores/projects'
import { homeStart } from '@renderer/web/host-path'
import { crumbs, foldersOf, listing, parentOf, type HostFolder } from './host-folders'

type Read = { folder: string; completion: PathCompletion } | { folder: string; error: string }

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
      <DialogContent className="sm:max-w-[560px]">
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
  }, [hostId, folder, platform])

  const current = read && read.folder === folder ? read : null
  const completion = current && 'completion' in current ? current.completion : null
  const folders = completion ? foldersOf(completion, platform) : []
  const shownFolder = completion?.folder ?? folder
  const path = selected ?? (completion ? completion.folder : null)
  const parent = completion ? parentOf(completion.folder, platform) : null

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
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('newSession.hostFolders.title', { host: name })}</DialogTitle>
        <DialogDescription>
          {t('newSession.hostFolders.description', { host: name })}
        </DialogDescription>
      </DialogHeader>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={t('newSession.hostFolders.up')}
            disabled={!parent}
            onClick={() => parent && go(parent)}
          >
            <ArrowUpIcon />
          </Button>
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
                  className="shrink-0 px-[3px] text-primary"
                >
                  {crumb.name}
                </span>
              ) : (
                <span key={crumb.path} className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => go(crumb.path)}
                    className="rounded-xs px-[3px] outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {crumb.name}
                  </button>
                  {i > 0 && <span aria-hidden>{platform === 'win32' ? '\\' : '/'}</span>}
                </span>
              ),
            )}
          </nav>
        </div>
        <div
          ref={list}
          role="listbox"
          tabIndex={0}
          aria-label={t('newSession.hostFolders.list', {
            folder: crumbs(shownFolder, platform).at(-1)?.name ?? shownFolder,
          })}
          aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
          onKeyDown={onKeyDown}
          className="h-62 overflow-y-auto overscroll-contain rounded-lg p-1 shadow-[inset_0_0_0_var(--hairline)_var(--border)] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {!current ? (
            <div className="flex h-full items-center justify-center">
              <Spinner className="size-4 text-icon" />
            </div>
          ) : 'error' in current ? (
            <p className="flex h-full items-center justify-center px-6 text-center text-small text-danger">
              {current.error}
            </p>
          ) : folders.length === 0 ? (
            <p className="flex h-full items-center justify-center px-6 text-center text-small text-tertiary">
              {t('newSession.hostFolders.empty')}
            </p>
          ) : (
            folders.map((entry, i) => (
              <FolderRow
                key={entry.path}
                id={`${listId}-${i}`}
                entry={entry}
                selected={entry.path === selected}
                onSelect={() => setSelected(entry.path)}
                onEnter={() => go(entry.path)}
              />
            ))
          )}
        </div>
        {failed ? (
          <p role="alert" className="text-xs text-danger">
            {failed}
          </p>
        ) : (
          <p className="text-xs text-tertiary">
            {t('newSession.hostFolders.note', { host: name })}
            {path && (
              <>
                {' '}
                <code className="font-mono text-xs break-all text-primary">{path}</code>
              </>
            )}
          </p>
        )}
      </div>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>
          {t('common:actions.cancel')}
        </DialogClose>
        <Button disabled={!path || opening || !completion} onClick={() => void openProject()}>
          {opening && <Spinner data-icon="inline-start" />}
          {t('newSession.hostFolders.open')}
        </Button>
      </DialogFooter>
    </>
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
      onClick={onSelect}
      onDoubleClick={onEnter}
      className={cn(
        'flex h-row cursor-default items-center gap-[9px] rounded-md px-2.5 text-ui select-none',
        selected ? 'bg-selected' : 'hover:bg-hover',
      )}
    >
      <FolderIcon aria-hidden className="size-4 shrink-0 text-icon" />
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      {entry.repo && (
        <span className="inline-flex shrink-0 items-center gap-1 text-xs text-tertiary">
          <GitBranchIcon aria-hidden className="size-3" />
          {t('newSession.hostFolders.repo')}
        </span>
      )}
    </div>
  )
}
