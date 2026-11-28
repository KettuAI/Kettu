import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Popover } from '@base-ui/react/popover'
import { SparklesIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { isSkillCommand, type AgentId, type SlashCommand } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Spinner } from '@renderer/components/ui/spinner'
import { Glyph } from '@renderer/features/shell/glyph'
import { menuCollisionPadding } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { PLUGIN_REF_LIMITS } from '@shared/plugin-refs'
import { rememberReferenceSummary, useGitStore } from '@renderer/stores/git'
import { loadKettuCommands } from '@renderer/stores/kettu-commands'
import { useOverlayPresence } from '@renderer/stores/overlays'
import { TextDialog, type TextDialogTarget } from '../attachments/text-dialog'
import { ArtifactPickerPopover, AttachedArtifactChips } from './artifact-picker'
import { AttachmentTray } from './attachment-tray'
import { attachMention } from './attachments'
import { BrowserAnnotationChips } from './browser-annotation-chips'
import { DelegateAgentPickerPopover, DelegateRecipientChip } from './delegate-picker'
import type { DelegateTarget } from './delegation'
import { ComposerEditor } from './editor'
import { hashPickerShown, hashRefAt, replaceHashRef, type GitHubRefRow } from './github-picker'
import { GitHubRefFooter, GitHubRefHeading, GitHubRefItem } from './github-ref-popover'
import {
  MentionFooter,
  MentionItem,
  PluginGroupHeading,
  PluginGroupNote,
  PluginItem,
} from './mention-popover'
import {
  mentionAt,
  mentionName,
  mentionShown,
  moveHighlight,
  popoverKey,
  replaceMention,
  type MentionRow,
} from './mentions'
import {
  POPOVER_SIDE_OFFSET,
  resolvePopoverPlacement,
  viewportBounds,
  type PopoverKind,
  type PopoverSide,
} from './popover-position'
import { usePromptChips } from './prompt-chips'
import { ResizeGrip } from './resize-grip'
import { commandSourceName } from './command-source'
import {
  applySlashChoice,
  keepsCompletedSlash,
  orderSlashMatches,
  slashAt,
  slashPopoverAt,
  type CompletedSlash,
} from './slash'
import { slashKeys } from './slash-list'
import { addDraftMention } from './plugin-mentions'
import { useGitHubRefPicker, type GitHubRefPickerState } from './use-github-ref-picker'
import { useMentionList, type MentionList } from './use-mention-list'
import {
  usePluginMentions,
  type PluginMentionGroup,
  type PluginMentions,
  type PluginRow,
} from './use-plugin-mentions'
import { useBoxText, type PromptBoxState } from './use-prompt-box'

// The box both composers share, the session's and New session's: the text with its slash, `@`,
// and `#` popovers and the attachments, kept in a draft, inside the Chat Composer's writing area.
// What sends, and how, is each one's own.

type PopoverItem = SlashCommand | MentionRow | PluginRow | GitHubRefRow

/** What the mention list shows: the project's files and what the plugins offer. */
interface MentionView extends MentionList {
  plugins: PluginMentions
}

type PopoverView =
  'slash' | { kind: 'mention'; view: MentionView } | { kind: 'hash'; view: GitHubRefPickerState }

/** Why there are no commands to list yet: none reported so far, or no project chosen. */
export type SlashNote = 'loading' | 'chooseProject'

const isMentionRow = (item: PopoverItem): item is MentionRow => 'positions' in item
const isPluginRow = (item: PopoverItem): item is PluginRow => 'plugin' in item
const isGitHubRefRow = (item: PopoverItem): item is GitHubRefRow => 'githubRef' in item
/** A source with no items still shows a line when it is searching or failed. */
const shownNote = (group: PluginMentionGroup) => group.error !== null || group.searching

// Confine the portaled popup to the viewport instead of clipping ancestors such as New session's
// ColumnScroller, which starts below the top bar.
const VIEWPORT_BOUNDARY: Element[] = []
// Side placement is decided by `resolvePopoverPlacement` so normal New session boxes stay clear of
// Send while tall composers fall back to the trigger line; `align: 'shift'` keeps mentions in view.
const POPOVER_COLLISION_AVOIDANCE = {
  side: 'none',
  align: 'shift',
  fallbackAxisSide: 'none',
} as const

