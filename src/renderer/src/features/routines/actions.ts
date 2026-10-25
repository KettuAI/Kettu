// What the routines pages do beyond a single request, such as copying a routine.

import { ROUTINE_NAME_CHARS, type RoutineView } from '@shared/routines'
import { i18n } from '@renderer/lib/i18n'
import { useRoutinesStore } from '@renderer/stores/routines'
import { openRoutine } from '@renderer/stores/view'

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
