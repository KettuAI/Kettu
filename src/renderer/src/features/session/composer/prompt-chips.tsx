import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { Popover } from '@base-ui/react/popover'
import { useTranslation } from 'react-i18next'
import { isSkillCommand, type SlashCommand } from '@shared/thread'
import { foldersOf } from '@renderer/features/session/composer/mentions'
import { formatShortcut, isMod, isWeb } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import type { DraftAttachment } from '@renderer/stores/attachments'
import { ensureFiles, openFile, useFilesStore } from '@renderer/stores/files'
import { useGitStore } from '@renderer/stores/git'
import { useOverlayPresence } from '@renderer/stores/overlays'
import { revealSurface } from '@renderer/features/shell/open-surfaces'
import { newSessionPanel } from '@renderer/stores/view'
import { openViewer } from '@renderer/stores/viewer'
import { openAttachmentPath } from '../attachments/open-attachment'
import { draftKey } from '../media/viewer-items'
import { ChipPreview } from './chip-preview'
import { removeAttachment } from './attachments'
import { ChipView } from './chip-view'
import { isSurfaceMention, mentionResolver, type Chip } from './chips'
import { useMentionSurfaces } from './mention-surfaces'
import { useDraftMentions } from './plugin-mentions'
import type { ComposerEditorHandle } from './editor'
import type { ChipHooks } from './editor-chips'
import { useLinkOpener } from './link-opener'
import { commandSourceName } from './command-source'
import { activeSlashItems } from './slash'
import { useBoxText, type BoxText } from './use-prompt-box'

// The hover preview opens once the pointer rests on a chip, and stays while it moves between two.
const PREVIEW_DELAY = 350
// "Pasted as a link" stays this long, or until the text changes again.
const PASTED_FOR = 6000

const NO_KEYS: ReadonlySet<string> = new Set()

const POPUP =
  'origin-(--transform-origin) rounded-xl bg-popover text-popover-foreground shadow-menu outline-none animation-duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 motion-reduce:animate-none'

/** A project's files and folders as sets, made once per listing. */
const projectSets = new WeakMap<
  readonly string[],
  { files: ReadonlySet<string>; folders: ReadonlySet<string> }
>()
export function projectOf(paths: readonly string[], known: ReadonlySet<string>) {
  let sets = projectSets.get(paths)
  if (!sets) {
    sets = { files: known, folders: new Set(foldersOf(paths)) }
    projectSets.set(paths, sets)
  }
  return sets
}

/**
 * The chips of a prompt box: what they resolve against, the attachments they stand for (which the
 * tray leaves out), the preview a chip shows under the pointer, the note after a link is pasted,
 * and the command strip over the box.
 */
