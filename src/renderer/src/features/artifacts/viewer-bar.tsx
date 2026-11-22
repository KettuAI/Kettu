import { useState, type ReactNode } from 'react'
import type { IconSvgElement } from '@hugeicons/react'
import {
  ArrowDown01Icon,
  ArrowExpand01Icon,
  ArrowShrink01Icon,
  Comment01Icon,
  Message01Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  PlayIcon,
  SidebarRightIcon,
  ViewIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Dropdown, Icon, type MenuItem } from '@renderer/components/affect/app-shell'
import { SegmentedControl } from '@renderer/components/affect/segmented-control'
import { Kbd } from '@renderer/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { CornerControlsSpace, NoDrag, TopBar } from '@renderer/features/shell/top-bar'
import { usePhoneWindow } from '@renderer/features/shell/narrow'
import { longAgo } from '@renderer/lib/format'
import { hasBand } from '@renderer/lib/platform'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import type { ViewerMode } from '@renderer/stores/artifact-viewer'
import { useViewStore } from '@renderer/stores/view'
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
  /** Who is here, and the same as menu items for a bar too narrow for faces. */
  presence: ReactNode
  presenceItems: MenuItem[]
  /** The session to talk to about it, in the main area only. */
  onChat: (() => void) | null
  onPresent: (() => void) | null
  share: { id: string; title: string; shown: number; head: number } | null
  menu: { target: MenuTarget; options: MenuOptions } | null
  /** In a session's side panel, its panel and whether it covers the main area. */
  panel: { maximized: boolean; onExpand: (() => void) | null; onClose: () => void } | null
}

/**
 * The viewer's bar, the same in the main area and the side panel: the kind's mark, the title and
 * version, the View / Comment / Edit switch, then who is here, Chat, Present, Share and More; the
 * side panel adds Expand and Close. It drops words, then buttons, as the viewer narrows.
 */
export function ViewerBar(props: BarProps) {
  const phone = usePhoneWindow()
  const cornered = useViewStore((s) => s.sidebarCollapsed) || phone
  const row = <BarRow {...props} />
  if (props.where === 'main') {
    return <TopBar className="avs-top">{row}</TopBar>
  }
  const headCornered = cornered && !!props.panel?.maximized && !hasBand
  return (
    <div className={cn('avs-head app-region-drag', headCornered && 'avs-head--cornered')}>
      {headCornered && <CornerControlsSpace className="mr-1" />}
      {row}
    </div>
  )
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
  presence,
  presenceItems,
  onChat,
  onPresent,
  share,
  menu,
  panel,
}: BarProps) {
  const { t } = useTranslation(['artifacts', 'common'])
  const { tier, tight } = useShell()
  const now = useNow()
  const wide = tier === 'wide' && where === 'main'
  const labels = tier === 'wide'
  const centred = where === 'main' && tier !== 'narrow'
  const [sharing, setSharing] = useState(false)

  const modes = (
    <ModeSwitch
      mode={mode}
      onMode={onMode}
      comments={comments}
      off={modesOff}
      iconsOnly={!labels || where === 'panel'}
    />
  )
  // Narrow, Present and who is here go into More; under 480 px, Share and Chat too.
  const folded = tight || tier === 'narrow'
  const extra: MenuItem[] = folded
    ? [
        ...(tight && onChat
          ? [{ label: t('viewer.chat'), icon: Message01Icon, onSelect: onChat }]
          : []),
        ...(onPresent ? [{ label: t('viewer.present'), icon: PlayIcon, onSelect: onPresent }] : []),
        ...presenceItems,
      ]
    : []

  return (
    <div className="avs-bar" data-centred={centred || undefined}>
      <NoDrag className="avs-bar__lead">
        {kind && (
          <span aria-hidden className="avs-bar__mark" data-kind={kind}>
            <Icon icon={KIND_ICON[kind]} size={where === 'panel' ? 16 : 17} />
          </span>
        )}
        <h1 className="avs-bar__title" title={title}>
          {title}
        </h1>
        {/* Narrow, the page is chosen in the left card, which leaves the bar to the title. */}
        {page && tier !== 'narrow' && <PageCrumb page={page} />}
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
              {wide && version.at !== null && <span>· {longAgo(version.at, now)}</span>}
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
        {onPresent && !folded && (
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
        {panel && (
          <>
            {panel.onExpand && (
              <BarAction
                label={panel.maximized ? t('viewer.restore') : t('viewer.expand')}
                icon={panel.maximized ? ArrowShrink01Icon : ArrowExpand01Icon}
                onClick={panel.onExpand}
              />
            )}
            <BarAction
              label={t('common:pane.collapse')}
              icon={SidebarRightIcon}
              onClick={panel.onClose}
            />
          </>
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
  iconsOnly,
}: {
  mode: ViewerMode
  onMode: (mode: ViewerMode) => void
  comments: number
  off: string | null
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
        disabled: off !== null && m.value !== 'view',
      }))}
    />
  )
  if (off === null) return control
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="avs-modes-wrap" />}>{control}</TooltipTrigger>
      <TooltipContent>{off}</TooltipContent>
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

function PageCrumb({ page }: { page: BarPage }) {
  const { t } = useTranslation('artifacts')
  return (
    <>
      <i aria-hidden className="avs-bar__slash">
        /
      </i>
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
