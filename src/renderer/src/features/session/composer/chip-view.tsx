import { useEffect, useLayoutEffect, useMemo } from 'react'
import {
  Alert02Icon,
  BrowserIcon,
  ComputerTerminal01Icon,
  SmartPhone01Icon,
  File01Icon,
  Folder01Icon,
  GlobalIcon,
  PlugSocketIcon,
} from '@hugeicons/core-free-icons'
import { githubReferenceFromLink, type GitHubReference } from '@shared/git'
import { SiteIconImage } from '@renderer/components/site-icon-image'
import { ProjectPathContext } from '@renderer/features/files/file-refs'
import { ReferenceIcon } from '@renderer/features/git/gh-reference'
import {
  shortReference,
  useProjectRepository,
  useReferenceData,
} from '@renderer/features/git/gh-reference-data'
import { cn } from '@renderer/lib/utils'
import { loadReference } from '@renderer/stores/git'
import { loadSiteIcons, useSiteIcon } from '@renderer/stores/site-icons'
import { shortLinkPath, type Chip } from './chips'
import { Glyph } from '@renderer/features/shell/glyph'

/** How a chip stands: as typed, under the pointer, chosen in the text, or naming what is gone. */
export type ChipState = 'default' | 'selected'

/**
 * A chip as the composer and the thread draw it: raised in the card's white with an icon that
 * says what it is, 24 px high in the composer and 22 px in a sent message (`surface`), whose
 * lines are tighter. The command is no box: text in the control blue, without an icon.
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
        'relative inline-flex items-center align-middle text-ui leading-none whitespace-nowrap text-primary transition-[background-color,box-shadow] duration-(--duration-fast)',
        chip.kind === 'command'
          ? 'max-w-65 gap-1.25 font-medium text-control-on'
          : cn(
              '-top-px mx-0.5 max-w-80 gap-1.5 rounded-[7px] pr-2 pl-1.5',
              surface ? 'h-5.5' : 'h-6',
              missing
                ? 'text-tertiary outline-1 -outline-offset-1 outline-border-strong outline-dashed'
                : state === 'selected'
                  ? 'bg-[color-mix(in_srgb,var(--control-on)_6%,var(--bg-raised))] shadow-[0_0_0_1.5px_var(--control-on)]'
                  : 'bg-raised shadow-[0_0_0_0.5px_var(--border-default),var(--elevation-raised)] hover:shadow-[0_0_0_0.5px_var(--border-strong),var(--elevation-raised)]',
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
  return <SiteIconImage src={icon} className="size-3.5 shrink-0 rounded-sm object-contain" />
}

/** A GitHub issue or pull request as the thread's reference: its state, number and title. */
function ReferenceBody({ reference }: { reference: GitHubReference }) {
  const { data } = useReferenceData(reference)
  const repo = useProjectRepository()
  useEffect(() => loadReference(reference), [reference])
  const title = data?.kind === 'pull' ? data.pr.title : data?.issue.title
  return (
    <>
      <ReferenceIcon kind={reference.kind} data={data} size={14} />
      <span className="min-w-0 truncate">
        <span className="font-medium">{shortReference(reference, repo)}</span>
        {title && <span className="ml-1.5 text-tertiary">{title}</span>}
      </span>
    </>
  )
}

function LinkBody({ chip }: { chip: Extract<Chip, { kind: 'link' }> }) {
  const reference = useMemo(() => githubReferenceFromLink(chip.url), [chip.url])
  if (reference) return <ReferenceBody reference={reference} />
  return (
    <>
      {chip.local ? (
        <span className="grid size-3.5 shrink-0 place-items-center rounded-sm bg-control-on-tint text-control-on">
          <Glyph icon={BrowserIcon} className="size-2.25" />
        </span>
      ) : (
        <SiteIcon url={chip.url} />
      )}
      <span className="min-w-0 truncate">
        <span className="font-medium">{chip.host}</span>
        <span className="text-secondary">{shortLinkPath(chip.host, chip.path)}</span>
      </span>
    </>
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
  if (chip.kind === 'link') return <LinkBody chip={chip} />
  if (chip.kind === 'plugin') {
    return (
      <>
        <Glyph icon={PlugSocketIcon} className="size-3.25 shrink-0 text-tertiary" />
        <span className="min-w-0 truncate">
          <span className="font-medium">{chip.label}</span>
          {chip.name && chip.name !== chip.label && (
            <span className="ml-1.5 text-tertiary">{chip.name}</span>
          )}
        </span>
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
      ) : chip.kind === 'terminal' ? (
        <Glyph icon={ComputerTerminal01Icon} className="size-3.25 shrink-0 text-tertiary" />
      ) : chip.kind === 'page' ? (
        <Glyph icon={GlobalIcon} className="size-3.25 shrink-0 text-tertiary" />
      ) : chip.kind === 'device' ? (
        <Glyph icon={SmartPhone01Icon} className="size-3.25 shrink-0 text-tertiary" />
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

/**
 * A chip drawn into the editor, which measures again once React has put it on the page. It is
 * a React root of its own, so it is told the project a GitHub reference is short for.
 */
export function RenderedChip({
  chip,
  state,
  projectPath,
  onRendered,
}: {
  chip: Chip
  state: ChipState
  projectPath: string | null
  onRendered: () => void
}) {
  useLayoutEffect(onRendered)
  return (
    <ProjectPathContext value={projectPath}>
      <ChipView chip={chip} state={state} />
    </ProjectPathContext>
  )
}
