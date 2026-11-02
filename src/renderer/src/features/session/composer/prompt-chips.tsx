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
import type { SlashCommand } from '@shared/thread'
import { foldersOf } from '@renderer/features/session/composer/mentions'
import { formatShortcut, isMod, isWeb } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import type { DraftAttachment } from '@renderer/stores/attachments'
import { ensureFiles, openFile, useFilesStore } from '@renderer/stores/files'
import { openViewer } from '@renderer/stores/viewer'
import { openAttachmentPath } from '../attachments/open-attachment'
import { draftKey } from '../media/viewer-items'
import { ChipPreview } from './chip-preview'
import { ChipView } from './chip-view'
import { findChips, mentioned, mentionResolver, type Chip } from './chips'
import type { ComposerEditorHandle } from './editor'
import type { ChipHooks } from './editor-chips'
import { useLinkOpener } from './link-opener'

// The hover preview opens once the pointer rests on a chip, and stays while it moves between two.
const PREVIEW_DELAY = 350
// "Pasted as a link" stays this long, or until the text changes again.
const PASTED_FOR = 6000

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
  text,
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
  text: string
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
  const mentions = /[@＠]/.test(text)
  useEffect(() => {
    if (projectPath && mentions) ensureFiles(projectPath)
  }, [projectPath, mentions])
  const project = files ? projectOf(files.paths, files.known) : null
  const resolve = useMemo(() => mentionResolver(attachments, project), [attachments, project])
  const names = useMemo(() => commands.map((c) => c.name), [commands])

  // The preview belongs to the text it was opened on: an edit can take its chip away.
  const [hover, setHover] = useState<{ chip: Chip; element: HTMLElement; text: string } | null>(
    null,
  )
  if (hover && hover.text !== text) setHover(null)
  const hoverTimer = useRef<number | undefined>(undefined)
  const onHover = (chip: Chip | null, element: HTMLElement | null) => {
    window.clearTimeout(hoverTimer.current)
    if (!chip || !element || chip.kind === 'command') {
      setHover(null)
      return
    }
    hoverTimer.current = window.setTimeout(
      () => setHover({ chip, element, text }),
      hover ? 0 : PREVIEW_DELAY,
    )
  }
  useEffect(() => () => window.clearTimeout(hoverTimer.current), [])

  const [pasted, setPasted] = useState<{ from: number; to: number; text: string } | null>(null)
  if (pasted && pasted.text !== text) setPasted(null)
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
    if (chip.kind === 'command') return
    if (chip.kind === 'link') {
      links.open(chip.url)
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
      openFile(projectPath, chip.path, chip.lines ? Number(chip.lines.split('–')[0]) : null)
    }
  }

  // The editor redraws its chips when the context changes, so it changes only with what they
  // show; the handlers are read when they fire.
  const onLinkPasted = (from: number, to: number) =>
    setPasted({ from, to, text: editor.current?.text() ?? '' })
  const handlers = useRef({ onHover, open, onLinkPasted })
  useLayoutEffect(() => {
    handlers.current = { onHover, open, onLinkPasted }
  })
  const chipContext = useMemo<ChipHooks>(
    () => ({
      commands: names,
      resolve,
      onHover: (chip, element) => handlers.current.onHover(chip, element),
      onOpen: (chip) => handlers.current.open(chip),
      onLinkPasted: (from, to) => handlers.current.onLinkPasted(from, to),
      highlight: pasted,
    }),
    [names, resolve, pasted],
  )

  // An attachment a chip stands for needs no tile; one whose chip goes shows its tile again.
  const hidden = useMemo(() => mentioned(text, resolve), [text, resolve])

  const keyDown = (event: KeyboardEvent): boolean => {
    if (!pasted || !isMod(event) || !event.shiftKey || event.key.toLowerCase() !== 'v') return false
    event.preventDefault()
    keepPasted()
    return true
  }

  const leading = findChips(text, { commands: names, resolve: () => null })[0]
  const command =
    leading?.kind === 'command' ? commands.find((c) => c.name === leading.name) : undefined
  const strip = !!command && focused && !popoverOpen && !hover && !pasted

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
            className="pointer-events-none isolate z-50 outline-none"
          >
            <Popover.Popup
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
                  projectPath={projectPath}
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
            sideOffset={10}
            className="isolate z-50 outline-none"
          >
            <Popover.Popup
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
            sideOffset={8}
            className="pointer-events-none isolate z-40 w-(--anchor-width) outline-none"
          >
            <Popover.Popup
              initialFocus={false}
              finalFocus={false}
              className={cn(
                POPUP,
                'pointer-events-none flex items-center gap-2 rounded-code px-2.5 py-1.75 text-hint text-secondary',
              )}
            >
              {command && leading && (
                <>
                  <ChipView chip={leading} />
                  <span className="min-w-0 flex-1 truncate">{command.description}</span>
                  <span className="shrink-0 text-tertiary">
                    {[agentName, command.inputHint].filter(Boolean).join(' · ')}
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
