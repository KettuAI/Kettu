import { useId, useState, type FormEvent, type KeyboardEvent } from 'react'
import {
  Cancel01Icon,
  Folder01Icon,
  FolderAddIcon,
  FolderMinusIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { Project, ProjectIcon } from '@shared/agent-host'
import { FolderClosedMark } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@renderer/components/ui/input-group'
import { Spinner } from '@renderer/components/ui/spinner'
import { HostFolderDialog } from '@renderer/features/session/new-session/host-folder-dialog'
import { Glyph } from '@renderer/features/shell/glyph'
import { basename } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { hostOfPath, hostPath } from '@renderer/lib/host-paths'
import { isWeb } from '@renderer/lib/platform'
import { isFolderMissing, projectFolders, useProjectsStore } from '@renderer/stores/projects'
import { chooseNewSessionProject, useViewStore } from '@renderer/stores/view'
import {
  removeSecondaryFolder,
  validateAdditionalFolder,
  type FolderValidationError,
} from './edit-project-model'
import { ProjectIconPicker } from './project-icon-picker'

/**
 * Edits a sidebar project's display name and its associated local source folders in one dialog.
 * Mounted lazily by the sidebar so only one instance exists for the window.
 */
export function EditProjectDialog({
  project,
  open,
  onOpenChange,
  onRequestRemove,
}: {
  project: Project
  open: boolean
  onOpenChange: (open: boolean) => void
  onRequestRemove: (project: Project) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-120">
        {open && (
          <EditProjectForm
            key={project.path}
            project={project}
            onClose={() => onOpenChange(false)}
            onRequestRemove={() => {
              onOpenChange(false)
              onRequestRemove(project)
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function EditProjectForm({
  project,
  onClose,
  onRequestRemove,
}: {
  project: Project
  onClose: () => void
  onRequestRemove: () => void
}) {
  const { t } = useTranslation(['sidebar', 'common'])
  const id = useId()
  const hostId = hostOfPath(project.path)
  const local = hostId === null
  const defaultName = basename(hostPath(project.path))
  const [name, setName] = useState(project.name)
  const [icon, setIcon] = useState<ProjectIcon | null>(() => project.icon ?? null)
  const [folders, setFolders] = useState<string[]>(() => projectFolders(project))
  const [typingPath, setTypingPath] = useState(false)
  const [pathDraft, setPathDraft] = useState('')
  const [browsing, setBrowsing] = useState(false)
  const [folderError, setFolderError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const formatValidationError = (error: FolderValidationError): string => {
    switch (error.kind) {
      case 'empty':
        return t('project.edit.errorEmptyPath')
      case 'notAbsolute':
        return t('project.edit.errorNotAbsolute')
      case 'duplicate':
        return t('project.edit.errorDuplicate')
      case 'otherProject':
        return t('project.edit.errorOtherProject', { name: error.name })
    }
  }

  const appendFolder = (raw: string): boolean => {
    const check = validateAdditionalFolder(
      raw,
      project,
      folders,
      useProjectsStore.getState().projects,
    )
    if (!check.ok) {
      setFolderError(formatValidationError(check.error))
      return false
    }
    setFolders((list) => [...list, check.path])
    setFolderError(null)
    setSubmitError(null)
    return true
  }

  const pickFolder = async () => {
    setFolderError(null)
    if (!local) {
      setBrowsing(true)
      return
    }
    if (isWeb) {
      setTypingPath(true)
      return
    }
    try {
      const picked = await window.kettu.dialogs.openProject()
      if (picked) appendFolder(picked)
    } catch (error) {
      setFolderError(errorMessage(error))
    }
  }

  const addTypedPath = () => {
    if (appendFolder(pathDraft)) {
      setPathDraft('')
      setTypingPath(false)
    }
  }

  const removeFolder = (target: string) => {
    setFolders((list) => removeSecondaryFolder(list, project.path, target))
    setFolderError(null)
    setSubmitError(null)
  }

  const save = async () => {
    if (saving) return
    setSaving(true)
    setSubmitError(null)
    const trimmedName = name.trim()
    try {
      const updated = await useProjectsStore.getState().update(project.path, {
        name: trimmedName === '' ? null : trimmedName,
        folders,
        icon,
      })
      // If New session currently targets a secondary folder that was just removed, fall back
      // to the project's primary folder so the composer stays pointing at this project.
      const kept = new Set(projectFolders(updated))
      const previous = projectFolders(project)
      const removed = previous.filter((folder) => !kept.has(folder))
      const selected = useViewStore.getState().projectPath
      if (selected && removed.includes(selected)) {
        chooseNewSessionProject(updated.path)
      }
      onClose()
    } catch (error) {
      setSubmitError(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const onPathKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      addTypedPath()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setTypingPath(false)
      setPathDraft('')
      setFolderError(null)
    }
  }

  return (
    <>
      <form
        className="contents"
        onSubmit={(event: FormEvent) => {
          event.preventDefault()
          void save()
        }}
      >
        <DialogHeader className="px-5.5 pt-5 pb-3">
          <DialogTitle>{t('project.edit.title')}</DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-col px-5.5 pb-4">
          <label htmlFor={`${id}-name`} className="mb-1.5 text-control font-medium text-primary">
            {t('project.edit.nameLabel')}
          </label>
          <InputGroup className="h-9.5 rounded-[10px]">
            <InputGroupAddon className="self-stretch cursor-default p-0 has-[>button]:ml-0">
              <ProjectIconPicker
                value={icon}
                disabled={saving}
                onChange={(next) => {
                  setIcon(next)
                  setSubmitError(null)
                }}
              />
            </InputGroupAddon>
            <InputGroupInput
              id={`${id}-name`}
              value={name}
              autoFocus
              disabled={saving}
              placeholder={defaultName}
              spellCheck={false}
              autoComplete="off"
              className="pl-2.5 text-control"
              onChange={(event) => {
                setName(event.target.value)
                setSubmitError(null)
              }}
            />
          </InputGroup>
          <p className="mt-1.5 text-small leading-normal text-tertiary">
            {t('project.edit.nameHint', { name: defaultName })}
          </p>

          <div className="mt-4.5 mb-1.5 flex items-baseline justify-between gap-2">
            <span className="text-control font-medium text-primary">
              {t('project.edit.foldersLabel')}
            </span>
          </div>
          <div className="overflow-hidden rounded-[10px] border border-border bg-card">
            <ul className="divide-y divide-border/70">
              {folders.map((folder) => {
                const isPrimary = folder === project.path
                const displayPath = hostPath(folder)
                const label = basename(displayPath)
                const missing = isFolderMissing(project, folder)
                return (
                  <li
                    key={folder}
                    className="flex items-center gap-2.5 px-3 py-2.5"
                    data-source-folder={folder}
                  >
                    <span className="shrink-0 text-secondary">
                      {isPrimary ? <FolderClosedMark /> : <Glyph icon={Folder01Icon} size={15} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-control font-medium text-primary">
                          {label}
                        </span>
                        {isPrimary && (
                          <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-tertiary">
                            {t('project.edit.primary')}
                          </span>
                        )}
                        {missing && (
                          <span className="shrink-0 text-[11px] font-medium text-danger">
                            {t('project.missing')}
                          </span>
                        )}
                      </div>
                      <p
                        className="truncate font-mono text-[11.5px] leading-snug text-tertiary"
                        title={displayPath}
                      >
                        {displayPath}
                      </p>
                    </div>
                    {!isPrimary && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        disabled={saving}
                        aria-label={t('project.edit.removeFolder', { name: label })}
                        onClick={() => removeFolder(folder)}
                        className="shrink-0 text-tertiary hover:text-primary"
                      >
                        <Glyph icon={Cancel01Icon} size={14} />
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>

            <div className="border-t border-border/70">
              {typingPath ? (
                <div className="flex items-center gap-1.5 px-2.5 py-2">
                  <Input
                    value={pathDraft}
                    autoFocus
                    disabled={saving}
                    placeholder={t('project.edit.pathPlaceholder')}
                    aria-label={t('project.edit.enterPath')}
                    spellCheck={false}
                    autoComplete="off"
                    className="h-7.5 min-w-0 flex-1 font-mono text-code"
                    onChange={(event) => {
                      setPathDraft(event.target.value)
                      setFolderError(null)
                    }}
                    onKeyDown={onPathKeyDown}
                  />
                  <Button
                    type="button"
                    size="xs"
                    disabled={saving || pathDraft.trim() === ''}
                    onClick={addTypedPath}
                  >
                    {t('project.edit.add')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    disabled={saving}
                    aria-label={t('common:actions.cancel')}
                    onClick={() => {
                      setTypingPath(false)
                      setPathDraft('')
                      setFolderError(null)
                    }}
                  >
                    <Glyph icon={Cancel01Icon} size={13} />
                  </Button>
                </div>
              ) : (
                <div className="flex items-center">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void pickFolder()}
                    className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2.5 text-left text-control text-secondary transition-colors hover:bg-muted/60 hover:text-primary disabled:pointer-events-none disabled:opacity-50"
                  >
                    <Glyph icon={FolderAddIcon} size={15} className="shrink-0" />
                    <span className="truncate">{t('project.edit.addFolder')}</span>
                  </button>
                  {local && !isWeb && (
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => {
                        setFolderError(null)
                        setTypingPath(true)
                      }}
                      className="shrink-0 border-l border-border/70 px-3 py-2.5 text-small text-tertiary transition-colors hover:bg-muted/60 hover:text-primary disabled:pointer-events-none disabled:opacity-50"
                    >
                      {t('project.edit.enterPath')}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          <p className="mt-1.5 text-small leading-normal text-tertiary">
            {t('project.edit.foldersHint')}
          </p>

          {(folderError || submitError) && (
            <p role="alert" className="mt-2 text-small leading-normal text-danger">
              {folderError ?? submitError}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 px-5.5 py-4 *:data-[slot=button]:h-7.5">
          <Button
            type="button"
            variant="ghost"
            size="compact"
            disabled={saving}
            onClick={onRequestRemove}
            className="text-danger hover:bg-destructive/10 hover:text-danger"
          >
            <Glyph icon={FolderMinusIcon} size={14} />
            {t('project.edit.removeProject')}
          </Button>
          <div className="flex items-center gap-2 *:data-[slot=button]:h-7.5">
            <DialogClose render={<Button type="button" variant="outline" size="compact" />}>
              {t('common:actions.cancel')}
            </DialogClose>
            <Button type="submit" size="compact" disabled={saving}>
              {saving && <Spinner data-icon="inline-start" />}
              {t('project.edit.save')}
            </Button>
          </div>
        </div>
      </form>

      {!local && (
        <HostFolderDialog
          hostId={hostId}
          open={browsing}
          onOpenChange={setBrowsing}
          pickOnly
          onOpened={(openedPath) => {
            setBrowsing(false)
            appendFolder(openedPath)
          }}
        />
      )}
    </>
  )
}
