import { memo, useRef, useState } from 'react'
import { Globe02Icon, MoreHorizontalIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { ArtifactSummary } from '@shared/artifacts'
import type { AgentId } from '@shared/thread'
import { Dropdown, Icon } from '@renderer/components/affect/app-shell'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { longAgo, shortAgo } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/use-now'
import { useArtifactsStore } from '@renderer/stores/artifacts'
import { openArtifact } from '@renderer/stores/view'
import { useArtifactPublished } from './artifact-host'
import { ArtifactMenuItems } from './artifact-menu'
import { useArtifactMenu } from './menu-entries'
import { artifactKind, type ArtifactKind } from './model'
import { CardFaces } from './presence-faces'
import { KindSketch } from './sketch'
import { useThumbnail, type Thumbnail } from './thumbnails'
import { useInView } from './use-in-view'

/** Opens the viewer; Back returns to the page with this card focused. */
function openFromPage(id: string, history = false): void {
  useArtifactsStore.setState({ opened: id })
  openArtifact(id, { history })
}

/** The time the card shows: when it was opened on this device, or its latest version. */
export interface CardTime {
  at: number
}

/**
 * One artifact: its title and a line of the agent's mark, its kind and when it was last seen, with
 * its menu beside the title; under them a panel where its preview lies as a page over a glow in the
 * kind's colors.
 */
export const ArtifactCard = memo(function ArtifactCard({
  artifact,
  agent,
  agentHost,
  meta,
  time,
  project,
  session,
  tabbable,
}: {
  artifact: ArtifactSummary
  /** The agent of the session it shows under; none when imported or that session is gone. */
  agent: AgentId | null
  /** The host that session is on, null for this computer. */
  agentHost: string | null
  /** The line after the mark: its kind and pages, the version when grouped; in Recently deleted,
   * the days left. */
  meta: string
  time: CardTime | null
  project: string
  session: string
  tabbable: boolean
}) {
  const { t } = useTranslation('artifacts')
  const card = useRef<HTMLDivElement>(null)
  const more = useRef<HTMLButtonElement>(null)
  const thumbnail = useThumbnail(artifact, useInView(card))
  const [contextOpen, setContextOpen] = useState(false)
  const shared = useArtifactPublished(artifact.id) ?? false
  const kind = artifactKind(artifact)
  const target = {
    id: artifact.id,
    title: artifact.title,
    version: artifact.version,
    versions: artifact.version,
    files: artifact.files,
    sessionId: artifact.sessionId,
    deletedAt: artifact.deletedAt,
    type: artifact.type,
  }
  const actions = {
    onOpen: () => openFromPage(artifact.id),
    onVersionHistory: () => openFromPage(artifact.id, true),
  }
  const menu = useArtifactMenu(target, actions)

  const button = (
    <button
      type="button"
      data-artifact-card={artifact.id}
      tabIndex={tabbable ? 0 : -1}
      onClick={() => openFromPage(artifact.id)}
      onKeyDown={(event) => {
        // The context menu key opens the More menu, the card's menu for the keyboard.
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault()
          more.current?.click()
        }
      }}
      className="k-art__open"
    >
      <span className="k-art__head">
        <b className="k-art__name">{artifact.title}</b>
        <span className="ui-as-meta k-art__meta">
          {agent && <AgentMark agent={agent} size={12} hostId={agentHost} className="shrink-0" />}
          <span>
            {meta}
            {time && (
              <>
                {' · '}
                <Ago time={time} />
              </>
            )}
          </span>
          {shared && (
            <span className="k-art__shared" role="img" aria-label={t('card.shared')}>
              <Icon icon={Globe02Icon} size={12} />
            </span>
          )}
        </span>
      </span>
      <span className="k-art__panel">
        <Glow />
        <span className="k-art__page">
          <Preview thumbnail={thumbnail} kind={kind} title={artifact.title} />
          {artifact.editing.length > 0 && (
            <span className="k-art__editing">
              <CardFaces sessions={artifact.editing} fallback={<i />} />
              {t('card.editing')}
            </span>
          )}
        </span>
      </span>
    </button>
  )

  return (
    <div
      ref={card}
      className="k-art"
      data-kind={kind}
      data-held={contextOpen || undefined}
      data-gone={artifact.deletedAt !== null || undefined}
    >
      <ContextMenu onOpenChange={setContextOpen}>
        <Tooltip>
          <TooltipTrigger render={<ContextMenuTrigger render={button} />} delay={700} />
          <TooltipContent className="flex-col items-start gap-0.5">
            <span>{project}</span>
            <span>{session}</span>
            <VersionTime artifact={artifact} />
          </TooltipContent>
        </Tooltip>
        <ContextMenuContent>
          <ArtifactMenuItems target={target} {...actions} />
        </ContextMenuContent>
      </ContextMenu>
      {/* Beside the title, outside the card's button; the card's Tab stop is its own. */}
      <span className="k-art__more">
        <Dropdown
          align="end"
          items={menu}
          trigger={({ open, toggle }) => (
            <button
              ref={more}
              type="button"
              tabIndex={-1}
              className="k-art__more-btn"
              aria-label={t('card.more', { title: artifact.title })}
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={toggle}
            >
              <Icon icon={MoreHorizontalIcon} size={15} />
            </button>
          )}
        />
      </span>
    </div>
  )
})

/**
 * The page as rendered at the frame's width, or a canvas's pages where they lie on its ground; a
 * sketch of its kind while there is no picture, or when none can be drawn.
 */
function Preview({
  thumbnail,
  kind,
  title,
}: {
  thumbnail: Thumbnail
  kind: ArtifactKind
  title: string
}) {
  if (thumbnail.state === 'loading') return <span className="k-th k-th--loading" />
  if (thumbnail.state === 'failed') return <KindSketch kind={kind} title={title} />
  return (
    <span className="k-th k-th--image" data-canvas={kind === 'canvas' || undefined}>
      <img src={thumbnail.src} alt="" draggable={false} />
      {/* The image draws the pages on a clear ground; each page takes its edge over it. */}
      {thumbnail.pages?.map((page, i) => (
        <i
          key={i}
          aria-hidden
          style={{
            left: `${page.left * 100}%`,
            top: `${page.top * 100}%`,
            width: `${page.width * 100}%`,
            height: `${page.height * 100}%`,
          }}
        />
      ))}
    </span>
  )
}

/** Three soft blobs in the kind's colors behind the page; still until the card is pointed at. */
function Glow() {
  return (
    <span aria-hidden className="k-art__glow">
      <i />
      <i />
      <i />
    </span>
  )
}

/** The caption's time, apart so only it follows the clock. */
function Ago({ time }: { time: CardTime }) {
  return <>{shortAgo(time.at, useNow())}</>
}

/** In the tooltip only, so it reads the time as it opens. */
function VersionTime({ artifact }: { artifact: ArtifactSummary }) {
  const { t } = useTranslation('artifacts')
  const now = useNow()
  return (
    <span>
      {t('card.when', { version: artifact.version, time: longAgo(artifact.updatedAt, now) })}
    </span>
  )
}

/** A card's place before the list arrives, at its real size. */
export function CardSkeleton() {
  return (
    <div aria-hidden className="k-art">
      <span className="k-art__open">
        <span className="k-art__head">
          <span className="k-bone" style={{ width: '62%', margin: '5px 0 6px' }} />
          <span className="k-bone" style={{ width: '40%', marginBottom: 5 }} />
        </span>
        <span className="k-art__panel">
          <span className="k-art__page">
            <span className="k-th k-th--loading" />
          </span>
        </span>
      </span>
    </div>
  )
}
