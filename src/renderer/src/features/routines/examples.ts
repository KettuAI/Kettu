// The example routines the empty Routines page offers; each opens New routine filled in.

import type { PermissionScope, Schedule } from '@shared/routines'
import { i18n } from '@renderer/lib/i18n'

export const ROUTINE_EXAMPLES = [
  'triage',
  'tests',
  'dependencies',
  'changelog',
  'links',
  'review',
] as const

export type RoutineExampleId = (typeof ROUTINE_EXAMPLES)[number]

export interface RoutineExample {
  id: RoutineExampleId
  name: string
  prompt: string
  schedule: Schedule
  scope: PermissionScope
}

const WEEKDAYS = [1, 2, 3, 4, 5]
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]

/** Today's local midnight, which the six-hourly example is counted from. */
function midnight(): number {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function scheduleOf(id: RoutineExampleId): Schedule {
  switch (id) {
    case 'triage':
      return { kind: 'weekly', days: WEEKDAYS, time: '09:00' }
    case 'tests':
      return { kind: 'weekly', days: EVERY_DAY, time: '02:00' }
    case 'dependencies':
      return { kind: 'weekly', days: [1], time: '08:30' }
    case 'changelog':
      return { kind: 'weekly', days: [5], time: '17:00' }
    case 'links':
      return { kind: 'every', minutes: 360, from: midnight() }
    case 'review':
      return { kind: 'weekly', days: [0], time: '20:00' }
  }
}

function scopeOf(id: RoutineExampleId): PermissionScope {
  switch (id) {
    case 'tests':
      return { level: 'commands', web: false }
    case 'dependencies':
    case 'links':
      return { level: 'read', web: true }
    default:
      return { level: 'read', web: false }
  }
}

/** An example in the interface's language. */
export function routineExample(id: RoutineExampleId): RoutineExample {
  return {
    id,
    name: i18n.t(`routines:examples.${id}.name`),
    prompt: i18n.t(`routines:examples.${id}.prompt`),
    schedule: scheduleOf(id),
    scope: scopeOf(id),
  }
}
