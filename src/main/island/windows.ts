// How the island names a plan limit window: from its id and in the interface language, as the
// rest of the app does, and not by the label its agent wrote in English.

import type { PlanLimit } from '@shared/agent-host'
import { windowParts, type WindowParts } from '@shared/plan-limits'
import { planWindowT } from '../i18n'

type Window = Pick<PlanLimit, 'window' | 'label'>

/** A window's own name from one of the catalogs, without the model or group it counts. */
function windowName(
  parts: Pick<WindowParts, 'kind' | 'count'>,
  table: 'planWindow' | 'planWindowInText',
): string {
  const key = `${table}.${parts.kind}` as 'planWindow.five_hour'
  return parts.count === null ? planWindowT(key) : planWindowT(key, { count: parts.count })
}

/** A window's long name, for a row: "Weekly · Fable". A window Kettu has no name for keeps its label. */
export function limitLabel(limit: Window): string {
  const parts = windowParts(limit)
  if (!parts.kind) return limit.label
  const name = windowName(parts, 'planWindow')
  const long = parts.scope
    ? planWindowT('planWindow.scoped', { window: name, scope: parts.scope })
    : name
  return parts.provider ? `${parts.provider} · ${long}` : long
}

/** A window's name inside a sentence: "Fable weekly", which does not read as two windows. */
export function limitPhrase(limit: Window): string {
  const parts = windowParts(limit)
  if (!parts.kind || !parts.scope) return limitLabel(limit)
  return planWindowT('planWindowInText.scoped', {
    scope: parts.scope,
    window: windowName(parts, 'planWindowInText'),
  })
}
