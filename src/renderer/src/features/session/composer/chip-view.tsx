import { useEffect, useLayoutEffect } from 'react'
import {
  Alert02Icon,
  BrowserIcon,
  File01Icon,
  Folder01Icon,
  GlobalIcon,
} from '@hugeicons/core-free-icons'
import { cn } from '@renderer/lib/utils'
import { loadSiteIcons, useSiteIcon } from '@renderer/stores/site-icons'
import type { Chip } from './chips'
import { Glyph } from '@renderer/features/shell/glyph'

/** How a chip stands: as typed, under the pointer, chosen in the text, or naming what is gone. */
export type ChipState = 'default' | 'selected'

/**
 * A chip as the composer and the thread draw it: 22 px high with 5 px corners and an icon that
 * says what it is. The command is no box: text in the control blue, without an icon. `surface`
 * is for a chip on a grey bubble, which it sets off in the card's white.
 */
export function ChipView({
  chip,
  state = 'default',
  surface = false,
}: {
  chip: Chip
  state?: ChipState
  surface?: boolean
}) {
  const missing = chip.kind !== 'command' && chip.kind !== 'link' && !!chip.missing
  return (
    <span
      data-chip={chip.kind}
      className={cn(
        'relative -top-px mx-px inline-flex h-5.5 max-w-65 items-center gap-1.25 rounded-lg pr-1.5 pl-1.25 align-middle text-ui leading-none whitespace-nowrap text-primary transition-[background-color,box-shadow] duration-(--duration-fast)',
        chip.kind === 'command'
          ? 'top-0 mx-0 h-auto px-0 font-medium text-control-on'
          : missing
            ? 'text-tertiary outline-1 -outline-offset-1 outline-border-strong outline-dashed'
            : state === 'selected'
              ? 'bg-control-on-tint shadow-[inset_0_0_0_1.5px_var(--control-on)]'
              : cn(
                  surface ? 'bg-surface' : 'bg-subtle',
                  'shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)] hover:bg-selected hover:shadow-[inset_0_0_0_var(--hairline)_var(--border-default)]',
                ),
      )}
    >
      <ChipBody chip={chip} missing={missing} />
    </span>
  )
}

/** The site's icon where Kettu's browser recorded one, which is never fetched for a chip. */
function SiteIcon({ url }: { url: string }) {
  const icon = useSiteIcon(url)
  useEffect(loadSiteIcons, [])
  if (!icon) return <Glyph icon={GlobalIcon} className="size-3.5 shrink-0 text-tertiary" />
  return (
    <img
      src={icon}
      alt=""
      draggable={false}
      className="size-3.5 shrink-0 rounded-sm object-contain"
    />
  )
}

function ChipBody({ chip, missing }: { chip: Chip; missing: boolean }) {
  if (chip.kind === 'command') {
    return (
      <span>
        <span className="text-control-on/55">/</span>
        {chip.name}
      </span>
    )
  }
  if (chip.kind === 'link') {
    return (
      <>
        {chip.local ? (
          <span className="grid size-3.5 shrink-0 place-items-center rounded-sm bg-control-on-tint text-control-on">
            <Glyph icon={BrowserIcon} className="size-2.25" />
          </span>
        ) : (
          <SiteIcon url={chip.url} />
        )}
        <span className="shrink-0 font-medium">{chip.host}</span>
        {chip.path && <span className="min-w-0 truncate text-tertiary">{chip.path}</span>}
      </>
    )
  }
  return (
    <>
      {missing ? (
        <Glyph icon={Alert02Icon} className="size-3.25 shrink-0 text-warning" />
      ) : chip.kind === 'image' && chip.thumb ? (
        <img
          src={chip.thumb}
          alt=""
          draggable={false}
          className="size-4 shrink-0 rounded-[3px] object-cover shadow-[inset_0_0_0_0.5px_var(--border-default)]"
        />
      ) : chip.kind === 'folder' ? (
        <Glyph icon={Folder01Icon} className="size-3.25 shrink-0 text-tertiary" />
      ) : (
        <Glyph icon={File01Icon} className="size-3.25 shrink-0 text-tertiary" />
      )}
      <span className={cn('min-w-0 truncate', missing && 'line-through decoration-border-strong')}>
        {chip.label}
      </span>
      {chip.lines && <span className="shrink-0 text-tertiary">:{chip.lines}</span>}
    </>
  )
}

/** A chip drawn into the editor, which measures again once React has put it on the page. */
export function RenderedChip({
  chip,
  state,
  onRendered,
}: {
  chip: Chip
  state: ChipState
  onRendered: () => void
}) {
  useLayoutEffect(onRendered)
  return <ChipView chip={chip} state={state} />
}
