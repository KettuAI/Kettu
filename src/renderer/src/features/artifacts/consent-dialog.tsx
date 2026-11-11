import { useEffect, useState } from 'react'
import { Folder01Icon, SparklesIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { ArtifactConsentAsk } from '@shared/artifact-capabilities'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { Button } from '@renderer/components/ui/button'
import { toast } from '@renderer/components/ui/toast'
import { basename } from '@renderer/lib/format'
import { errorCode, errorMessage, hostAt } from '@renderer/lib/host'
import { onArtifactEvent } from '@renderer/stores/artifacts'
import { useProjectsStore } from '@renderer/stores/projects'

/** A host's question, with the host that asked: null for this computer. */
type Ask = ArtifactConsentAsk & { hostId: string | null }

function same(a: Pick<Ask, 'requestId' | 'hostId'>, b: Pick<Ask, 'requestId' | 'hostId'>): boolean {
  return a.requestId === b.requestId && a.hostId === b.hostId
}

/**
 * What an artifact's page asks to use, asked by Kettu outside the page: the host's question for
 * an artifact this window shows, one at a time. Another window or device answering it first, or
 * the artifact closing, takes it away.
 */
export function ArtifactConsentDialog() {
  const { t } = useTranslation('artifacts')
  const [asks, setAsks] = useState<Ask[]>([])
  const [busy, setBusy] = useState(false)
  const projects = useProjectsStore((s) => s.projects)

  useEffect(
    () =>
      onArtifactEvent((event, hostId) => {
        if (event.type === 'artifacts.consentAsked') {
          const ask = { ...event.ask, hostId }
          setAsks((list) => (list.some((a) => same(a, ask)) ? list : [...list, ask]))
        } else if (event.type === 'artifacts.consentSettled') {
          const settled = { requestId: event.requestId, hostId }
          setAsks((list) => list.filter((a) => !same(a, settled)))
        }
      }),
    [],
  )

  const ask = asks[0] ?? null
  const answer = async (allow: boolean): Promise<void> => {
    if (!ask || busy) return
    setBusy(true)
    try {
      await hostAt(ask.hostId, 'artifacts.consent', { requestId: ask.requestId, allow })
    } catch (error) {
      // Answered elsewhere first, which the settled event also says.
      if (errorCode(error) !== 'not_found') {
        toast(t('consent.failed', { error: errorMessage(error) }), undefined, { tone: 'warning' })
      }
    } finally {
      setAsks((list) => list.filter((a) => !same(a, ask)))
      setBusy(false)
    }
  }

  const project = ask
    ? (projects.find((p) => p.path === ask.project)?.name ?? basename(ask.project))
    : ''
  const agent = ask?.agent ?? t('consent.yourAgent')
  return (
    <AlertDialog open={ask !== null} onOpenChange={(open) => !open && void answer(false)}>
      <AlertDialogContent>
        {ask && (
          <>
            <AlertDialogHeader>
              <AlertDialogMedia>
                <HugeiconsIcon
                  aria-hidden
                  icon={ask.capability === 'files' ? Folder01Icon : SparklesIcon}
                  strokeWidth={1.9}
                />
              </AlertDialogMedia>
              <AlertDialogTitle>
                {ask.capability === 'files'
                  ? t('consent.filesTitle', { title: ask.title, project })
                  : t('consent.sampleTitle', { title: ask.title, agent })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {ask.capability === 'files'
                  ? t('consent.filesBody')
                  : t('consent.sampleBody', { agent })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>{t('consent.deny')}</AlertDialogCancel>
              <Button size="dialog" disabled={busy} onClick={() => void answer(true)}>
                {t('consent.allow')}
              </Button>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}
