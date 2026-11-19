// What a problem report's description starts with before any agent writes: the facts the place it
// was opened from already holds, in the user's language. Nothing here is guessed.

import type { ReportOrigin } from '@shared/report'

/** The error keeps its first lines, since all of it goes into the report beside the text. */
const ERROR_LINES = 3
const ERROR_CHARS = 400

export interface PrefillFacts {
  origin: ReportOrigin | null
  /** The name of the agent the failure was in, when the place knows it. */
  agent: string | null
  error: string | null
}

/** The catalog's text for a key of the `report` namespace. */
export type PrefillKey = `prefill.${ReportOrigin | 'turnOf' | 'shown'}`
export type PrefillText = (key: PrefillKey, values?: Record<string, string>) => string

/** The start of the error, on one to three lines. */
export function briefError(error: string): string {
  const lines = error
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, ERROR_LINES)
  const text = lines.join('\n')
  const chars = Array.from(text)
  return chars.length <= ERROR_CHARS ? text : `${chars.slice(0, ERROR_CHARS).join('')}…`
}

/** The description's first text, empty when the place the report opened from knows nothing. */
export function reportPrefill(facts: PrefillFacts, t: PrefillText): string {
  const error = facts.error === null ? '' : briefError(facts.error)
  let what = ''
  if (facts.origin === 'turn') {
    what = facts.agent === null ? t('prefill.turn') : t('prefill.turnOf', { agent: facts.agent })
  } else if (facts.origin !== null) {
    what = t(`prefill.${facts.origin}`)
  } else if (error !== '') {
    what = t('prefill.error')
  }
  if (error === '') return what
  return `${what}\n\n${t('prefill.shown', { error })}`
}
