import { useState } from 'react'
import { RotateCwIcon, WalletIcon } from 'lucide-react'
import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import type { ConfigOption } from '@shared/thread'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { errorMessage, host } from '@renderer/lib/host'
import { fadeExit } from '@renderer/lib/motion'
import { splitName } from './levels'
import { modelOption, type Notice } from './use-out-of-credit'

/** The strip at the top of the composer's box after a turn the provider refused for want of credit. */
export function OutOfCreditStrip({
  sessionId,
  notice,
  config,
  onSwitchModel,
}: {
  sessionId: string
  notice: Notice
  config: readonly ConfigOption[]
  onSwitchModel: () => void
}) {
  const { t } = useTranslation(['composer', 'common'])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const option = modelOption(config)
  const name =
    notice.model &&
    splitName(option?.choices?.find((c) => c.value === notice.model)?.name ?? notice.model)[1]

  const retry = () => {
    setSending(true)
    setError(null)
    // Held after a success: the strip goes once the turn that starts reaches the replica.
    host('sessions.retry', { sessionId }).catch((e: unknown) => {
      setError(errorMessage(e))
      setSending(false)
    })
  }

  return (
    <motion.div
      exit={fadeExit}
      className="flex w-full animate-in flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-t-3xl border-b-(length:--hairline) border-default bg-subtle py-2 pr-2.5 pl-3.5 text-small fade-in animation-duration-(--duration-fast)"
    >
      <WalletIcon className="size-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-[1_1_12rem] text-primary">
        <p>{name ? t('outOfCredit.strip', { model: name }) : t('outOfCredit.stripNoModel')}</p>
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
      <div className="ml-auto flex shrink-0 gap-1.5">
        <Button size="xs" variant="outline" disabled={sending} onClick={retry}>
          {sending ? <Spinner className="size-3" /> : <RotateCwIcon />}
          {t('common:actions.retry')}
        </Button>
        {option && (
          <Button size="xs" variant="outline" onClick={onSwitchModel}>
            {t('outOfCredit.switchModel')}
          </Button>
        )}
      </div>
    </motion.div>
  )
}
