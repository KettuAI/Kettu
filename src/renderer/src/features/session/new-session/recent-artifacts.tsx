import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { KIND_ICON } from '@renderer/features/artifacts/kinds'
import { artifactKind, latestArtifacts, recency } from '@renderer/features/artifacts/model'
import { useWindowArtifacts } from '@renderer/features/artifacts/window-artifacts'
import { Glyph } from '@renderer/features/shell/glyph'
import { basename, mediumAgo } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/use-now'
import { artifactListShown, useArtifactsStore } from '@renderer/stores/artifacts'
import { findProjectForPath, useProjectsStore } from '@renderer/stores/projects'
import { openArtifact, openArtifacts } from '@renderer/stores/view'

/** How many artifacts the list shows. */
const COUNT = 3

/**
 * The latest artifacts of the hosts the window shows, to open again, with a link to the Artifacts
 * page; with none, nothing shows. Hidden while a message is written, like the sessions to pick up.
 */
export function RecentArtifacts({ hidden }: { hidden: boolean }) {
  const { t } = useTranslation('session')
  const { list } = useWindowArtifacts()
  const openedAt = useArtifactsStore((s) => s.openedAt)
  const projects = useProjectsStore((s) => s.projects)
  const now = useNow()
  useEffect(() => {
    artifactListShown(true)
    return () => artifactListShown(false)
  }, [])
  const latest = useMemo(
    () => (list ? latestArtifacts(list, openedAt, COUNT) : []),
    [list, openedAt],
  )
  if (latest.length === 0) return null
  return (
    <section
      aria-labelledby="new-session-artifacts"
      inert={hidden}
      className="kettu-pickup"
      data-hidden={hidden || undefined}
    >
      <div className="kettu-pickup__head">
        <h2 id="new-session-artifacts" className="kettu-pickup__label">
          {t('newSession.artifacts.title')}
        </h2>
        <button type="button" onClick={openArtifacts} className="kettu-pickup__all">
          {t('newSession.artifacts.viewAll')}
        </button>
      </div>
      {latest.map((artifact) => (
        <button
          key={artifact.id}
          type="button"
          onClick={() => openArtifact(artifact.id)}
          className="kettu-pickup__row"
        >
          <Glyph icon={KIND_ICON[artifactKind(artifact)]} className="shrink-0" />
          <span className="kettu-pickup__title">{artifact.title}</span>
          <span className="kettu-pickup__status">
            {mediumAgo(recency(artifact, openedAt), now)}
          </span>
          <span className="kettu-pickup__project">
            {artifact.scratch
              ? t('newSession.noProject')
              : (findProjectForPath(projects, artifact.project)?.name ??
                basename(artifact.project))}
          </span>
        </button>
      ))}
    </section>
  )
}
