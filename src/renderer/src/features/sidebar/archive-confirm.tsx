import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircleIcon } from '@hugeicons/core-free-icons'
import { AgentMark } from '@renderer/components/agents/agent-mark'
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
import { Button } from '@renderer/components/ui/button'
import { RingSpinner } from '@renderer/components/ui/spinner'
import { Glyph } from '@renderer/features/shell/glyph'
import { hostOfSession, sessionTitle } from '@renderer/stores/sessions'
import {
  useArchiveQuestion,
  type ArchiveAnswer,
  type ArchiveQuestion,
} from './archive-confirm-model'
import { RunningWorkList } from './running-work-list'

type SubSessionsQuestion = Extract<ArchiveQuestion, { kind: 'subSessions' }>

/** The sub-sessions archiving all would take, each with what it runs, in a sunk tray. */
function SubSessionList({ rows }: { rows: SubSessionsQuestion['subSessions'] }) {
  const { t } = useTranslation('sidebar')
  return (
    <ul className="mt-3 flex max-h-37 flex-col overflow-y-auto rounded-[9px] bg-subtle p-0.75 text-ui">
      {rows.map(({ summary, work }) => (
        <li key={summary.id} className="flex h-7 shrink-0 items-center gap-2 rounded-md px-2">
          <AgentMark agent={summary.agentId} hostId={hostOfSession(summary)} size={15} />
          <span className="min-w-0 flex-1 truncate">{sessionTitle(summary)}</span>
          {work && (
            <span className="flex shrink-0 items-center gap-1.5 text-small text-tertiary">
              {work.kind === 'turn' && <RingSpinner aria-hidden />}
              {t(`work.${work.kind}`, { count: work.count })}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

/**
 * The question `confirmArchive` asks, mounted once for the window: whether a session's
 * sub-sessions go with it, its two answers as the buttons, or what a decided archive stops.
 */
export function ArchiveConfirmDialog() {
  const { t } = useTranslation(['sidebar', 'common'])
  const question = useArchiveQuestion((s) => s.question)
  // The last question stays drawn while the dialog closes.
  const [shown, setShown] = useState<ArchiveQuestion | null>(null)
  if (question && question !== shown) setShown(question)
  const answer = (value: ArchiveAnswer | null) => {
    question?.answer(value)
    useArchiveQuestion.setState({ question: null })
  }
  return (
    <AlertDialog open={!!question} onOpenChange={(open) => !open && answer(null)}>
      <AlertDialogContent className="gap-0 px-5.5 pt-5 pb-4.5 data-[size=default]:sm:max-w-[440px]">
        {shown?.kind === 'subSessions' ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {shown.title === null
                  ? t('row.archiveTreeTitleCount', { count: shown.sessions })
                  : t('row.archiveTreeTitle', { title: shown.title })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t(shown.title === null ? 'row.archiveSubListCount' : 'row.archiveSubList', {
                  count: shown.subSessions.length,
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <SubSessionList rows={shown.subSessions} />
            {(shown.stops.alone || shown.stops.all) && (
              <p className="mt-2.5 flex gap-1.75 text-hint text-pretty text-(--shell-muted)">
                <Glyph icon={AlertCircleIcon} size={14} className="mt-0.5 text-warning" />
                {shown.stops.alone ? t('row.archiveStopsBoth') : t('row.archiveStopsAll')}
              </p>
            )}
            <AlertDialogFooter className="mt-4.5">
              <AlertDialogCancel variant="ghost" className="mr-auto text-secondary">
                {t('common:actions.cancel')}
              </AlertDialogCancel>
              <Button
                variant="outline"
                size="dialog"
                onClick={() => answer({ subSessions: false })}
              >
                {t('row.archiveAloneButton')}
              </Button>
              <AlertDialogAction
                variant={shown.stops.all ? 'destructive' : 'default'}
                onClick={() => answer({ subSessions: true })}
              >
                {shown.stops.all ? t('row.archiveAllStop') : t('row.archiveAll')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        ) : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('row.archiveRunningTitle')}</AlertDialogTitle>
              <AlertDialogDescription>{t('row.archiveRunningBody')}</AlertDialogDescription>
            </AlertDialogHeader>
            <RunningWorkList items={shown?.items ?? []} className="mt-3.5" />
            <AlertDialogFooter className="mt-4.5">
              <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => shown && answer(shown.decided)}
              >
                {t('row.archiveRunningConfirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}
