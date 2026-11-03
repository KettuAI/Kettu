import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { isAway, useOtherHost } from '@renderer/stores/hosts'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useWebHostStore } from '@renderer/stores/web-host'
import { answeredBy } from './helpers'

/**
 * The state of answering a waiting card: what is on its way, what failed, and whether the host is
 * out of reach, since an answer cannot reach a host that is not connected.
 */
export function useAnswering(sessionId: string) {
  const { t } = useTranslation('session')
  const hostId = useSessionsStore((s) => hostOfPath(s.byId[sessionId]?.projectPath ?? ''))
  const other = useOtherHost(hostId)
  const away = isAway(other?.connection ?? null)
  const served = useWebHostStore((s) => s.host?.name ?? null)
  const [answering, setAnswering] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  /** Sends the answer under `key`; false when it did not go, after saying why. */
  const send = async (key: string, request: () => Promise<void>): Promise<boolean> => {
    setAnswering(key)
    setError(null)
    try {
      await request()
      return true
    } catch (e) {
      const by = answeredBy(e)
      if (by !== undefined) {
        // The card turns into the first answer as its patch lands, so the note goes in a toast.
        const host = hostId !== null ? (other?.name ?? null) : served
        toast(
          by
            ? t('permission.answeredOn', { device: by.name })
            : host
              ? t('permission.answeredOn', { device: host })
              : t('permission.answeredInWindow'),
        )
      } else {
        setError(errorMessage(e))
      }
      setAnswering(null)
      return false
    }
  }

  return { answering, error, away, send }
}
