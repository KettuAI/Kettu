// Text in the user's language beside the same words in English, for what agents and logs read.

import { tEnglish, translate, type HostKey, type HostMessage } from './i18n'

type Params = Record<string, string | number>

/** Says a catalog message in one language. */
export type Say = (key: HostKey, params?: Params) => string

export const english: Say = (key, params) =>
  (tEnglish as (key: string, params?: Params) => string)(key, params)
export const user: Say = (key, params) => translate({ key, params })

/** An error with its message in the user's language and the same in English for logs. */
export class LocalizedError extends Error {
  readonly log: string

  constructor(message: HostMessage, options?: ErrorOptions) {
    super(translate(message), options)
    this.name = 'LocalizedError'
    this.log = english(message.key, message.params)
  }
}

/** The English text of an error for a log line: its `log` when it has one. */
export function logText(error: unknown): string {
  const log = (error as { log?: unknown } | null)?.log
  if (typeof log === 'string') return log
  return error instanceof Error ? error.message : String(error)
}
