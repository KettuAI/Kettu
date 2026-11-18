import { useState } from 'react'
import { FolderAddIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { newSession, openProjectDialog } from '@renderer/app/actions'
import { HostFolderDialog } from '@renderer/features/session/new-session/host-folder-dialog'
import { Glyph } from '@renderer/features/shell/glyph'

/**
 * Open project at the end of a group's title: this computer's asks for a folder in the system's
 * dialog, as the menu does; another host's browses that host's folders. The project opens in a
 * new session either way.
 */
export function AddProjectButton({ hostId = null }: { hostId?: string | null }) {
  const { t } = useTranslation('sidebar')
  // Null until the host's folders are first asked for, so the dialog mounts only then.
  const [browsing, setBrowsing] = useState<boolean | null>(null)
  const label = t('nav.openProject')
  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        aria-label={label}
        title={label}
        onClick={() => (hostId === null ? void openProjectDialog() : setBrowsing(true))}
        className="ui-as-chat-row__tool kettu-add-project"
      >
        <Glyph icon={FolderAddIcon} size={15} />
      </button>
      {hostId !== null && browsing !== null && (
        <HostFolderDialog
          hostId={hostId}
          open={browsing}
          onOpenChange={setBrowsing}
          onOpened={(path) => {
            setBrowsing(false)
            newSession(path)
          }}
        />
      )}
    </>
  )
}
