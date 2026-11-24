import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CommandRun } from '@shared/thread'

/**
 * Under a message that starts with one of Kettu's commands: where the command comes from, and
 * what was sent to the agent in its place, which opens from the line.
 */
export function SentCommandNote({ command }: { command: CommandRun }) {
  const { t } = useTranslation('session')
  const [open, setOpen] = useState(false)
  const source =
    command.origin.kind === 'plugin'
      ? t('userEntry.commandFrom', { source: command.origin.title })
      : t('userEntry.commandFromYours')
  return (
    <>
      <span className="ks-user__note flex items-center gap-1">
        <span className="truncate">{source}</span>
        <span aria-hidden>·</span>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((shown) => !shown)}
          className="shrink-0 rounded-sm underline-offset-2 outline-none hover:underline focus-visible:focus-ring"
        >
          {open ? t('userEntry.hideSent') : t('userEntry.showSent')}
        </button>
      </span>
      {open && (
        <div className="ks-user__sent" data-selectable="">
          {command.sent}
        </div>
      )}
    </>
  )
}
