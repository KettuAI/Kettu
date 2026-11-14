import { memo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import {
  Globe02Icon,
  LockPasswordIcon,
  MoreHorizontalIcon,
  RotateLeft01Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { ArtifactSummary } from '@shared/artifacts'
import type { AgentId } from '@shared/thread'
import { Dropdown, Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import { toast } from '@renderer/components/ui/toast'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { longAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import { restoreArtifact, type ArtifactStanding } from '@renderer/stores/artifacts'
import { artifactSharing, useArtifactShares } from './artifact-host'
import { ArtifactMenuItems } from './artifact-menu'
import { useArtifactMenu, type MenuOptions } from './menu-entries'
import { artifactKind, daysLeft, type ArtifactKind } from './model'
import { CardFaces } from './presence-faces'
import { ShareButton } from './share-popover'
import { KindSketch } from './sketch'
import { useThumbnail, type Thumbnail } from './thumbnails'
import { useInView } from './use-in-view'
import { useVisitors } from './use-present-agents'
import './artifact-card.css'

/**
 * How big a card is: the Artifacts page's tile; in the thread a turn's one new artifact in full,
 * any other write with the panel half as tall, and a deletion smallest of all.
 */
export type CardForm = 'tile' | 'full' | 'half' | 'small'

/** Who can open its published page besides the user: anyone with its code, or anyone. */
type Access = 'code' | 'public'

const FAILED: Thumbnail = { state: 'failed' }

/**
 * One artifact, the same on the Artifacts page and in the thread: its title, then a line of the
 * agent's mark, what it is or what the turn did, and when, with its publish mark; under them a
 * panel where its picture lies as a page over a glow in the kind's colors, and who is at it on the
 * panel's corner. More sits beside the title on hover or focus; a deleted card offers Restore.
 */
export const ArtifactCard = memo(function ArtifactCard({
  id,
  title,
  summary,
  standing,
  form,
  still,
  stacked = false,
  agent,
  agentHost,
  what,
  at,
  host = null,
  note = null,
  current,
  pressed,
  onOpen,
  menu,
  page,
}: {
  id: string
  title: string
  /** The artifact in the lists; null before they are read, and once it is deleted for good. */
  summary: ArtifactSummary | null
  standing: ArtifactStanding
  form: CardForm
  /** The version the panel shows a picture of; null for none. */
  still: number | null
  /** An update: its page lies over a blank sheet. */
  stacked?: boolean
  /** The agent of the session that wrote it; none when imported or that session is gone. */
  agent: AgentId | null
  /** The host that session is on, null for this computer. */
  agentHost: string | null
  /** What the line says before the time while the artifact is there. */
  what: string
  /** When it was written, or opened here; the line ends with it. */
  at: number | null
  /** Another host's name, after the time; never this computer's. */
  host?: string | null
  /** The version's note, one muted line under the line. */
  note?: string | null
  /** It stands for the artifact as it is now, so it shows who is at it. */
  current: boolean
  /** Open beside the thread; undefined where it never is. */
  pressed?: boolean
  onOpen: () => void
  menu: Omit<MenuOptions, 'onShare'>
  /** On the Artifacts page: whether the card is the grid's Tab stop, and its tooltip. */
  page?: { tabbable: boolean; tip: ReactNode }
}) {
  const { t } = useTranslation('artifacts')
  const card = useRef<HTMLDivElement>(null)
  const more = useRef<HTMLButtonElement>(null)
  const inView = useInView(card)
  const [held, setHeld] = useState(false)
  // Mounted once Share... is chosen and kept, so its question about unpublishing outlives the panel.
  const [sharing, setSharing] = useState<boolean | null>(null)
  const kind = summary ? artifactKind(summary) : null
  const live = standing === 'live'
  const access = useAccess(id)
  const shares = useArtifactShares(id)
  const writing = current && live && (summary?.editing.length ?? 0) > 0
  const visitors = useVisitors(id, current && live && access !== null && inView)
  const thumbnail = useStill(id, summary, still, inView, standing === 'erased')

  const target = {
    id,
    title,
    version: summary?.version ?? 0,
    versions: summary?.version ?? 0,
    files: summary?.files ?? 0,
    sessionId: summary?.sessionId ?? '',
    deletedAt: summary?.deletedAt ?? null,
    type: summary?.type ?? null,
  }
  const options: MenuOptions = {
    ...menu,
    onShare: shares && live && summary ? () => setSharing(true) : undefined,
  }
  const items = useArtifactMenu(target, options)
  // The thread offers only Restore on a deleted card; the page keeps its menu for Delete permanently.
  const hasMenu = summary !== null && (live || (form === 'tile' && standing === 'deleted'))
  const opens = form === 'small' ? live : standing !== 'erased'

  let words: string
  let time: ReactNode = null
  if (form === 'small') {
    words = standing === 'erased' ? t('card.erased') : t('card.deleted')
  } else if (standing === 'erased') {
    words = t('card.erased')
  } else if (standing === 'deleted') {
    words = [kind && t(`page.kinds.${kind}`), t('card.deleted')].filter(Boolean).join(' · ')
  } else {
    words = what
  }
  if (standing === 'deleted' && summary?.deletedAt != null) {
    time = <DaysLeft deletedAt={summary.deletedAt} />
  } else if (live && form !== 'small') {
    if (writing) time = t('card.writing')
    else if (at !== null) time = <Ago at={at} />
  }

  const panel =
    form === 'small' ? (
      <span className="k-art__panel">
        <span className="k-art__sheet" data-blank="">
          <b>{title}</b>
          <i style={{ width: '88%' }} />
          <i style={{ width: '94%' }} />
          <i style={{ width: '62%' }} />
        </span>
      </span>
    ) : form === 'half' ? (
      <span className="k-art__panel">
        <Glow />
        {stacked && <span aria-hidden className="k-art__sheet" data-behind="" />}
        <span className="k-art__sheet">
          <Preview thumbnail={thumbnail} kind={kind} title={title} />
        </span>
      </span>
    ) : (
      <span className="k-art__panel">
        <Glow />
        <span className="k-art__page">
          <Preview thumbnail={thumbnail} kind={kind} title={title} />
        </span>
      </span>
    )

  const button = (
    <button
      type="button"
      data-artifact-card={form === 'tile' ? id : undefined}
      tabIndex={page && !page.tabbable ? -1 : undefined}
      disabled={!opens}
      aria-pressed={pressed}
      onClick={onOpen}
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
        <b className="k-art__name">{title}</b>
        <span className="ui-as-meta k-art__meta">
          {agent && (
            <span className="k-art__mark">
              <AgentMark agent={agent} size={12} hostId={agentHost} />
            </span>
          )}
          {words && <span className="k-art__what">{time ? `${words} ·` : words}</span>}
          {time && (
            <span className="k-art__time" data-writing={writing || undefined}>
              {time}
            </span>
          )}
          {host && live && <span className="k-art__host">{`· ${host}`}</span>}
          {access && live && (
            <span className="k-art__shared" role="img" aria-label={t(`card.access.${access}`)}>
              <Icon icon={access === 'public' ? Globe02Icon : LockPasswordIcon} size={12} />
            </span>
          )}
        </span>
        {note && live && <span className="k-art__note">{note}</span>}
      </span>
      {panel}
      {visitors ? (
        <span className="sr-only">{t('board.visitors.count', { count: visitors })}</span>
      ) : null}
    </button>
  )

  return (
    <div
      ref={card}
      className="k-art"
      data-kind={kind ?? undefined}
      data-form={form}
      data-open={pressed || undefined}
      data-held={held || undefined}
      data-gone={live ? undefined : standing}
    >
      {hasMenu ? (
        <ContextMenu onOpenChange={setHeld}>
          <Tipped tip={page?.tip}>
            <ContextMenuTrigger render={button} />
          </Tipped>
          <ContextMenuContent>
            <ArtifactMenuItems target={target} {...options} />
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        <Tipped tip={page?.tip}>{button}</Tipped>
      )}
      {current && live && form !== 'small' && (
        <span className="k-art__who">
          <CardFaces sessions={writing ? summary!.editing : []} visitors={visitors} />
        </span>
      )}
      {standing === 'deleted' && (
        <span className="k-art__restore">
          <Button
            variant="secondary"
            size="sm"
            icon={<Icon icon={RotateLeft01Icon} size={13} />}
            onClick={() =>
              void restoreArtifact(id).catch((error: unknown) =>
                toast(errorMessage(error), undefined, { tone: 'warning' }),
              )
            }
          >
            {t('menu.restore')}
          </Button>
        </span>
      )}
      {hasMenu && (
        // Beside the title, outside the card's button; the card's Tab stop is its own.
        <span className="k-art__more">
          <Dropdown
            align="end"
            items={items}
            trigger={({ open, toggle }) => (
              <button
                ref={more}
                type="button"
                tabIndex={-1}
                className="k-art__more-btn"
                aria-label={t('card.more', { title })}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={toggle}
              >
                <Icon icon={MoreHorizontalIcon} size={15} />
              </button>
            )}
          />
        </span>
      )}
      {sharing !== null && summary && (
        <span className="k-art__share">
          <ShareButton
            id={id}
            title={title}
            shown={summary.version}
            head={summary.version}
            open={sharing}
            onOpenChange={setSharing}
          />
        </span>
      )}
    </div>
  )
})

/** The page's tooltip, slow to show, over the card's button. */
function Tipped({ tip, children }: { tip: ReactNode; children: ReactElement }) {
  if (!tip) return children
  return (
    <Tooltip>
      <TooltipTrigger render={children} delay={700} />
      <TooltipContent className="flex-col items-start gap-0.5">{tip}</TooltipContent>
    </Tooltip>
  )
}

/** The publish mark: only when others can open the page, by its code or by its link. */
function useAccess(id: string): Access | null {
  return artifactSharing(id).useSharingStore((s) => {
    const pages = s.status?.published.filter((page) => page.id === id) ?? []
    if (pages.some((page) => page.access === 'public')) return 'public'
    if (pages.some((page) => page.access === 'code')) return 'code'
    return null
  })
}

/**
 * The picture of `version` once the card is in view; the earlier picture stays while a newer one
 * is made.
 */
function useStill(
  id: string,
  summary: ArtifactSummary | null,
  version: number | null,
  inView: boolean,
  erased: boolean,
): Thumbnail {
  const made = useThumbnail(
    {
      id,
      version: version ?? 0,
      pages: summary?.pages ?? 0,
      canvas: summary?.canvas ?? false,
    },
    inView && summary !== null && version !== null,
  )
  const [kept, setKept] = useState<Thumbnail | null>(null)
  if (made.state === 'ready' && kept !== made) setKept(made)
  if (erased) return FAILED
  return made.state === 'loading' && kept ? kept : made
}

/**
 * The page as rendered at the frame's width, or a canvas's pages where they lie on its ground; a
 * sketch of its kind when none can be drawn, and a gray sheet while it is made.
 */
function Preview({
  thumbnail,
  kind,
  title,
}: {
  thumbnail: Thumbnail
  kind: ArtifactKind | null
  title: string
}) {
  if (thumbnail.state === 'loading' || (thumbnail.state === 'failed' && !kind)) {
    return <span className="k-th k-th--loading" />
  }
  if (thumbnail.state === 'failed') return <KindSketch kind={kind!} title={title} />
  return (
    <span className="k-th k-th--image" data-canvas={kind === 'canvas' || undefined}>
      <img src={thumbnail.src} alt="" draggable={false} />
      {/* The image draws the pages on a clear ground; each page takes its edge over it. */}
      {thumbnail.pages?.map((box, i) => (
        <i
          key={i}
          aria-hidden
          style={{
            left: `${box.left * 100}%`,
            top: `${box.top * 100}%`,
            width: `${box.width * 100}%`,
            height: `${box.height * 100}%`,
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

/** The line's time, apart so only it follows the clock. */
function Ago({ at }: { at: number }) {
  return <>{longAgo(at, useNow())}</>
}

function DaysLeft({ deletedAt }: { deletedAt: number }) {
  const { t } = useTranslation('artifacts')
  return <>{t('card.daysLeft', { count: daysLeft(deletedAt, useNow()) })}</>
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
