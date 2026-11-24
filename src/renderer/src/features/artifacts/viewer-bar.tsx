import { useState, type ReactNode } from 'react'
import type { IconSvgElement } from '@hugeicons/react'
import {
  ArrowDown01Icon,
  Comment01Icon,
  Message01Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  PlayIcon,
  SquareArrowExpand01Icon,
  ViewIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Dropdown, Icon, type MenuItem } from '@renderer/components/affect/app-shell'
import { SegmentedControl } from '@renderer/components/affect/segmented-control'
import { Kbd } from '@renderer/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { NoDrag, TopBar } from '@renderer/features/shell/top-bar'
import { longAgo } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/use-now'
import type { ViewerMode } from '@renderer/stores/artifact-viewer'
import { KIND_ICON } from './kinds'
import { useArtifactMenu, type MenuOptions, type MenuTarget } from './menu-entries'
import type { ArtifactKind } from './model'
import { ShareButton } from './share-popover'
import { useShell } from './viewer-shell-context'

const MODES: Array<{ value: ViewerMode; icon: IconSvgElement; key: string }> = [
  { value: 'view', icon: ViewIcon, key: 'V' },
  { value: 'comment', icon: Comment01Icon, key: 'C' },
  { value: 'edit', icon: PencilEdit02Icon, key: 'E' },
]

/** The canvas page on screen after the title, whose name opens the page menu. */
export interface BarPage {
  name: string
  items: MenuItem[]
}

/** What the bar offers; what an artifact cannot do here is left out. */
export interface BarProps {
  where: 'main' | 'panel'
  kind: ArtifactKind | null
  title: string
  page: BarPage | null
  version: { number: number; at: number | null } | null
  historyOpen: boolean
  onVersion: () => void
  mode: ViewerMode
  onMode: (mode: ViewerMode) => void
  /** Open comment threads, on the Comment segment. */
  comments: number
  /** Why Comment and Edit are off, such as an earlier version on screen; null when they are on. */
  modesOff: string | null
  /** Why Edit alone is paused, as while the artifact's computer is offline. */
  editOff?: string | null
  /** Who is here, and the same as menu items for a bar too narrow for faces. */
  presence: ReactNode
  presenceItems: MenuItem[]
  /** The session to talk to about it, in the main area only. */
  onChat: (() => void) | null
  onPresent: (() => void) | null
  /** Shows it in the main area's viewer, from the side panel only. */
  onOpenMain: (() => void) | null
  share: { id: string; title: string; shown: number; head: number } | null
  menu: { target: MenuTarget; options: MenuOptions } | null
}

/**
 * The viewer's bar. In the main area: the kind's mark, the title and version, the View / Comment /
 * Edit switch, then who is here, Chat, Present, Share and More. In the side panel the artifact's
 * tab has its mark and title, closes it and its row maximizes, so the bar is the tab's context
 * bar: the page and version, then the switch, who is here, Present, Share, Open in main area and
 * More. It drops words, then buttons, as the viewer narrows.
 */
export function ViewerBar(props: BarProps) {
  const row = <BarRow {...props} />
  if (props.where === 'main') {
    return <TopBar className="avs-top">{row}</TopBar>
  }
  return <div className="avs-head avs-head--ctx">{row}</div>
}

function BarRow({
  where,
  kind,
  title,
  page,
  version,
  historyOpen,
  onVersion,
  mode,
  onMode,
  comments,
  modesOff,
  editOff = null,
  presence,
  presenceItems,
  onChat,
  onPresent,
  onOpenMain,
  share,
  menu,
}: BarProps) {
  const { t } = useTranslation(['artifacts', 'common'])
  const shell = useShell()
  const { tier, labelled } = shell
  // The context bar has no title to make room for, so its buttons stay at any width.
  const tight = shell.tight && where === 'main'
  const now = useNow()
  const wide = tier === 'wide' && where === 'main'
  // From the wide tier the modes keep their words, which say at a glance whether edits save;
  // the tools on the right take theirs only once there is room for both.
  const labels = tier === 'wide' && labelled
  const centred = where === 'main' && tier !== 'narrow'
  const [sharing, setSharing] = useState(false)

  const modes = (
    <ModeSwitch
      mode={mode}
      onMode={onMode}
      comments={comments}
      off={modesOff}
      editOff={editOff}
      iconsOnly={tier !== 'wide' || where === 'panel'}
    />
  )
  // Narrow, Present and who is here go into More; under 480 px, Share and Chat too. The context
  // bar folds only who is here.
  const folded = tight || tier === 'narrow'
  const presentFolded = folded && where === 'main'
  const extra: MenuItem[] = folded
    ? [
        ...(tight && onChat
          ? [{ label: t('viewer.chat'), icon: Message01Icon, onSelect: onChat }]
          : []),
        ...(onPresent && presentFolded
          ? [{ label: t('viewer.present'), icon: PlayIcon, onSelect: onPresent }]
          : []),
        ...presenceItems,
      ]
    : []

  return (
    <div className="avs-bar" data-centred={centred || undefined}>
      <NoDrag className="avs-bar__lead">
        {where === 'main' && kind && (
          <span aria-hidden className="avs-bar__mark" data-kind={kind}>
            <Icon icon={KIND_ICON[kind]} size={17} />
          </span>
        )}
        {where === 'main' && (
          <h1 className="avs-bar__title" title={title}>
            {title}
          </h1>
        )}
        {/* Narrow, the page is chosen in the left card, which leaves the bar to the title. */}
        {page && (where === 'panel' || tier !== 'narrow') && (
          <PageCrumb page={page} slash={where === 'main'} />
        )}
        {version && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-pressed={historyOpen}
                  aria-label={t('viewer.versionChip', { version: version.number })}
                  onClick={onVersion}
                  className="avs-bar__ver"
                />
              }
            >
              <b>{t('viewer.version', { version: version.number })}</b>
              {(wide || where === 'panel') && version.at !== null && (
                <span>· {longAgo(version.at, now)}</span>
              )}
            </TooltipTrigger>
            <TooltipContent>{t('viewer.history')}</TooltipContent>
          </Tooltip>
        )}
      </NoDrag>
      <NoDrag className="avs-bar__centre">{modes}</NoDrag>
      <NoDrag className="avs-bar__tools">
        {!folded && presence}
        {onChat && !tight && (
          <BarAction
            label={t('viewer.chat')}
            icon={Message01Icon}
            labelled={labels}
            onClick={onChat}
          />
        )}
        {onPresent && !presentFolded && (
          <BarAction
            label={t('viewer.present')}
            icon={PlayIcon}
            labelled={labels}
            onClick={onPresent}
          />
        )}
        {share && (
          <span className="avs-bar__share" data-folded={tight || undefined}>
            <ShareButton
              {...share}
              compact={!labels}
              {...(tight ? { open: sharing, onOpenChange: setSharing } : {})}
            />
          </span>
        )}
        {onOpenMain && (
          <BarAction
            label={t('viewer.openInMain')}
            icon={SquareArrowExpand01Icon}
            onClick={onOpenMain}
          />
        )}
        {menu && (
          <MoreMenu
            target={menu.target}
            options={{
              ...menu.options,
              onShare: tight && share ? () => setSharing(true) : undefined,
            }}
            extra={extra}
          />
        )}
      </NoDrag>
    </div>
  )
}

