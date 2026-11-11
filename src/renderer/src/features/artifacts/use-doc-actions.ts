import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { ArtifactSummary } from '@shared/artifacts'
import { toast } from '@renderer/components/ui/toast'
import { artifactRefOf, errorMessage } from '@renderer/lib/host'
import { useHostHas } from '@renderer/lib/host-features'
import type { CanvasAgent, DocPageActions } from './canvas-editor'
import { docLayout } from './canvas-model'
import { handOff } from './handoff'
import type { ShownVersion } from './use-artifact'

/** A page's size for its image, within what a frame may be. */
export function clampSize(width: number, height: number): { width: number; height: number } {
  const clamp = (n: number) => Math.min(8_000, Math.max(64, Math.round(n)))
  return { width: clamp(width), height: clamp(height) }
}

/**
 * What a canvas document's frames offer wherever the editor shows it, the viewer or a session's
 * side panel: a PNG of a frame, presenting from it, and handing frames and notes to an agent.
 */
export function useDocActions({
  id,
  title,
  shown,
  doc,
  summary,
  agents,
  present,
}: {
  id: string
  title: string
  shown: ShownVersion | null
  /** The document as the editor shows it, with the user's changes not yet saved. */
  doc: ShownVersion['doc']
  summary: ArtifactSummary | null
  agents: readonly CanvasAgent[]
  /** Presents from the page at this place in reading order. */
  present: (index: number) => void
}): DocPageActions {
  const { t } = useTranslation('artifacts')
  const renders = useHostHas('thumbnails') === true
  return useMemo<DocPageActions>(() => {
    const indexOf = (pageId: string) => shown?.canvas?.pages.findIndex((p) => p.id === pageId) ?? -1
    return {
      download:
        renders && shown
          ? (page) => {
              const index = indexOf(page.id)
              window.kettu.artifacts
                .png(
                  artifactRefOf(id),
                  shown.version,
                  { group: 0, index: Math.max(0, index) + 1, file: page.file },
                  clampSize(page.width, page.height),
                  `${title} - ${page.name}`,
                )
                .catch((error: unknown) =>
                  toast(t('canvas.pngFailed', { error: errorMessage(error) }), undefined, {
                    tone: 'warning',
                  }),
                )
            }
          : null,
      present: (page) => present(Math.max(0, indexOf(page.id))),
      handOff: (ids) => {
        if (!doc || !summary || !shown) return
        const first = ids[0]
        const canvas =
          doc.pages.find((p) => p.id === first)?.canvas ??
          doc.notes.find((n) => n.id === first)?.canvas ??
          doc.canvases[0]!.id
        const session =
          agents.find((a) => a.doing && a.doing !== 'read')?.sessionId ?? summary.sessionId ?? null
        void handOff({
          artifact: { id, title, version: shown.version, project: summary.project },
          layout: docLayout(doc, canvas),
          ids,
          session: session || null,
        })
          .then((sent) => {
            if (sent) toast(t('board.handedOff'), undefined, { tone: 'success' })
          })
          .catch((error: unknown) =>
            toast(t('board.handOffFailed', { error: errorMessage(error) }), undefined, {
              tone: 'warning',
            }),
          )
      },
    }
  }, [renders, shown, doc, summary, agents, id, title, present, t])
}