export function usePromptChips({
  draft,
  sessionId,
  hostId,
  source,
  attachments,
  commands,
  agentName,
  projectPath,
  editor,
  anchor,
  focused,
  popoverOpen,
}: {
  draft: string
  sessionId: string | null
  hostId: string | null
  source: BoxText
  attachments: readonly DraftAttachment[]
  commands: readonly SlashCommand[]
  agentName: string
  projectPath: string | null
  editor: RefObject<ComposerEditorHandle | null>
  /** The box, which the command strip sits over. */
  anchor: RefObject<HTMLDivElement | null>
  focused: boolean
  /** A list opens over the box, which the strip leaves room for. */
  popoverOpen: boolean
}) {
  const { t } = useTranslation('composer')
  const files = useFilesStore((s) => (projectPath ? s.byProject[projectPath] : undefined))
  const githubOwner = useGitStore((s) =>
    projectPath ? (s.status[projectPath]?.remote?.github?.owner ?? null) : null,
  )
  const githubRepoName = useGitStore((s) =>
    projectPath ? (s.status[projectPath]?.remote?.github?.repo ?? null) : null,
  )
  const githubRepo = useMemo(
    () => (githubOwner && githubRepoName ? { owner: githubOwner, repo: githubRepoName } : null),
    [githubOwner, githubRepoName],
  )
  const mentions = useBoxText({ source }, (text) => /[@＠]/.test(text))
  useEffect(() => {
    if (projectPath && mentions) ensureFiles(projectPath)
  }, [projectPath, mentions])
  const project = files ? projectOf(files.paths, files.known) : null
  const panel = sessionId ?? (projectPath ? newSessionPanel(projectPath) : null)
  const surfaces = useMentionSurfaces(panel)
  const plugins = useDraftMentions(draft)
  const resolve = useMemo(
    () => mentionResolver(attachments, project, surfaces, plugins),
    [attachments, project, surfaces, plugins],
  )
  const exclusiveNames = useMemo(
    () => commands.filter((c) => !isSkillCommand(c)).map((c) => c.name),
    [commands],
  )
  const skillNames = useMemo(() => commands.filter(isSkillCommand).map((c) => c.name), [commands])

  // The preview belongs to the text it was opened on: an edit can take its chip away.
  const [hover, setHover] = useState<{ chip: Chip; element: HTMLElement } | null>(null)
  const hoverTimer = useRef<number | undefined>(undefined)
  const onHover = (chip: Chip | null, element: HTMLElement | null) => {
    window.clearTimeout(hoverTimer.current)
    if (
      !chip ||
      !element ||
      chip.kind === 'command' ||
      chip.kind === 'plugin' ||
      isSurfaceMention(chip.kind)
    ) {
      setHover(null)
      return
    }
    const at = source.text
    hoverTimer.current = window.setTimeout(
      () => {
        if (source.text === at) setHover({ chip, element })
      },
      hover ? 0 : PREVIEW_DELAY,
    )
  }
  useEffect(() => () => window.clearTimeout(hoverTimer.current), [])

  const [pasted, setPasted] = useState<{ from: number; to: number } | null>(null)
  // An edit closes the preview and ends "Pasted as a link".
  useEffect(() => {
    let last = source.text
    return source.subscribe(() => {
      if (source.text === last) return
      last = source.text
      setHover(null)
      setPasted(null)
    })
  }, [source])
  useEffect(() => {
    if (!pasted) return
    const timer = window.setTimeout(() => setPasted(null), PASTED_FOR)
    return () => window.clearTimeout(timer)
  }, [pasted])
  const keepPasted = () => {
    if (!pasted) return
    editor.current?.keepAsText(pasted.from, pasted.to)
    setPasted(null)
    editor.current?.focus()
  }

  const links = useLinkOpener(sessionId)
  const open = (chip: Chip) => {
    setHover(null)
    if (chip.kind === 'command' || chip.kind === 'skill') return
    if (chip.kind === 'link') {
      links.open(chip.url)
      return
    }
    if (isSurfaceMention(chip.kind)) {
      if (chip.surfaceId && panel) revealSurface(panel, chip.kind, chip.surfaceId)
      return
    }
    const item = attachments.find((a) => a.key === chip.attachmentKey)
    const attachment = item?.attachment
    if (attachment && item.status === 'ready') {
      if (attachment.type === 'image') {
        openViewer({
          sessionId,
          projectPath,
          draft,
          item: {
            key: draftKey(draft, item.key),
            source: { kind: 'attachment', attachment },
            name: item.name,
            alt: '',
          },
          from: null,
        })
      } else {
        void openAttachmentPath(attachment, projectPath)
      }
      return
    }
    if (chip.path && chip.kind === 'file' && projectPath) {
      openFile(projectPath, chip.path, chip.lines ? Number(chip.lines.split('–')[0]) : null, {
        preview: true,
      })
    }
  }

  // The editor redraws its chips when the context changes, so it changes only with what they
  // show; the handlers are read when they fire.
  const onLinkPasted = (from: number, to: number) => setPasted({ from, to })
  // An attachment a chip stands for needs no tile. One whose chip the user deletes goes with it;
  // one whose text changed some other way shows its tile again.
  const [hidden, setHidden] = useState(NO_KEYS)
  const onMentioned = (keys: ReadonlySet<string>) =>
    setHidden((shown) =>
      shown.size === keys.size && [...keys].every((key) => shown.has(key)) ? shown : keys,
    )
  const onMentionDeleted = (keys: readonly string[]) => {
    for (const key of keys) removeAttachment(draft, key)
  }
  const handlers = useRef({ onHover, open, onLinkPasted, onMentioned, onMentionDeleted })
  useLayoutEffect(() => {
    handlers.current = { onHover, open, onLinkPasted, onMentioned, onMentionDeleted }
  })
  const chipContext = useMemo<ChipHooks>(
    () => ({
      commands: exclusiveNames,
      skills: skillNames,
      resolve,
      githubRepo,
      onHover: (chip, element) => handlers.current.onHover(chip, element),
      onOpen: (chip) => handlers.current.open(chip),
      onLinkPasted: (from, to) => handlers.current.onLinkPasted(from, to),
      onMentioned: (keys) => handlers.current.onMentioned(keys),
      onMentionDeleted: (keys) => handlers.current.onMentionDeleted(keys),
      highlight: pasted,
      projectPath,
      hostId,
    }),
    [exclusiveNames, skillNames, resolve, githubRepo, pasted, projectPath, hostId],
  )

  const keyDown = (event: KeyboardEvent): boolean => {
    if (!pasted || !isMod(event) || !event.shiftKey || event.key.toLowerCase() !== 'v') return false
    event.preventDefault()
    keepPasted()
    return true
  }

  // Track the leading exclusive command for the passive command strip. Stackable skills render
  // directly as inline chips with hover previews (like file mentions), so selecting a skill does
  // not keep a persistent floating box open above the composer.
  const commandName = useBoxText(
    { source },
    (text) => activeSlashItems(text, commands).command?.name ?? '',
  )
  const activeCommand = useMemo(
    () =>
      commandName
        ? (commands.find((c) => !isSkillCommand(c) && c.name === commandName) ?? null)
        : null,
    [commandName, commands],
  )
  const commandChip = useMemo<Chip | null>(
    () =>
      activeCommand
        ? {
            kind: 'command',
            from: 0,
            to: activeCommand.name.length + 1,
            name: activeCommand.name,
          }
        : null,
    [activeCommand],
  )
  const strip = activeCommand !== null && focused && !popoverOpen && !hover && !pasted

  // Passive previews and status strips can overlap the native browser view, but do not dismiss on
  // outside clicks and must not suspend window drag regions.
  useOverlayPresence(!!hover)
  useOverlayPresence(!!pasted)
  useOverlayPresence(strip)

  const overlays: ReactNode = (
    <>
      {links.dialog}
      <Popover.Root open={!!hover}>
        <Popover.Portal>
          <Popover.Positioner
            anchor={hover?.element}
            side="top"
            align="start"
            sideOffset={8}
            className="pointer-events-none isolate z-(--layer-menu) outline-none"
          >
            <Popover.Popup
              data-overlay-layer=""
              initialFocus={false}
              finalFocus={false}
              className={cn(POPUP, 'pointer-events-none')}
            >
              {hover && (
                <ChipPreview
                  chip={hover.chip}
                  item={attachments.find(
                    (a) => 'attachmentKey' in hover.chip && a.key === hover.chip.attachmentKey,
                  )}
                  commands={commands}
                  agentName={agentName}
                  projectPath={projectPath}
                  hostId={hostId}
                  inSession={!!sessionId && !isWeb}
                />
              )}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <Popover.Root open={!!pasted}>
        <Popover.Portal>
          <Popover.Positioner
            anchor={() =>
              pasted ? (editor.current?.chipElement(pasted.from) ?? anchor.current) : null
            }
            side="top"
            align="start"
            sideOffset={4}
            className="isolate z-(--layer-menu) outline-none app-region-no-drag"
          >
            <Popover.Popup
              data-overlay-layer=""
              initialFocus={false}
              finalFocus={false}
              className="flex items-center gap-2.5 rounded-lg bg-toast py-1.5 pr-1.5 pl-2.5 text-hint text-toast-foreground shadow-toast outline-none data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 motion-reduce:animate-none"
            >
              {t('chips.pastedLink')}
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={keepPasted}
                className="flex h-5.5 items-center gap-1.5 rounded-lg bg-toast-foreground/12 px-1.75 text-small font-semibold outline-none focus-ring hover:bg-toast-foreground/20"
              >
                {t('chips.pasteAsText')}
                <span className="opacity-80">{formatShortcut('Mod+Shift+V')}</span>
              </button>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <Popover.Root open={strip}>
        <Popover.Portal>
          <Popover.Positioner
            anchor={anchor}
            side="top"
            align="start"
            sideOffset={4}
            className="pointer-events-none isolate z-(--layer-menu) w-(--anchor-width) outline-none"
          >
            <Popover.Popup
              data-overlay-layer=""
              initialFocus={false}
              finalFocus={false}
              className={cn(
                POPUP,
                'pointer-events-none flex items-center gap-2 rounded-code px-2.5 py-1.75 text-hint text-secondary',
              )}
            >
              {activeCommand && commandChip && (
                <>
                  <ChipView chip={commandChip} />
                  <span className="min-w-0 flex-1 truncate">{activeCommand.description}</span>
                  <span className="shrink-0 text-tertiary">
                    {[
                      commandSourceName(activeCommand.source, t) ?? agentName,
                      activeCommand.inputHint,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </>
              )}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </>
  )

  return { chipContext, hidden, keyDown, overlays, strip }
}
