import { translate, translateEnglish, type HostMessage } from '../i18n'

export type MemoryErrorCode = 'invalid' | 'secret' | 'full' | 'not_found' | 'conflict' | 'off'

/**
 * A refusal of Kettu's memory, whose message says why in words an agent or the user can act on.
 * A refusal a person can reach is given as a message to translate; `english` is for agents.
 */
export class MemoryError extends Error {
  readonly english: string

  constructor(
    readonly code: MemoryErrorCode,
    message: string | HostMessage,
  ) {
    super(typeof message === 'string' ? message : translate(message))
    this.english = typeof message === 'string' ? message : translateEnglish(message)
    this.name = 'MemoryError'
  }
}
