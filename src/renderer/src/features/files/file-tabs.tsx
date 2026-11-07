import { useEffect, useRef } from 'react'
import { DragDropProvider, type DragEndEvent } from '@dnd-kit/react'
import { isSortable, useSortable } from '@dnd-kit/react/sortable'
import { useTranslation } from 'react-i18next'
import { tabSensors } from '@renderer/components/tab-sensors'
import { PaneTabClose } from '@renderer/features/shell/panel-button'
import { closeFile, keepTab, moveTab, type OpenFile } from '@renderer/stores/files'
import { FileTypeIcon } from './file-type-icon'
import { folderOf, nameOf } from './paths'

/**
 * The project's open files as tabs, in the order the user left them; the preview tab's name is in
 * italics. `active` is null while something else, such as a commit's change, covers them.
 */
export function FileTabs({
  projectPath,
  files,
  active,
  onSelect,
}: {
  projectPath: string
  files: OpenFile[]
  active: string | null
  onSelect: (path: string) => void
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
    else if (event.nativeEvent?.type.startsWith('pointer')) onSelect(String(source.id))
  }

  return (
    <DragDropProvider sensors={tabSensors} onDragEnd={dragEnded}>
      <div role="tablist" aria-label={t('tabs.label')} className="flex items-center gap-0.5">
        {files.map((file, index) => (
          <FileTab
            key={file.path}
            projectPath={projectPath}
            file={file}
            index={index}
            selected={file.path === active}
            // Two tabs of one name tell themselves apart by their folder.
            folder={counts.get(nameOf(file.path))! > 1 ? nameOf(folderOf(file.path)) : ''}
            onSelect={() => onSelect(file.path)}
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
  onSelect,
}: {
  projectPath: string
  file: OpenFile
  index: number
  selected: boolean
  folder: string
  onSelect: () => void
}) {
  const { t } = useTranslation('files')
  const tab = useRef<HTMLButtonElement | null>(null)
  const { ref, handleRef, isDragging } = useSortable({ id: file.path, index })
  const name = nameOf(file.path)

  // A full strip scrolls; a tab selected out of sight, such as one a reference opens, comes into view.
  useEffect(() => {
    if (selected) tab.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [selected])

  return (
    <span
      ref={ref}
      className="kp-tab"
      data-selected={selected || undefined}
      data-dragging={isDragging || undefined}
      data-italic={file.preview || undefined}
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
        onClick={onSelect}
        onDoubleClick={() => keepTab(projectPath, file.path)}
        onAuxClick={(event) => event.button === 1 && closeFile(projectPath, file.path)}
        className="kp-tab__btn"
      >
        <FileTypeIcon path={file.path} className="size-3.5 shrink-0" />
        <span className="kp-tab__name">
          {name}
          {folder && <span className="kp-tab__note"> {folder}</span>}
        </span>
        {file.dirty && (
          <span
            role="img"
            aria-label={t('preview.unsaved')}
            className="kp-tab__dot"
            data-dot="unsaved"
          />
        )}
      </button>
      <PaneTabClose
        label={t('tabs.close', { name })}
        onClick={() => closeFile(projectPath, file.path)}
      />
    </span>
  )
}
