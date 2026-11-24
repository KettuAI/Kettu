import type { TFunction } from 'i18next'
import type { SlashCommand } from '@shared/thread'

const NONE: SlashCommand[] = []

/**
 * The commands the app runs itself, which never reach the agent: `/btw` asks the side chat what
 * follows it, beside the turn, so it is there only for a session that has one.
 */
export function builtinCommands(sideChat: boolean, t: TFunction<'composer'>): SlashCommand[] {
  return sideChat
    ? [{ name: 'btw', description: t('attachments.btw'), source: { kind: 'kettu' } }]
    : NONE
}