/** The prompt box: what shows on its top edge, the attachments, then the text and its popovers. */
export function PromptBox({
  box,
  agentId,
  hostId,
  agentName,
  commands,
  commandsNote = null,
  placeholder,
  suggestion = null,
  label,
  size,
  top,
  canDelegate = false,
  onDelegateSelect,
  onKeyDown,
}: {
  box: PromptBoxState
  agentId: AgentId | null
  /** The host the agent is on, null for this computer. */
  hostId: string | null
  agentName: string
  commands: SlashCommand[]
  /** Said in the slash list while it has no commands, which then shows only this line. */
  commandsNote?: SlashNote | null
  placeholder: string
  /** A guess at the next message, offered in place of the placeholder; Tab fills it in. */
  suggestion?: string | null
  label: string
  /** The text's least height, its padding and its line height, as CSS lengths. */
  size: { minHeight: string; padding: string; lineHeight?: string }
  /** What the box shows before the attachments, such as a notice. */
  top?: ReactNode
  /** Whether this composer can delegate tasks to another agent. */
  canDelegate?: boolean
  /** Called after a delegation recipient is picked from the popover. */
  onDelegateSelect?: (target: DelegateTarget) => void
  /** A key the popovers left to the composer, which calls preventDefault on one it takes. */
  onKeyDown: (event: KeyboardEvent) => void
}) {
  const { t } = useTranslation('composer')
  const { draft, projectPath, disabled, source, attachments, update, editor, setCaret } = box
  // The `/` whose list Esc or leaving the box closed.
  const [slashDismissed, setSlashDismissed] = useState<number | null>(null)
  // The slash token just chosen from the list, kept suppressed if selection lands on its edge or
  // the user deletes its trailing space before deleting the chip itself.
  const [completedSlash, setCompletedSlash] = useState<CompletedSlash | null>(null)
  // The `@` whose popover Esc or a click elsewhere closed.
  const [mentionDismissed, setMentionDismissed] = useState<number | null>(null)
  // The `#` whose GitHub reference picker Esc or a click elsewhere closed.
  const [hashDismissed, setHashDismissed] = useState<number | null>(null)
  // While an input method composes: whether a mention or `#` picker was open when it started.
  const [composition, setComposition] = useState<{ open: boolean } | null>(null)
  const [popover, setPopover] = useState<PopoverView | null>(null)
  const [viewing, setViewing] = useState<TextDialogTarget | null>(null)
  // The highlighted row, for the list `list` names.
  const [highlight, setHighlight] = useState({ list: '', index: 0 })
  const group = useRef<HTMLDivElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const listId = useId()
  const githubOwner = useGitStore((s) =>
    !box.noProject && projectPath ? (s.status[projectPath]?.remote?.github?.owner ?? null) : null,
  )
  const githubRepoName = useGitStore((s) =>
    !box.noProject && projectPath ? (s.status[projectPath]?.remote?.github?.repo ?? null) : null,
  )
  const githubRepo = useMemo(
    () => (githubOwner && githubRepoName ? { owner: githubOwner, repo: githubRepoName } : null),
    [githubOwner, githubRepoName],
  )

  // Read from the text as values, so a key or a caret move renders the box only when one changes.
  const completedAlive = useBoxText(box, (text, caret) =>
    keepsCompletedSlash(text, completedSlash, slashAt(text, caret)),
  )
  if (completedSlash !== null && !completedAlive) setCompletedSlash(null)
  const slashKey = useBoxText(box, (text, caret) => {
    const found = slashPopoverAt(text, caret, commands, completedSlash)
    return found ? `${found.start}:${found.query}` : null
  })
  const slash = useMemo(() => {
    if (slashKey === null) return null
    const colon = slashKey.indexOf(':')
    return { start: Number(slashKey.slice(0, colon)), query: slashKey.slice(colon + 1) }
  }, [slashKey])
  // The user's own folder is read as the list opens, since nothing tells the host it changed.
  const slashTyped = slash !== null
  useEffect(() => {
    if (slashTyped) void loadKettuCommands(hostId)
  }, [slashTyped, hostId])
  if (slashDismissed !== null && slash?.start !== slashDismissed) setSlashDismissed(null)
  const slashMatches = slash === null ? [] : orderSlashMatches(commands, slash.query)
  const commandKeys = useMemo(() => slashKeys(commands), [commands])
  const slashOpen = slash !== null && slashMatches.length > 0 && slash.start !== slashDismissed
  // Only a `/` that starts the text, so a path typed later in a sentence opens nothing.
  const slashNote =
    slash?.start === 0 && commands.length === 0 && slashDismissed !== 0 ? commandsNote : null
  // The line it last said, kept so the popup fades out as it was.
  const [noteShown, setNoteShown] = useState<SlashNote | null>(null)
  if (slashNote !== null && slashNote !== noteShown) setNoteShown(slashNote)
  if (slashOpen && noteShown !== null) setNoteShown(null)

  const mentionKey = useBoxText(box, (text, caret) => {
    const found = mentionAt(text, caret)
    return found ? `${found.start}:${found.query}` : null
  })
  const mention = useMemo(() => {
    if (mentionKey === null) return null
    const colon = mentionKey.indexOf(':')
    return { start: Number(mentionKey.slice(0, colon)), query: mentionKey.slice(colon + 1) }
  }, [mentionKey])
  if (mentionDismissed !== null && mention?.start !== mentionDismissed) setMentionDismissed(null)
  const shown = mentionShown(mention, mentionDismissed, composition)
  const files = useMentionList(draft, projectPath, shown ? mention!.query : null)
  const plugins = usePluginMentions(hostId, shown ? mention!.query : null)
  const mentions = useMemo<MentionView>(() => ({ ...files, plugins }), [files, plugins])
  const filesReady = !!files.files && !(files.files.error && !files.files.paths.length)
  // With nothing typed it shows the files the session used and how many there are to search;
  // typed, only while something matches. With no project it says to choose one. What a plugin
  // offers opens it too, but a plugin still searching never does.
  const mentionOpen =
    shown &&
    (files.noProject ||
      files.used ||
      files.rows.length > 0 ||
      plugins.visible ||
      (mention!.query !== '' && !filesReady))

  const hashKey = useBoxText(box, (text, caret) => {
    if (!githubRepo) return null
    const found = hashRefAt(text, caret)
    return found ? `${found.start}:${found.query}` : null
  })
  const hash = useMemo(() => {
    if (hashKey === null) return null
    const colon = hashKey.indexOf(':')
    return { start: Number(hashKey.slice(0, colon)), query: hashKey.slice(colon + 1) }
  }, [hashKey])
  if (hashDismissed !== null && hash?.start !== hashDismissed) setHashDismissed(null)
  const hashShown = githubRepo !== null && hashPickerShown(hash, hashDismissed, composition)
  const githubRefs = useGitHubRefPicker(hostId, githubRepo, hashShown ? hash!.query : null)
  const hashOpen = hashShown

  const mentionPopover = useMemo<PopoverView>(
    () => ({ kind: 'mention', view: mentions }),
    [mentions],
  )
  const hashPopover = useMemo<PopoverView>(() => ({ kind: 'hash', view: githubRefs }), [githubRefs])

  // What the popup shows, kept after it closes so it fades out as it was.
  const showing: PopoverView | null =
    slashOpen || slashNote
      ? 'slash'
      : mentionOpen
        ? mentionPopover
        : hashOpen
          ? hashPopover
          : popover
  if (showing !== popover) setPopover(showing)
  // Keep the trigger index (`@`, `#`, or `/`) so the popup stays put while it fades out.
  const [atStart, setAtStart] = useState(0)
  if (mentionOpen && mention!.start !== atStart) setAtStart(mention!.start)
  const [hashStart, setHashStart] = useState(0)
  if (hashOpen && hash!.start !== hashStart) setHashStart(hash!.start)
  const [slashStart, setSlashStart] = useState(0)
  if (slashOpen && slash!.start !== slashStart) setSlashStart(slash!.start)
  else if (slashNote !== null && slash && slash.start !== slashStart) setSlashStart(slash.start)
  const listing = showing !== 'slash' && showing?.kind === 'mention' ? showing.view : null
  const hashListing = showing !== 'slash' && showing?.kind === 'hash' ? showing.view : null
  const open = slashOpen || slashNote !== null || mentionOpen || hashOpen
  const rows: PopoverItem[] =
    showing === 'slash'
      ? slashMatches
      : listing
        ? [...listing.rows, ...listing.plugins.rows]
        : hashListing
          ? hashListing.rows
          : []
  const popoverKind: PopoverKind =
    showing === 'slash' ? 'slash' : showing?.kind === 'hash' ? 'hash' : 'mention'
  const triggerStart =
    popoverKind === 'slash' ? slashStart : popoverKind === 'hash' ? hashStart : atStart
  const popoverCompact =
    (popoverKind === 'slash' && rows.length === 0 && noteShown !== null) ||
    (popoverKind === 'hash' && rows.length === 0)
  const [popoverSide, setPopoverSide] = useState<PopoverSide>('top')
  // Bumped when the editor's inner scroller moves while open so Floating UI re-reads the line.
  const [scrollTick, setScrollTick] = useState(0)
  useEffect(() => {
    if (!open) return
    const scroller = editor.current?.scrollElement()
    if (!scroller) return
    let frame = 0
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        setScrollTick((n) => n + 1)
      })
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(frame)
    }
  }, [open, editor])
  const measurePlacement = useCallback(() => {
    const boxRect = group.current?.getBoundingClientRect() ?? new DOMRect()
    const triggerRect = editor.current?.rectOf(triggerStart) ?? null
    return resolvePopoverPlacement({
      kind: popoverKind,
      box: boxRect,
      trigger: triggerRect,
      viewport: viewportBounds(window.innerHeight, menuCollisionPadding),
      sideOffset: POPOVER_SIDE_OFFSET,
      compact: popoverCompact,
    })
  }, [editor, popoverCompact, popoverKind, triggerStart])
  useLayoutEffect(() => {
    if (!open) return
    const sync = () => {
      const next = measurePlacement()
      setPopoverSide((current) => (current === next.side ? current : next.side))
    }
    sync()
  }, [open, measurePlacement, scrollTick])
  const popoverAnchor = useMemo(() => {
    // Reading `scrollTick` makes a new virtual anchor on inner editor scrolls so Base UI updates.
    const tick = scrollTick
    return {
      getBoundingClientRect: () => {
        void tick
        const next = measurePlacement()
        setPopoverSide((current) => (current === next.side ? current : next.side))
        return new DOMRect(next.anchor.x, next.anchor.y, next.anchor.width, next.anchor.height)
      },
      get contextElement() {
        return group.current ?? undefined
      },
    }
  }, [measurePlacement, scrollTick])
  // A list opens, and a new query starts, on its first row.
  const listKey = slashOpen
    ? `/${slash.start}:${slash.query}`
    : mentionOpen
      ? `@${mention!.start}:${mention!.query}`
      : hashOpen
        ? `#${hash!.start}:${hash!.query}`
        : ''
  if (highlight.list !== listKey) setHighlight({ list: listKey, index: 0 })
  const active = rows.length === 0 ? -1 : Math.min(highlight.index, rows.length - 1)
  const optionId = (index: number) => `${listId}-${index}`
  useLayoutEffect(() => {
    if (open && active >= 0)
      document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active, listId])
  const choose = (row: MentionRow) => {
    if (!mention || !projectPath) return
    const next = replaceMention(source.text, mention, mentionName(row))
    update(next.text, next.caret)
    box.limitError(attachMention(draft, projectPath, row.path, row.folder))
  }
  const choosePlugin = (row: PluginRow) => {
    if (!mention) return
    const group = plugins.groups[row.group]
    if (!group) return
    const word = addDraftMention(
      draft,
      source.text,
      {
        pluginId: group.source.pluginId,
        source: group.decl.id,
        item: row.item.id,
        name: row.item.title,
      },
      row.word,
    )
    if (word === null) {
      box.setError(t('mentions.pluginLimit', { count: PLUGIN_REF_LIMITS.perMessage }))
      return
    }
    const next = replaceMention(source.text, mention, word)
    update(next.text, next.caret)
  }
  const chooseGitHubRef = (row: GitHubRefRow) => {
    if (!hash) return
    rememberReferenceSummary(row.item, hostId)
    const current = editor.current?.text() ?? source.text
    const next = replaceHashRef(current, hash, row.item.url)
    update(next.text, next.caret)
  }
  const chooseItem = (item: PopoverItem | undefined) => {
    if (!item) return
    if (isGitHubRefRow(item)) chooseGitHubRef(item)
    else if (isPluginRow(item)) choosePlugin(item)
    else if (isMentionRow(item)) choose(item)
    else if (slash) {
      const current = editor.current?.text() ?? source.text
      const next = applySlashChoice(current, slash, item, commands)
      const insertedStart = isSkillCommand(item) ? slash.start : 0
      setCompletedSlash({ start: insertedStart, name: item.name })
      setSlashDismissed(insertedStart)
      update(next.text, next.caret)
    }
  }
  const highlightRow = (index: number) => {
    if (index !== active) setHighlight({ list: listKey, index })
  }
  const dismiss = () => {
    if (slash && (slashOpen || slashNote)) setSlashDismissed(slash.start)
    if (mentionOpen && mention) setMentionDismissed(mention.start)
    if (hashOpen && hash) setHashDismissed(hash.start)
  }
  const [focused, setFocused] = useState(false)
  const chips = usePromptChips({
    draft,
    sessionId: box.sessionId,
    hostId,
    source,
    attachments,
    commands,
    agentName,
    projectPath,
    editor,
    anchor: group,
    focused,
    popoverOpen: open,
  })

  // Tab on a folder lists what is in it, as the query `folder/`.
  const openFolder = (row: MentionRow) => {
    if (!mention) return
    const text = source.text
    const before = `${text.slice(0, mention.start)}@${row.path}/`
    update(`${before}${text.slice(mention.start + 1 + mention.query.length)}`, before.length)
  }

  const keyDown = (event: KeyboardEvent): boolean => {
    const modified = event.shiftKey || event.ctrlKey || event.altKey || event.metaKey
    const handling = popoverKey(event.key, {
      composing: event.isComposing || event.keyCode === 229,
      modified,
      slashOpen,
      mentionOpen,
      mentionRows: files.rows.length > 0 || plugins.rows.length > 0,
      hashOpen,
      hashRows: githubRefs.rows.length > 0,
    })
    // IME composition: no key reaches a popover, and Enter confirms the candidate, never sends.
    if (handling === 'block') return false
    if (chips.keyDown(event)) return true
    if (
      open &&
      !modified &&
      rows.length > 0 &&
      (event.key === 'ArrowDown' || event.key === 'ArrowUp')
    ) {
      setHighlight({ list: listKey, index: moveHighlight(active, rows.length, event.key) })
      return true
    }
    if (event.key === 'Escape' && (handling === 'popover' || (slashNote && !modified))) {
      dismiss()
      return true
    }
    const row = rows[active]
    if (handling === 'choose' && row && isMentionRow(row) && row.folder) {
      openFolder(row)
      return true
    }
    if (handling === 'popover' || handling === 'choose') {
      chooseItem(row)
      return true
    }
    if (!open && !modified && box.historyPosition && event.key === 'Escape') {
      box.leaveHistory()
      return true
    }
    if (
      !open &&
      !modified &&
      (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
      box.moveHistory(event.key === 'ArrowDown')
    )
      return true
    onKeyDown(event)
    return event.defaultPrevented
  }
  useOverlayPresence(open, { dismissible: true })
  // Base UI closes on a press outside the popup; a press in the box, its anchor, only moves the caret.
  const openChange = (next: boolean, details: Popover.Root.ChangeEventDetails) => {
    if (next) return
    if (details.reason === 'outside-press') {
      const target = details.event.target
      if (target instanceof Node && group.current?.contains(target)) {
        details.cancel()
        return
      }
    }
    dismiss()
  }
  // Focus leaving the box closes the popover.
  const blur = (event: FocusEvent) => {
    setFocused(false)
    if (event.relatedTarget instanceof Node && popup.current?.contains(event.relatedTarget)) return
    dismiss()
  }

  return (
    <>
      <div ref={group} className="kettu-prompt" data-disabled={disabled || undefined}>
        <ResizeGrip editor={editor} />
        {top}
        <DelegateRecipientChip
          draft={draft}
          hostId={hostId}
          visible={canDelegate}
          onChange={box.openDelegatePicker}
          onLeave={box.focus}
        />
        <AttachedArtifactChips draft={draft} sessionId={box.sessionId} onLeave={box.focus} />
        <BrowserAnnotationChips draft={draft} onLeave={box.focus} />
        <AttachmentTray
          draft={draft}
          sessionId={box.sessionId}
          agentId={agentId}
          hostId={hostId}
          agentName={agentName}
          projectPath={projectPath}
          onOpen={setViewing}
          onPasteAsText={box.pasteAsText}
          onError={box.setError}
          onLeave={box.focus}
          hidden={chips.hidden}
        />
        <div className="min-w-0">
          <ComposerEditor
            ref={editor}
            initialText={source.text}
            label={label}
            placeholder={placeholder}
            suggestion={suggestion}
            disabled={disabled}
            chipContext={chips.chipContext}
            size={size}
            popover={open ? { listId, activeId: active >= 0 ? optionId(active) : undefined } : null}
            onChange={box.changed}
            onCaret={setCaret}
            onKeyDown={keyDown}
            onPaste={box.onPaste}
            onFocus={() => {
              setFocused(true)
              box.onActivity?.()
            }}
            onBlur={blur}
            onCompositionStart={() => setComposition({ open: mentionOpen || hashOpen })}
            onCompositionEnd={() => setComposition(null)}
          />
        </div>
      </div>
      <Popover.Root open={open} onOpenChange={openChange}>
        <Popover.Portal>
          <Popover.Positioner
            anchor={popoverAnchor}
            side={popoverSide}
            align="start"
            sideOffset={POPOVER_SIDE_OFFSET}
            collisionBoundary={VIEWPORT_BOUNDARY}
            collisionPadding={menuCollisionPadding}
            collisionAvoidance={POPOVER_COLLISION_AVOIDANCE}
            className="isolate z-(--layer-menu) outline-none app-region-no-drag"
          >
            <Popover.Popup
              ref={popup}
              data-overlay-layer=""
              initialFocus={false}
              finalFocus={false}
              className={cn(
                'flex max-h-[min(var(--available-height),320px)] origin-(--transform-origin) flex-col overflow-hidden bg-popover text-popover-foreground shadow-menu animation-duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
                'rounded-xl p-1.25',
                showing === 'slash'
                  ? 'w-[min(var(--anchor-width),540px)]'
                  : hashListing
                    ? 'w-96 max-w-(--available-width)'
                    : 'w-85 max-w-(--available-width)',
              )}
            >
              {hashListing ? (
                <GitHubRefHeading id={`${listId}-label`} picker={hashListing} />
              ) : (
                (showing === 'slash' ? rows.length > 0 : listing && listing.rows.length > 0) && (
                  <div
                    id={`${listId}-label`}
                    className="flex h-6.5 shrink-0 items-center px-2 text-small font-medium text-tertiary"
                  >
                    {showing === 'slash'
                      ? t('slash.heading')
                      : listing?.used
                        ? t('mentions.used')
                        : t('mentions.files')}
                  </div>
                )
              )}
              <div
                role="listbox"
                id={listId}
                aria-labelledby={
                  showing === 'slash' || hashListing || (listing && listing.rows.length > 0)
                    ? `${listId}-label`
                    : undefined
                }
                aria-label={
                  showing !== 'slash' && !hashListing && listing && listing.rows.length === 0
                    ? label
                    : undefined
                }
                className={cn(
                  'min-h-0 flex-1 scroll-fade-y overflow-y-auto overscroll-contain',
                  // The names share a column, so every description starts on one line.
                  showing === 'slash' &&
                    'grid auto-rows-max grid-cols-[fit-content(42%)_minmax(0,1fr)_auto] content-start',
                  rows.length === 0 && !listing?.plugins.groups.some(shownNote) && 'hidden',
                )}
              >
                {rows.map((item, index) =>
                  isPluginRow(item) ? null : isGitHubRefRow(item) ? (
                    <GitHubRefItem
                      key={`${item.item.kind}:${item.item.number}`}
                      id={optionId(index)}
                      row={item}
                      highlighted={index === active}
                      onHighlight={() => highlightRow(index)}
                      onChoose={chooseGitHubRef}
                    />
                  ) : isMentionRow(item) ? (
                    <MentionItem
                      key={`${item.folder ? 'd' : 'f'}:${item.path}`}
                      id={optionId(index)}
                      row={item}
                      highlighted={index === active}
                      onHighlight={() => highlightRow(index)}
                      onChoose={choose}
                    />
                  ) : (
                    <SlashItem
                      key={commandKeys.get(item)!}
                      id={optionId(index)}
                      command={item}
                      agentId={agentId}
                      highlighted={index === active}
                      onHighlight={() => highlightRow(index)}
                      onChoose={() => chooseItem(item)}
                    />
                  ),
                )}
                {listing?.plugins.groups.map((group, g) => {
                  const start = listing.rows.length + listing.plugins.starts[g]!
                  if (group.items.length === 0 && !shownNote(group)) return null
                  return (
                    <div
                      key={`${group.source.pluginId}:${group.decl.id}`}
                      role="group"
                      aria-labelledby={`${listId}-group-${g}`}
                      className={cn(
                        (listing.rows.length > 0 || g > 0) && 'mt-1 border-t border-subtle pt-1',
                      )}
                    >
                      <PluginGroupHeading id={`${listId}-group-${g}`} group={group} />
                      {group.items.length === 0 && <PluginGroupNote group={group} />}
                      {listing.plugins.rows
                        .slice(
                          listing.plugins.starts[g],
                          listing.plugins.starts[g]! + group.items.length,
                        )
                        .map((row, i) => (
                          <PluginItem
                            key={row.item.id}
                            id={optionId(start + i)}
                            row={row}
                            group={group}
                            highlighted={start + i === active}
                            onHighlight={() => highlightRow(start + i)}
                            onChoose={choosePlugin}
                          />
                        ))}
                    </div>
                  )
                })}
              </div>
              {listing && <MentionFooter list={listing} more={listing.plugins.rows.length} />}
              {hashListing && <GitHubRefFooter picker={hashListing} />}
              {showing === 'slash' && rows.length === 0 && noteShown && (
                <p className="shrink-0 px-3 pt-1 pb-1.5 text-small text-tertiary">
                  {noteShown === 'loading' ? (
                    <span className="flex items-center gap-2">
                      <Spinner className="size-3.5" />
                      {t('slash.loading')}
                    </span>
                  ) : (
                    t('slash.chooseProject')
                  )}
                </p>
              )}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <ArtifactPickerPopover
        open={box.artifactPickerOpen}
        onOpenChange={box.setArtifactPickerOpen}
        anchor={group}
        draft={draft}
        projectPath={box.artifactProjectPath}
        noProject={box.noProject}
        hostId={hostId}
        onPicked={() => requestAnimationFrame(() => box.focus())}
      />
      {canDelegate && (
        <DelegateAgentPickerPopover
          open={box.delegatePickerOpen}
          onOpenChange={box.setDelegatePickerOpen}
          anchor={group}
          draft={draft}
          sessionId={box.sessionId}
          hostId={hostId}
          onSelect={onDelegateSelect}
          onPicked={() => requestAnimationFrame(() => box.focus())}
        />
      )}
      {chips.overlays}
      <TextDialog target={viewing} onClose={() => setViewing(null)} />
    </>
  )
}

