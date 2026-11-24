import { useEffect } from 'react'
import { PaneBody } from '@renderer/features/shell/panel-button'
import { openDiff, showOpenFile, useFilesStore } from '@renderer/stores/files'
import { shownDoc, useViewStore, type DocTab } from '@renderer/stores/view'
import { useFileChanges } from './changes'
import { DiffPreview } from './diff-preview'
import { FilePreview, Lines } from './file-preview'

// A change opened from its file's tab is a preview that goes right after that tab.
const BESIDE = { preview: true, fromPanel: true }

/** What the panel's selected file or diff tab shows. */
export default function DocPane({ projectPath, panel }: { projectPath: string; panel: string }) {
  const tab = useViewStore((s) => shownDoc(s, panel))
  if (tab?.kind === 'file') {
    return <FileDoc key={tab.id} projectPath={projectPath} panel={panel} tab={tab} />
  }
  if (tab?.kind === 'diff') {
    return (
      <PaneBody>
        <DiffPreview key={tab.id} projectPath={projectPath} tab={tab} />
      </PaneBody>
    )
  }
  return null
}

function FileDoc({
  projectPath,
  panel,
  tab,
}: {
  projectPath: string
  panel: string
  tab: Extract<DocTab, { kind: 'file' }>
}) {
  const file = useFilesStore((s) => s.open[projectPath]?.find((other) => other.path === tab.id))
  const changes = useFileChanges(projectPath)
  // Read as the tab shows: again after it was left, and after a restart brought it back.
  useEffect(() => {
    showOpenFile(projectPath, tab)
    // The tab's place in the preview slot does not change what it reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, tab.id])
  const change = tab.agent ? undefined : changes.list?.find((other) => other.path === tab.id)
  return (
    <PaneBody>
      <div className="kp-doc">
        {file ? (
          <FilePreview
            projectPath={projectPath}
            panel={panel}
            file={file}
            change={change?.file.status}
            onShowDiff={
              change
                ? () =>
                    openDiff(
                      projectPath,
                      {
                        path: change.file.path,
                        oldPath: change.file.oldPath,
                        ref: null,
                        projectFile: change.file.status === 'deleted' ? null : change.path,
                      },
                      BESIDE,
                    )
                : undefined
            }
          />
        ) : (
          <Lines />
        )}
      </div>
    </PaneBody>
  )
}
