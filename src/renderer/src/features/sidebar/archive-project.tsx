import { useEffect, useState } from 'react'
import { Archive01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { Project } from '@shared/agent-host'
import { archiveProject, unarchiveProject } from '@renderer/app/actions'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { findProjectForSession, useProjectsStore } from '@renderer/stores/projects'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useHostLabel } from './host-label'
import { workAtStake, type WorkItem } from './running-work'
import { RunningWorkList } from './running-work-list'
import { isRunning } from './session-menu-model'

/**
 * Confirms before archiving a project: it hides the project from the sidebar while keeping all of
 * its sessions and history in Settings > Archived, and stops any running work in its sessions.
 */
export function ArchiveProjectDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation(['sidebar', 'common'])
  const hostId = hostOfPath(project.path)
  const hostName = useHostLabel(hostId)
  const projects = useProjectsStore((s) => s.projects)
  const [sessions, running, sessionIdsKey] = useSessionsStore(
    useShallow((s) => {
      const own = Object.values(s.byId).filter(
        (x) =>
          !x.scratch &&
          x.origin !== 'subagent' &&
          !x.prepared &&
          findProjectForSession(projects, x)?.path === project.path,
      )
      // Return only primitives so useShallow's top-level comparison stays stable across renders.
      return [
        own.length,
        own.filter(isRunning).length,
        own
          .map((x) => x.id)
          .sort()
          .join('\n'),
      ] as const
    }),
  )
  const [workState, setWorkState] = useState<{ key: string; items: WorkItem[] }>({
    key: '',
    items: [],
  })

  useEffect(() => {
    if (!open || !sessionIdsKey) return
    const ids = sessionIdsKey.split('\n')
    let cancelled = false
    void workAtStake(ids)
      .then((items) => {
        if (!cancelled) setWorkState({ key: sessionIdsKey, items })
      })
      .catch(() => {
        if (!cancelled) setWorkState({ key: sessionIdsKey, items: [] })
      })
    return () => {
      cancelled = true
    }
  }, [open, sessionIdsKey])

  const work = open && sessionIdsKey && workState.key === sessionIdsKey ? workState.items : []
  const stopsRunning = running > 0 || work.length > 0

  const archive = async () => {
    onOpenChange(false)
    try {
      await archiveProject(project.path)
      toast(
        t('project.archive.archived', { name: project.name }),
        {
          label: t('row.undo'),
          onClick: () => {
            void unarchiveProject(project.path).catch((error: unknown) =>
              toast(errorMessage(error)),
            )
          },
        },
        { icon: Archive01Icon },
      )
    } catch (error) {
      toast(errorMessage(error))
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="gap-3.5 px-5.5 data-[size=default]:sm:max-w-[440px]">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('project.archive.title', { name: project.name })}</AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogDescription className="text-small text-tertiary">
          {[
            sessions > 0
              ? t('project.archive.sessions', { count: sessions })
              : t('project.archive.noSessions'),
            running > 0 && work.length === 0 && t('project.archive.running', { count: running }),
            !project.missing &&
              (hostId === null
                ? t('project.archive.folderStays')
                : t('project.archive.folderStaysOn', { host: hostName })),
          ]
            .filter(Boolean)
            .join(t('project.archive.separator'))}
        </AlertDialogDescription>
        {work.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <p className="text-small text-secondary">{t('project.archive.runningWork')}</p>
            <RunningWorkList items={work} />
          </div>
        )}
        <AlertDialogFooter className="pt-1">
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant={stopsRunning ? 'destructive' : 'default'}
            onClick={() => void archive()}
          >
            {stopsRunning ? t('project.archive.confirmStop') : t('project.archive.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
