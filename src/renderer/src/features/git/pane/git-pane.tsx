import { useEffect, useRef } from 'react'
import { Alert02Icon, GitCompareIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { emitAppEvent } from '@renderer/app/events'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import { useSessionView } from '@renderer/features/session/use-thread'
import { PaneBody, PaneContext, PaneEmpty, PaneIcon } from '@renderer/features/shell/panel-button'
import { cn } from '@renderer/lib/utils'
import {
  refreshGitProject,
  setGitPaneTab,
  useGitStore,
  type GitPaneTab,
} from '@renderer/stores/git'
import { panelSession } from '@renderer/stores/view'
import { PILL } from '../pr-part'
import { BADGE } from '../pr-text'
import { useChanges } from '../use-git-data'
import { ChangesPage } from './changes-page'
import { CommitBox } from './commit-box'
import { committable } from './commit-selection'
import { CommitsPage } from './commits-page'
import { Note } from './pane-ui'
import { PaneTools, PaneTop, SyncStrip } from './pane-top'
import { PullRequestPage } from './pr-page'

/**
 * The side panel's Git pane: the branch, where it stands against its remote, and three pages, the
 * working tree's changes with the commit box, the branch's commits and its pull request.
 */
export default function GitPane({ panel, projectPath }: { panel: string; projectPath: string }) {
  const { t } = useTranslation('git')
  const status = useGitStore((s) => s.status[projectPath])
  const pr = useGitStore((s) => s.currentPr[projectPath] ?? null)
  const gh = useGitStore((s) => s.tools?.gh.state ?? null)
  const tab = useGitStore((s) => s.paneTab[panel] ?? 'changes')
  const sessionId = panelSession(panel)
  const running = useSessionView(sessionId ?? '')?.status === 'running'
  const textarea = useRef<HTMLTextAreaElement>(null)
  const repo = !!status?.repo
  const changes = useChanges(projectPath, repo)

  // Opening the pane shows the repository as it is now, not as the last watch event left it.
  useEffect(() => {
    refreshGitProject(projectPath)
  }, [projectPath])

  const handOff = (text: string): void => {
    emitAppEvent({ kind: 'insert-into-composer', sessionId, text })
  }
  const files = changes.data
  const tickable = files ? committable(files).length : 0

  const body = !status ? (
    <Loading />
  ) : !status.repo ? (
    <PaneEmpty
      icon={<PaneIcon icon={GitCompareIcon} size={20} />}
      title={t('pane.notRepoTitle')}
      text={t('pane.notRepoText')}
    />
  ) : null

  return (
    <PaneBody data-git-pane={projectPath}>
      {body || !status ? (
        <div className="kp-body">{body}</div>
      ) : (
        <Tabs
          value={tab}
          onValueChange={(next) => setGitPaneTab(panel, next as GitPaneTab)}
          className="min-h-0 flex-1 gap-0"
        >
          <PaneContext tools={<PaneTools status={status} />}>
            <TabsList variant="line" className="h-full justify-start px-0 pt-0 pb-1.25">
              <TabsTrigger value="changes" className="flex-none">
                {t('pane.tab.changes')}
                {tickable > 0 && <span className="text-tertiary tabular">{tickable}</span>}
              </TabsTrigger>
              <TabsTrigger value="commits" className="flex-none">
                {t('pane.tab.commits')}
              </TabsTrigger>
              <TabsTrigger value="pr" className="flex-none">
                {t('pane.tab.pr')}
                {pr && (
                  <span className={cn(PILL, 'h-4 px-1.25 tabular', BADGE[pr.state])}>
                    #{pr.number}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>
          </PaneContext>
          <div className="flex min-h-0 flex-1 flex-col px-2.5 pt-2 pb-2.5">
            <PaneTop status={status} />
            {status.stale && (
              <div className="pb-2">
                <Note icon={Alert02Icon} tone="warn">
                  {t('pane.stale')}
                </Note>
              </div>
            )}
            <SyncStrip status={status} pr={pr} gh={gh} files={files} onHandOff={handOff} />
            <TabsContent value="changes" className={PAGE}>
              <ChangesPage panel={panel} status={status} changes={changes} textarea={textarea} />
            </TabsContent>
            <TabsContent value="commits" className={PAGE}>
              <CommitsPage status={status} />
            </TabsContent>
            <TabsContent value="pr" className={PAGE}>
              <PullRequestPage status={status} pr={pr} gh={gh} panel={panel} onHandOff={handOff} />
            </TabsContent>
            {tab === 'changes' && tickable > 0 && (
              <CommitBox
                status={status}
                files={files}
                panel={panel}
                textarea={textarea}
                agentRunning={running}
              />
            )}
          </div>
        </Tabs>
      )}
    </PaneBody>
  )
}

const PAGE = 'flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain pt-1'

function Loading() {
  return (
    <div className="flex flex-col gap-2.5 px-3.5" aria-busy="true">
      <Skeleton className="h-7 w-44" />
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-6 w-56" />
      <Skeleton className="h-32 w-full" />
    </div>
  )
}
