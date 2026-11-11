import { ShapesIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { KIND_LOOK } from '@renderer/features/artifacts/kinds'
import { artifactKind } from '@renderer/features/artifacts/model'
import { PaneIcon } from '@renderer/features/shell/panel-button'
import { cn } from '@renderer/lib/utils'
import { learnArtifactHost, sessionHost } from '@renderer/lib/host'
import { useEntry } from '@renderer/features/session/use-thread'
import { useArtifactsStore } from '@renderer/stores/artifacts'
import { toggleArtifactPane } from '@renderer/stores/view'
import { Ago, Row } from './row-parts'

/** An artifact the session wrote. A click shows it beside the thread, as its card there does. */
export function ArtifactRow({
  sessionId,
  entryId,
  artifactId,
}: {
  sessionId: string
  entryId: string
  artifactId: string
}) {
  const { t } = useTranslation('board')
  const { t: ta } = useTranslation('artifacts')
  // A session's artifacts are kept where it runs, which every request for one goes by.
  learnArtifactHost(artifactId, sessionHost(sessionId))
  const entry = useEntry(sessionId, entryId, 'artifact')
  const summary = useArtifactsStore((s) => s.list?.find((a) => a.id === artifactId) ?? null)
  const kind = summary ? artifactKind(summary) : null
  const look = kind ? KIND_LOOK[kind] : null
  const title = summary?.title ?? entry?.title ?? ''
  const version = summary?.version ?? entry?.version ?? null
  const meta = [
    kind && ta(`page.kinds.${kind}`),
    version !== null && t('artifact.version', { version }),
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="kb-item">
      <Row
        label={t('actions.openTitle', { title })}
        onClick={() => toggleArtifactPane(sessionId, artifactId, true)}
        tile={
          <span className={cn('kb-tile', look ? [look.color, look.tint] : 'kb-tile--plain')}>
            {look ? (
              <look.icon className="size-[15px]" />
            ) : (
              <PaneIcon icon={ShapesIcon} size={15} />
            )}
          </span>
        }
        head={<span className="kb-title">{title}</span>}
        detail={meta}
        when={summary ? <Ago at={summary.updatedAt} /> : null}
        hint={<span className="kb-mini">{t('actions.open')}</span>}
      />
    </div>
  )
}
