// What the routines pages do beyond a single request, such as copying a routine.

import type { SessionSummary } from '@shared/agent-host'
import { ROUTINE_NAME_CHARS, type RoutineView } from '@shared/routines'
import { i18n } from '@renderer/lib/i18n'
import { useRoutinesStore } from '@renderer/stores/routines'
import { useSessionsStore } from '@renderer/stores/sessions'
import { openRoutine, openSession } from '@renderer/stores/view'

/** A copy of the routine, on, opened at its page. */
export async function duplicateRoutine(routine: RoutineView): Promise<void> {
  const name = i18n
    .t('routines:routine.copyName', { name: routine.name })
    .slice(0, ROUTINE_NAME_CHARS)
  const copy = await useRoutinesStore.getState().create({
    name,
    prompt: routine.prompt,
    agentId: routine.agentId,
    projectPath: routine.projectPath,
    options: routine.options,
    trigger: routine.trigger,
    scope: routine.scope,
    timeLimitMinutes: routine.timeLimitMinutes,
  })
  openRoutine(copy.id)
}

/**
 * Opens the session of the routine's run at work. The session list leaves out routine runs, so a
 * window that did not see the run start finds its session among the routine's runs.
 */
export async function openActiveRun(routine: RoutineView): Promise<void> {
  const run = routine.activeRun
  if (!run?.sessionId) return
  const fromRuns = () =>
    useRoutinesStore.getState().runs[routine.id]?.items.find((item) => item.id === run.id)
      ?.session ?? null
  let session: SessionSummary | null = useSessionsStore.getState().byId[run.sessionId] ?? fromRuns()
  if (!session) {
    await useRoutinesStore.getState().loadRuns(routine.id)
    session = fromRuns()
  }
  if (!session) throw new Error(i18n.t('routines:routine.openRunFailed'))
  useSessionsStore.getState().upsert(session)
  openSession(session.id, session.projectPath)
}
