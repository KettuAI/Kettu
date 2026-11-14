import { PlayIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { Trans, useTranslation } from 'react-i18next'
import { revealTerminal, useTerminalsStore } from '@renderer/stores/terminals'

/**
 * The message a code block's run sent the agent, as one line in the user's bubble: the command,
 * which opens its terminal while the terminal is there.
 */
export function ReplyRunChip({ terminalId, command }: { terminalId: string; command: string }) {
  const { t } = useTranslation('session')
  const alive = useTerminalsStore((s) => {
    const terminal = s.byId[terminalId]
    return terminal !== undefined && !terminal.stale
  })
  const lines = command.split('\n')
  return (
    <button
      type="button"
      className="ks-run-chip"
      disabled={!alive}
      title={alive ? t('command.chipOpen') : t('command.chipGone')}
      onClick={() => revealTerminal(terminalId)}
    >
      <HugeiconsIcon icon={PlayIcon} strokeWidth={1.9} aria-hidden className="ks-run-chip__icon" />
      <span className="ks-run-chip__text">
        <Trans
          t={t}
          i18nKey="command.chip"
          values={{ command: lines[0] }}
          components={{ code: <code /> }}
        />
      </span>
      {lines.length > 1 && (
        <span className="ks-run-chip__more">
          {t('command.chipMore', { count: lines.length - 1 })}
        </span>
      )}
    </button>
  )
}