/**
 * A slash command's row: its name as the box draws it, what it does in the next column, and where
 * it comes from at the row's end: its plugin, Yours, Kettu, or the agent's mark for the agent's own.
 */
function SlashItem({
  id,
  command,
  agentId,
  highlighted,
  onHighlight,
  onChoose,
}: {
  id: string
  command: SlashCommand
  agentId: AgentId | null
  highlighted: boolean
  onHighlight: () => void
  onChoose: () => void
}) {
  const skill = isSkillCommand(command)
  return (
    <div
      role="option"
      id={id}
      aria-selected={highlighted}
      data-highlighted={highlighted ? '' : undefined}
      data-slash-kind={skill ? 'skill' : 'command'}
      // Pressing a row keeps the focus, and with it the caret, in the box.
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={onHighlight}
      onClick={onChoose}
      className="col-span-3 grid h-8 cursor-default grid-cols-subgrid items-center gap-x-5 rounded-md px-2 text-menu outline-none select-none data-highlighted:bg-selected"
    >
      <span className="flex min-w-0 items-center gap-1.5 font-medium text-primary">
        {skill && <Glyph icon={SparklesIcon} className="size-3.25 shrink-0 text-control-on" />}
        <span className="truncate">
          <span className="text-tertiary">/</span>
          {command.name}
        </span>
      </span>
      <span className="truncate text-hint text-tertiary">{command.description}</span>
      <SlashSource command={command} agentId={agentId} />
    </div>
  )
}

function SlashSource({ command, agentId }: { command: SlashCommand; agentId: AgentId | null }) {
  const { t } = useTranslation('composer')
  const name = commandSourceName(command.source, t)
  const skill = isSkillCommand(command)
  const origin =
    name === null ? (
      agentId ? (
        <AgentMark agent={agentId} size={14} />
      ) : null
    ) : (
      <span className="max-w-32 truncate text-small text-tertiary">{name}</span>
    )
  if (!skill) return origin ?? <span />
  return (
    <span className="flex items-center gap-1.5">
      <span className="rounded bg-control-on-tint px-1.25 py-0.5 text-caption leading-none font-medium text-control-on">
        {t('slash.skill')}
      </span>
      {origin}
    </span>
  )
}