function ModeSwitch({
  mode,
  onMode,
  comments,
  off,
  editOff,
  iconsOnly,
}: {
  mode: ViewerMode
  onMode: (mode: ViewerMode) => void
  comments: number
  off: string | null
  editOff: string | null
  iconsOnly: boolean
}) {
  const { t } = useTranslation('artifacts')
  const label = (value: ViewerMode) => t(`viewer.modes.${value}`)
  const control = (
    <SegmentedControl<ViewerMode>
      aria-label={t('viewer.modes.label')}
      variant="tray"
      size="sm"
      className="avs-modes"
      value={mode}
      onChange={onMode}
      options={MODES.map((m) => ({
        value: m.value,
        label: iconsOnly ? undefined : label(m.value),
        ariaLabel:
          m.value === 'comment' && comments > 0
            ? t('viewer.modes.commentOpen', { count: comments })
            : `${label(m.value)} (${m.key})`,
        icon: <Icon icon={m.icon} size={14} />,
        count: !iconsOnly && m.value === 'comment' && comments > 0 ? comments : undefined,
        disabled: (off !== null && m.value !== 'view') || (editOff !== null && m.value === 'edit'),
      }))}
    />
  )
  const why = off ?? editOff
  if (why === null) return control
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="avs-modes-wrap" />}>{control}</TooltipTrigger>
      <TooltipContent>{why}</TooltipContent>
    </Tooltip>
  )
}

/** A bar button: its icon with the label in a tooltip, or with the label beside it. */
function BarAction({
  label,
  icon,
  labelled = false,
  shortcut,
  onClick,
}: {
  label: string
  icon: IconSvgElement
  labelled?: boolean
  shortcut?: string
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={labelled ? undefined : label}
            onClick={onClick}
            className="avs-bar__btn"
            data-labelled={labelled || undefined}
          />
        }
      >
        <Icon icon={icon} size={15} />
        {labelled && <span>{label}</span>}
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && <Kbd>{shortcut}</Kbd>}
      </TooltipContent>
    </Tooltip>
  )
}

function PageCrumb({ page, slash }: { page: BarPage; slash: boolean }) {
  const { t } = useTranslation('artifacts')
  return (
    <>
      {slash && (
        <i aria-hidden className="avs-bar__slash">
          /
        </i>
      )}
      <Dropdown
        align="start"
        title={t('board.canvases.menu')}
        items={page.items}
        className="avs-bar__pages"
        trigger={({ open, toggle }) => (
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={toggle}
            className="avs-bar__page"
            title={page.name}
          >
            <span>{page.name}</span>
            <Icon icon={ArrowDown01Icon} size={12} />
          </button>
        )}
      />
    </>
  )
}

function MoreMenu({
  target,
  options,
  extra,
}: {
  target: MenuTarget
  options: MenuOptions
  extra: MenuItem[]
}) {
  const { t } = useTranslation('artifacts')
  const items = useArtifactMenu(target, options)
  const all =
    extra.length > 0 ? [...extra, { ...items[0]!, divider: true }, ...items.slice(1)] : items
  return (
    <Dropdown
      align="end"
      className="k-av-more"
      items={all}
      trigger={({ open, toggle }) => (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={t('viewer.more')}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={toggle}
                className="avs-bar__btn"
              />
            }
          >
            <Icon icon={MoreHorizontalIcon} size={16} />
          </TooltipTrigger>
          <TooltipContent>{t('viewer.more')}</TooltipContent>
        </Tooltip>
      )}
    />
  )
}
