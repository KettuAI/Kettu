import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import { Popover } from '@base-ui/react/popover'
import { Cancel01Icon, DashboardSquare02Icon, Search01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { ArtifactSummary } from '@shared/artifacts'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { KIND_ICON } from '@renderer/features/artifacts/kinds'
import { artifactKind } from '@renderer/features/artifacts/model'
import { basename, mediumAgo } from '@renderer/lib/format'
import { menuCollisionPadding } from '@renderer/lib/platform'
import { useNow } from '@renderer/lib/use-now'
import { artifactListShown, artifactStanding, useArtifactsStore } from '@renderer/stores/artifacts'
import { useOverlayPresence } from '@renderer/stores/overlays'
import { useProjectsStore } from '@renderer/stores/projects'
import { openArtifact, openArtifactTab } from '@renderer/stores/view'
import {
  attachArtifactToDraft,
  removeAttachedArtifact,
  selectableArtifacts,
  toAttachedArtifact,
  useDraftArtifactAttachments,
  type AttachedArtifact,
} from './artifact-attachments'
import { moveHighlight } from './mentions'

const VIEWPORT_BOUNDARY: Element[] = []

/**
 * Removable chips for project artifacts attached to a composer draft, rendered above the input
 * matching the styling of existing selection and attachment chips.
 */
export function AttachedArtifactChips({
  draft,
  sessionId,
  onLeave,
}: {
  draft: string
  sessionId: string | null
  onLeave: () => void
}) {
  const { t } = useTranslation(['composer', 'artifacts'])
  const attached = useDraftArtifactAttachments(draft)
  const list = useArtifactsStore((s) => s.list)
  const hidden = useArtifactsStore((s) => s.hidden)
  const hasAttached = attached.length > 0

  useEffect(() => {
    if (!hasAttached) return
    artifactListShown(true)
    return () => artifactListShown(false)
  }, [hasAttached])

  const visible = useMemo(
    () => attached.filter((artifact) => !hidden.has(artifact.id)),
    [attached, hidden],
  )

  if (visible.length === 0) return null

  const open = (artifact: AttachedArtifact) => {
    if (artifactStanding(useArtifactsStore.getState(), artifact.id) === 'hidden') return
    if (sessionId) openArtifactTab(sessionId, artifact.id, { preview: true })
    else openArtifact(artifact.id)
  }

  return (
    <div
      role="list"
      aria-label={t('composer:artifacts.attachedLabel')}
      data-composer-own=""
      data-attached-artifacts=""
      className="flex w-full flex-wrap items-center gap-1.5 pb-1.5"
    >
      {visible.map((artifact) => {
        const live = list?.find((item) => item.id === artifact.id)
        const title = live?.title ?? artifact.title
        const kind = live ? artifactKind(live) : artifact.kind
        const kindLabel = t(`artifacts:page.kinds.${kind}`)
        return (
          <div
            key={artifact.id}
            role="listitem"
            className="flex h-6.5 max-w-60 min-w-0 animate-in items-center gap-1 rounded-lg bg-subtle pr-0.5 pl-2 text-small text-secondary shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)] transition-shadow duration-(--duration-fast) fade-in animation-duration-(--duration-fast) hover:shadow-[inset_0_0_0_var(--hairline)_var(--border-strong)]"
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={t('composer:artifacts.open', { title })}
                    onClick={() => open(artifact)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left outline-none transition-colors duration-(--duration-fast) hover:text-primary focus-ring"
                  />
                }
              >
                <HugeiconsIcon
                  aria-hidden
                  icon={KIND_ICON[kind]}
                  strokeWidth={1.9}
                  className="size-3.25 shrink-0 text-tertiary"
                />
                <span className="min-w-0 truncate">{title}</span>
              </TooltipTrigger>
              <TooltipContent>
                {title} · {kindLabel}
              </TooltipContent>
            </Tooltip>
            <button
              type="button"
              aria-label={t('composer:artifacts.remove', { title })}
              onClick={() => {
                removeAttachedArtifact(draft, artifact.id)
                onLeave()
              }}
              className="flex size-5.5 shrink-0 items-center justify-center rounded-md text-tertiary outline-none transition-colors duration-(--duration-fast) hover:bg-hover hover:text-secondary focus-ring"
            >
              <HugeiconsIcon
                aria-hidden
                icon={Cancel01Icon}
                strokeWidth={1.9}
                className="size-3.5"
              />
            </button>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Searchable popover for picking an existing project artifact from the composer's `+` menu.
 * Lists non-deleted artifacts for the target host and project (newest first), excluding ones
 * already attached to the draft.
 */
export function ArtifactPickerPopover({
  open,
  onOpenChange,
  anchor,
  draft,
  projectPath,
  noProject = false,
  hostId,
  onPicked,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  anchor: RefObject<HTMLDivElement | null>
  draft: string
  projectPath: string | null
  noProject?: boolean
  hostId: string | null
  onPicked: () => void
}) {
  const { t } = useTranslation(['composer', 'artifacts'])
  const list = useArtifactsStore((s) => s.list)
  const hostsRead = useArtifactsStore((s) => s.hostsRead)
  const awayList = useArtifactsStore((s) => (hostId ? s.awayLists[hostId] : undefined))
  const projects = useProjectsStore((s) => s.projects)
  const attached = useDraftArtifactAttachments(draft)
  const now = useNow()

  const [query, setQuery] = useState('')
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (open) setQuery('')
  }
  const [highlight, setHighlight] = useState({ key: '', index: 0 })
  const searchInput = useRef<HTMLInputElement>(null)
  const listId = useId()

  useOverlayPresence(open, { dismissible: true })

  // Keep artifact lists fresh while the picker is open (for both local and remote hosts).
  useEffect(() => {
    if (!open) return
    artifactListShown(true)
    return () => artifactListShown(false)
  }, [open])

  // Focus the search field once the popover opens after the '+' menu closes.
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => searchInput.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  const attachedIds = useMemo(() => new Set(attached.map((a) => a.id)), [attached])
  const sourceList = useMemo(() => {
    if (hostId !== null && !hostsRead.includes(hostId) && awayList) return awayList
    return list ?? []
  }, [hostId, hostsRead, awayList, list])

  const loading =
    hostId === null ? list === null : !hostsRead.includes(hostId) && awayList === undefined

  const selection = useMemo(
    () =>
      selectableArtifacts(sourceList, {
        projectPath,
        noProject,
        hostId,
        attachedIds,
        query,
      }),
    [sourceList, projectPath, noProject, hostId, attachedIds, query],
  )

  const rows = selection.items
  const listKey = `${query}\0${rows.length}`
  if (highlight.key !== listKey) setHighlight({ key: listKey, index: 0 })
  const active = rows.length === 0 ? -1 : Math.min(highlight.index, rows.length - 1)
  const optionId = (index: number) => `${listId}-${index}`

  useLayoutEffect(() => {
    if (open && active >= 0) {
      document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' })
    }
  }, [open, active, listId])

  const scopeLabel = noProject
    ? t('composer:artifacts.noProject')
    : projectPath
      ? (projects.find((p) => p.path === projectPath)?.name ?? basename(projectPath))
      : t('composer:artifacts.allProjects')

  const showProjectTag = !noProject && projectPath === null

  const choose = (artifact: ArtifactSummary) => {
    attachArtifactToDraft(draft, toAttachedArtifact(artifact, hostId))
    onOpenChange(false)
    onPicked()
  }

  const close = () => {
    onOpenChange(false)
    onPicked()
  }

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (rows.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      setHighlight({ key: listKey, index: moveHighlight(active, rows.length, event.key) })
      return
    }
    if (event.key === 'Enter' && active >= 0 && rows[active]) {
      event.preventDefault()
      choose(rows[active]!)
    }
  }

  const emptyMessage = query.trim()
    ? t('composer:artifacts.noMatch')
    : selection.scopeCount > 0 && selection.availableCount === 0
      ? t('composer:artifacts.allAttached')
      : projectPath && !noProject
        ? t('composer:artifacts.emptyProject')
        : t('composer:artifacts.empty')

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) onPicked()
      }}
    >
      <Popover.Portal>
        <Popover.Positioner
          anchor={anchor}
          side="top"
          align="start"
          sideOffset={10}
          collisionBoundary={VIEWPORT_BOUNDARY}
          collisionPadding={menuCollisionPadding}
          className="isolate z-(--layer-menu) outline-none app-region-no-drag"
        >
          <Popover.Popup
            data-overlay-layer=""
            data-artifact-picker=""
            initialFocus={searchInput}
            finalFocus={false}
            className="flex max-h-[min(var(--available-height),340px)] w-(--anchor-width) max-w-(--available-width) origin-(--transform-origin) flex-col overflow-hidden rounded-2xl bg-popover p-1.5 text-popover-foreground shadow-menu outline-none animation-duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          >
            <div className="flex items-center justify-between gap-2 px-2 pt-0.5 pb-1.5">
              <span className="flex min-w-0 items-center gap-1.5 text-small font-medium text-secondary">
                <HugeiconsIcon
                  aria-hidden
                  icon={DashboardSquare02Icon}
                  strokeWidth={1.9}
                  className="size-3.5 shrink-0 text-tertiary"
                />
                <span className="truncate">{t('composer:artifacts.pickerTitle')}</span>
              </span>
              <span className="max-w-40 truncate text-caption text-tertiary" title={scopeLabel}>
                {scopeLabel}
              </span>
            </div>

            <div className="relative mb-1.5 flex items-center px-1">
              <HugeiconsIcon
                aria-hidden
                icon={Search01Icon}
                strokeWidth={1.9}
                className="pointer-events-none absolute left-3 size-3.5 text-tertiary"
              />
              <input
                ref={searchInput}
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onSearchKeyDown}
                placeholder={t('composer:artifacts.searchPlaceholder')}
                aria-label={t('composer:artifacts.searchPlaceholder')}
                aria-controls={listId}
                aria-activedescendant={active >= 0 ? optionId(active) : undefined}
                className="h-7.5 w-full rounded-lg bg-subtle pr-7 pl-7.5 text-menu text-primary shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)] outline-none placeholder:text-tertiary focus:shadow-[inset_0_0_0_var(--hairline)_var(--border-strong)]"
              />
              {query && (
                <button
                  type="button"
                  aria-label={t('artifacts:page.clearFilter')}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setQuery('')}
                  className="absolute right-2.5 flex size-5 items-center justify-center rounded-sm text-tertiary hover:text-primary"
                >
                  <HugeiconsIcon
                    aria-hidden
                    icon={Cancel01Icon}
                    strokeWidth={1.9}
                    className="size-3"
                  />
                </button>
              )}
            </div>

            {loading ? (
              <div className="flex items-center gap-2 px-2.5 py-4 text-small text-tertiary">
                <Spinner className="size-3.5" />
                <span>{t('composer:artifacts.loading')}</span>
              </div>
            ) : rows.length === 0 ? (
              <div className="px-2.5 py-5 text-center text-small text-tertiary">{emptyMessage}</div>
            ) : (
              <div
                role="listbox"
                id={listId}
                aria-label={t('composer:artifacts.pickerTitle')}
                className="min-h-0 flex-1 scroll-fade-y overflow-y-auto overscroll-contain"
              >
                {rows.map((artifact, index) => {
                  const kind = artifactKind(artifact)
                  const highlighted = index === active
                  const projectName = showProjectTag
                    ? artifact.scratch
                      ? t('composer:artifacts.noProject')
                      : (projects.find((p) => p.path === artifact.project)?.name ??
                        basename(artifact.project))
                    : null
                  return (
                    <div
                      key={artifact.id}
                      role="option"
                      id={optionId(index)}
                      aria-selected={highlighted}
                      data-highlighted={highlighted ? '' : undefined}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseMove={() => {
                        if (index !== active) setHighlight({ key: listKey, index })
                      }}
                      onClick={() => choose(artifact)}
                      className="flex min-h-8.5 cursor-default items-center gap-2 rounded-lg px-2 py-1.25 text-menu outline-none select-none data-highlighted:bg-selected"
                    >
                      <HugeiconsIcon
                        aria-hidden
                        icon={KIND_ICON[kind]}
                        strokeWidth={1.9}
                        className="size-3.75 shrink-0 text-tertiary"
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-medium text-primary">{artifact.title}</span>
                        {projectName && (
                          <span className="truncate text-caption text-tertiary">{projectName}</span>
                        )}
                      </span>
                      <span className="shrink-0 text-caption tabular text-tertiary">
                        {mediumAgo(artifact.updatedAt, now)}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
