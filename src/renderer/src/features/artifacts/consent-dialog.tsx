import { useEffect, useState } from 'react'
import { FolderIcon, SparkleIcon } from 'lucide-react'
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
import { errorCode, errorMessage, host } from '@renderer/lib/host'
import { useProjectsStore } from '@renderer/stores/projects'

/**
 * What an artifact's page asks to use, asked by Kettu outside the page: the host's question for
 * an artifact this window shows, one at a time. Another window or device answering it first, or
 * the artifact closing, takes it away.
 */
export function ArtifactConsentDialog() {
  const { t } = useTranslation('artifacts')
  const [asks, setAsks] = useState<ArtifactConsentAsk[]>([])
  const [busy, setBusy] = useState(false)
  const projects = useProjectsStore((s) => s.projects)

  useEffect(
    () =>
      window.kettu.agents.onEvent((event) => {
        if (event.type === 'artifacts.consentAsked') {
          setAsks((list) =>
            list.some((a) => a.requestId === event.ask.requestId) ? list : [...list, event.ask],
          )
        } else if (event.type === 'artifacts.consentSettled') {
          setAsks((list) => list.filter((a) => a.requestId !== event.requestId))
        }
      }),
    [],
  )

  const ask = asks[0] ?? null
  const answer = async (allow: boolean): Promise<void> => {
    if (!ask || busy) return
    setBusy(true)
    try {
      await host('artifacts.consent', { requestId: ask.requestId, allow })
    } catch (error) {
      // Answered elsewhere first, which the settled event also says.
      if (errorCode(error) !== 'not_found') {
        toast(t('consent.failed', { error: errorMessage(error) }), undefined, { tone: 'warning' })
      }
    } finally {
      setAsks((list) => list.filter((a) => a.requestId !== ask.requestId))
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
                {ask.capability === 'files' ? <FolderIcon /> : <SparkleIcon />}
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
