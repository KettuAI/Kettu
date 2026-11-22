import { useState } from 'react'
import { ArrowTurnBackwardIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { putBackRewound } from '@renderer/app/actions'
import { toast } from '@renderer/components/ui/toast'
import { Glyph } from '@renderer/features/shell/glyph'
import { errorMessage } from '@renderer/lib/host'

/**
 * The row on the box's upper edge after an edit from a message: how many turns went, and Put back,
 * which returns them and the draft the box held. It stays until the next message goes.
 */
export function RewoundHeader({ sessionId, turns }: { sessionId: string; turns: number }) {
  const { t } = useTranslation('composer')
  const [busy, setBusy] = useState(false)
  const putBack = () => {
    setBusy(true)
    putBackRewound(sessionId)
      .catch((error: unknown) =>
        toast(t('rewound.putBackFailed', { error: errorMessage(error) }), undefined, {
          tone: 'warning',
        }),
      )
      .finally(() => setBusy(false))
  }
  return (
    <div className="kettu-rewound animate-in fade-in animation-duration-(--duration-fast) motion-reduce:animate-none">
      <Glyph icon={ArrowTurnBackwardIcon} size={14} />
      <span className="min-w-0 flex-1 truncate">{t('rewound.turns', { count: turns })}</span>
      <button type="button" className="kettu-rewound__back" disabled={busy} onClick={putBack}>
        {t('rewound.putBack')}
      </button>
    </div>
  )
}
