import { useEffect, useRef } from 'react'
import { DragDropProvider, type DragEndEvent } from '@dnd-kit/react'
import { isSortable, useSortable } from '@dnd-kit/react/sortable'
import { XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ChangeStatus } from '@shared/git'
import { tabSensors } from '@renderer/components/tab-sensors'
import { cn } from '@renderer/lib/utils'
import { activateTab, closeFile, keepTab, moveTab, type OpenFile } from '@renderer/stores/files'
import { ChangeBadge } from './change-badge'
import { FileTypeIcon } from './file-type-icon'
import { folderOf, nameOf } from './paths'

/** The project's open files as tabs, in the order the user left them. */
export function FileTabs({
  projectPath,
  files,
  active,
  changes,
}: {
  projectPath: string
  files: OpenFile[]
  active: string
  changes: ReadonlyMap<string, ChangeStatus>
}) {
  const { t } = useTranslation('files')
  const counts = new Map<string, number>()
  for (const file of files) counts.set(nameOf(file.path), (counts.get(nameOf(file.path)) ?? 0) + 1)

  const dragEnded = (event: DragEndEvent) => {
    if (event.canceled) return
    const source = event.operation.source ?? null
    if (!isSortable(source)) return
    if (source.index !== source.initialIndex)
      moveTab(projectPath, source.initialIndex, source.index)
    // The sensor reads a press held for 200 ms as a drag and drops the click, so select here.
    else if (event.nativeEvent?.type.startsWith('pointer'))
      activateTab(projectPath, String(source.id))
  }

  return (
    <DragDropProvider sensors={tabSensors} onDragEnd={dragEnded}>
      <div
        role="tablist"
        aria-label={t('tabs.label')}
        className="no-scrollbar flex h-10 shrink-0 items-center gap-1 overflow-x-auto px-2 shadow-[inset_0_calc(-1*var(--hairline))_0_var(--border-subtle)]"
      >
        {files.map((file, index) => (
          <FileTab
            key={file.path}
            projectPath={projectPath}
            file={file}
            index={index}
            selected={file.path === active}
            // Two tabs of one name tell themselves apart by their folder.
            folder={counts.get(nameOf(file.path))! > 1 ? nameOf(folderOf(file.path)) : ''}
            change={changes.get(file.path)}
          />
        ))}
      </div>
    </DragDropProvider>
  )
}

function FileTab({
  projectPath,
  file,
  index,
  selected,
  folder,
  change,
}: {
  projectPath: string
  file: OpenFile
  index: number
  selected: boolean
  folder: string
  change: ChangeStatus | undefined
}) {
  const { t } = useTranslation('files')
  const tab = useRef<HTMLButtonElement | null>(null)
  const { ref, handleRef, isDragging } = useSortable({ id: file.path, index })
  const name = nameOf(file.path)
  // The close button takes the end of the tab it shows on; the unsaved dot waits in its place.
  const roomForEnd = selected || file.dirty

  // A full strip scrolls; a tab selected out of sight, such as one a reference opens, comes into view.
  useEffect(() => {
    if (selected) tab.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [selected])

  return (
    <div
      ref={ref}
      className={cn(
        'group/tab relative flex h-7 max-w-52 min-w-16 shrink-0 items-center rounded-lg text-hint transition-[color,background-color,box-shadow] duration-(--duration-fast)',
        selected || isDragging
          ? 'bg-raised text-primary shadow-segment'
          : 'text-tertiary hover:bg-hover hover:text-secondary',
      )}
    >
      <button
        ref={(element) => {
          tab.current = element
          handleRef(element)
        }}
        type="button"
        role="tab"
        aria-selected={selected}
        title={file.path}
        onClick={() => activateTab(projectPath, file.path)}
        onDoubleClick={() => keepTab(projectPath, file.path)}
        onAuxClick={(event) => event.button === 1 && closeFile(projectPath, file.path)}
        className={cn(
          'flex h-full min-w-0 flex-1 scroll-mx-2 items-center rounded-lg pl-2.5 outline-none focus-ring',
          roomForEnd ? 'pr-7.75' : 'pr-2.5',
        )}
      >
        {/* Another tab shows its close button on hover, over its end, which fades out under it. */}
        <span
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.75',
            !roomForEnd &&
              'group-focus-within/tab:mask-r-from-[calc(100%-26px)] group-focus-within/tab:mask-r-to-[calc(100%-14px)] group-hover/tab:mask-r-from-[calc(100%-26px)] group-hover/tab:mask-r-to-[calc(100%-14px)]',
          )}
        >
          <FileTypeIcon path={file.path} className="size-3.5 shrink-0" />
          <span className={cn('truncate', file.preview && 'italic')}>
            {name}
            {folder && <span className="ml-1.5 text-tertiary">{folder}</span>}
          </span>
          {change && <ChangeBadge status={change} className="ml-auto" />}
        </span>
      </button>
      {file.dirty && (
        <span
          role="img"
          aria-label={t('preview.unsaved')}
          className="absolute right-3 size-1.5 rounded-full bg-primary group-focus-within/tab:hidden group-hover/tab:hidden"
        />
      )}
      <button
        type="button"
        aria-label={t('tabs.close', { name })}
        onClick={() => closeFile(projectPath, file.path)}
        className={cn(
          'absolute right-1.5 flex size-4.5 items-center justify-center rounded-md text-tertiary opacity-0 outline-none transition-opacity duration-(--duration-fast) hover:bg-pressed-hover hover:text-primary focus-visible:opacity-100 focus-ring group-focus-within/tab:opacity-100 group-hover/tab:opacity-100',
          selected && !file.dirty && 'opacity-100',
        )}
      >
        <XIcon className="size-2.75" />
      </button>
    </div>
  )
}
