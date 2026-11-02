import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Popover } from '@base-ui/react/popover'
import { AtSignIcon, CameraIcon, FolderIcon, ImageIcon, PlusIcon, SlashIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AgentId, SlashCommand } from '@shared/thread'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Button } from '@renderer/components/ui/button'
import { InputGroup, InputGroupAddon } from '@renderer/components/ui/input-group'
import { Kbd } from '@renderer/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { formatShortcut, isWeb } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { useBrowserStore } from '@renderer/stores/browser'
import { shownSidePane, useViewStore } from '@renderer/stores/view'
import { TextDialog, type TextDialogTarget } from '../attachments/text-dialog'
import { aboveBox } from './above-box'
import { AttachmentTray } from './attachment-tray'
import { attachMention } from './attachments'
import { ComposerEditor } from './editor'
import { MentionFooter, MentionItem } from './mention-popover'
import {
  insertAt,
  mentionAt,
  mentionName,
  mentionShown,
  moveHighlight,
  popoverKey,
  replaceMention,
  type MentionRow,
} from './mentions'
import { usePromptChips } from './prompt-chips'
import { orderSlashMatches } from './slash'
import { useMentionList, type MentionList } from './use-mention-list'
import type { PromptBoxState } from './use-prompt-box'

// The box both composers share, the session's and New session's: the text with its slash and `@`
// popovers, the attachments and **+**, kept in a draft. What sends, and how, is each one's own.

type PopoverItem = SlashCommand | MentionRow

const isMentionRow = (item: PopoverItem): item is MentionRow => 'positions' in item

/** The prompt box: the attachments, **+**, the text and its popovers, then `end`. */
export function PromptBox({
  box,
  agentId,
  agentName,
  commands,
  placeholder,
  label,
  size,
  top,
  wrap = false,
  stacked = false,
  lead,
  end,
  onKeyDown,
}: {
  box: PromptBoxState
  agentId: AgentId | null
  agentName: string
  commands: SlashCommand[]
  placeholder: string
  label: string
  /** The text's least height, its padding and its line height, as CSS lengths. */
  size: { minHeight: string; padding: string; lineHeight?: string }
  /** What the box shows before the attachments, such as a notice; `wrap` while it shows. */
  top?: ReactNode
  wrap?: boolean
  /** The text over a row of **+** and `end`, as on New session, rather than between them. */
  stacked?: boolean
  /** With `stacked`, what follows **+** on the row, such as New session's project and agent. */
  lead?: ReactNode
  /** What follows the text on its last line, such as Send. */
  end: ReactNode
  /** A key the popovers left to the composer, which calls preventDefault on one it takes. */
  onKeyDown: (event: KeyboardEvent) => void
}) {
  const { t } = useTranslation('composer')
  const {
    draft,
    projectPath,
    disabled,
    text,
    attachments,
    update,
    editor,
    caret,
    setCaret,
    slashDismissed,
    setSlashDismissed,
  } = box
  // The `@` whose popover Esc or a click elsewhere closed.
  const [mentionDismissed, setMentionDismissed] = useState<number | null>(null)
  // While an input method composes: whether the mention popover was open when it started.
  const [composition, setComposition] = useState<{ open: boolean } | null>(null)
  const [popover, setPopover] = useState<'slash' | MentionList | null>(null)
  const [viewing, setViewing] = useState<TextDialogTarget | null>(null)
  // The highlighted row, for the list `list` names.
  const [highlight, setHighlight] = useState({ list: '', index: 0 })
  const group = useRef<HTMLDivElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const listId = useId()

  const slashQuery = text.startsWith('/') && !/\s/.test(text) ? text.slice(1).toLowerCase() : null
  const slashMatches = slashQuery === null ? [] : orderSlashMatches(commands, slashQuery)
  const slashOpen = slashQuery !== null && slashMatches.length > 0 && !slashDismissed

  const mention = mentionAt(text, caret)
  if (mentionDismissed !== null && mention?.start !== mentionDismissed) setMentionDismissed(null)
  const shown = mentionShown(mention, mentionDismissed, composition)
  const mentions = useMentionList(draft, projectPath, shown ? mention!.query : null)
  const filesReady = !!mentions.files && !(mentions.files.error && !mentions.files.paths.length)
  // With nothing typed it shows the files the session used and how many there are to search;
  // typed, only while something matches. With no project it says to choose one.
  const mentionOpen =
    shown &&
    (mentions.noProject ||
      mentions.used ||
      mentions.rows.length > 0 ||
      (mention!.query !== '' && !filesReady))
  // What the popup shows, kept after it closes so it fades out as it was.
  const showing = slashOpen ? 'slash' : mentionOpen ? mentions : popover
  if (showing !== popover) setPopover(showing)
  const listing = typeof showing === 'object' ? showing : null
  const open = slashOpen || mentionOpen
  const rows: PopoverItem[] = showing === 'slash' ? slashMatches : listing ? listing.rows : []
  // A list opens, and a new query starts, on its first row.
  const listKey = slashOpen
    ? `/${slashQuery}`
    : mentionOpen
      ? `@${mention!.start}:${mention!.query}`
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
    const next = replaceMention(text, mention, mentionName(row))
    update(next.text, next.caret)
    box.limitError(attachMention(draft, projectPath, row.path, row.folder))
  }
  const chooseItem = (item: PopoverItem | undefined) => {
    if (!item) return
    if (isMentionRow(item)) choose(item)
    else update(`/${item.name} `)
  }
  const highlightRow = (index: number) => {
    if (index !== active) setHighlight({ list: listKey, index })
  }
  const dismiss = () => {
    if (slashOpen) setSlashDismissed(true)
    if (mentionOpen && mention) setMentionDismissed(mention.start)
  }
  const [focused, setFocused] = useState(false)
  const chips = usePromptChips({
    draft,
    sessionId: box.sessionId,
    text,
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
    const before = `${text.slice(0, mention.start)}@${row.path}/`
    update(`${before}${text.slice(mention.start + 1 + mention.query.length)}`, before.length)
  }

  // The session's composer puts **+** in its control row; New session's stays in the box.
  const addMenu = stacked && <AddMenu box={box} agentName={agentName} commands={commands} />

  const keyDown = (event: KeyboardEvent): boolean => {
    const modified = event.shiftKey || event.ctrlKey || event.altKey || event.metaKey
    const handling = popoverKey(event.key, {
      composing: event.isComposing || event.keyCode === 229,
      modified,
      slashOpen,
      mentionOpen,
      mentionRows: mentions.rows.length > 0,
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
    if (handling === 'popover' && event.key === 'Escape') {
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
    onKeyDown(event)
    return event.defaultPrevented
  }
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
      <InputGroup
        ref={group}
        variant="composer"
        data-disabled={disabled || undefined}
        className={cn(
          !stacked && 'min-h-13 gap-1.5 py-2 pr-2 pl-4',
          !stacked && (attachments.length > 0 || wrap) && 'flex-wrap',
        )}
      >
        {top}
        <AttachmentTray
          draft={draft}
          sessionId={box.sessionId}
          agentId={agentId}
          agentName={agentName}
          projectPath={projectPath}
          onOpen={setViewing}
          onPasteAsText={box.pasteAsText}
          onError={box.setError}
          onLeave={box.focus}
          hidden={chips.hidden}
        />
        {/* With a basis, the text wraps under the attachments instead of sharing their row. */}
        <div className={cn('min-w-0', stacked ? 'w-full' : 'flex-[1_1_12rem] self-stretch')}>
          <ComposerEditor
            ref={editor}
            initialText={text}
            label={label}
            placeholder={placeholder}
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
            onCompositionStart={() => setComposition({ open: mentionOpen })}
            onCompositionEnd={() => setComposition(null)}
          />
        </div>
        {stacked ? (
          <InputGroupAddon align="block-end" className="flex-wrap gap-1.5 px-3 pb-3">
            {addMenu}
            {lead}
            {/* Kept together at the end, on a line of its own when the row runs out of room. */}
            <div className="ml-auto flex items-center gap-1.5">{end}</div>
          </InputGroupAddon>
        ) : (
          <InputGroupAddon
            align="inline-end"
            className="mb-0.5 gap-1.5 self-end p-0 has-[>button]:mr-0"
          >
            {end}
          </InputGroupAddon>
        )}
      </InputGroup>
      <Popover.Root open={open} onOpenChange={openChange}>
        <Popover.Portal>
          <Popover.Positioner
            anchor={group}
            side="top"
            align="start"
            sideOffset={6}
            className="isolate z-50 outline-none"
          >
            <Popover.Popup
              ref={popup}
              initialFocus={false}
              finalFocus={false}
              className={cn(
                'flex max-h-[min(var(--available-height),320px)] origin-(--transform-origin) flex-col overflow-hidden bg-popover text-popover-foreground shadow-menu animation-duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
                'rounded-xl p-1',
                showing === 'slash'
                  ? 'w-[min(var(--anchor-width),470px)]'
                  : 'w-[min(var(--anchor-width),340px)]',
              )}
            >
              {rows.length > 0 && (
                <div
                  id={`${listId}-label`}
                  className="flex h-6.5 shrink-0 items-center px-2 text-small font-medium text-tertiary"
                >
                  {showing === 'slash'
                    ? agentName
                    : listing?.used
                      ? t('mentions.used')
                      : t('mentions.files')}
                </div>
              )}
              <div
                role="listbox"
                id={listId}
                aria-labelledby={`${listId}-label`}
                className={cn(
                  'min-h-0 flex-1 scroll-fade-y overflow-y-auto overscroll-contain',
                  rows.length === 0 && 'hidden',
                )}
              >
                {rows.map((item, index) =>
                  isMentionRow(item) ? (
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
                      key={item.name}
                      id={optionId(index)}
                      command={item}
                      highlighted={index === active}
                      onHighlight={() => highlightRow(index)}
                      onChoose={() => chooseItem(item)}
                    />
                  ),
                )}
              </div>
              {listing && <MentionFooter list={listing} />}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      {chips.overlays}
      <TextDialog target={viewing} onClose={() => setViewing(null)} />
    </>
  )
}

/** A slash command's row: its name in code type, then what it does. */
function SlashItem({
  id,
  command,
  highlighted,
  onHighlight,
  onChoose,
}: {
  id: string
  command: SlashCommand
  highlighted: boolean
  onHighlight: () => void
  onChoose: () => void
}) {
  return (
    <div
      role="option"
      id={id}
      aria-selected={highlighted}
      data-highlighted={highlighted ? '' : undefined}
      // Pressing a row keeps the focus, and with it the caret, in the box.
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={onHighlight}
      onClick={onChoose}
      className="flex min-h-control cursor-default items-center gap-2.5 rounded-md px-2 text-ui outline-none select-none data-highlighted:bg-selected"
    >
      <span className="shrink-0 font-mono text-hint">/{command.name}</span>
      {command.description && (
        <span className="min-w-0 truncate text-tertiary">{command.description}</span>
      )}
    </div>
  )
}

/**
 * **+**: adds files, photos or a folder through the system dialog, or starts a mention or a
 * slash command. The session's composer shows it in its control row, New session's in its box.
 */
export function AddMenu({
  box,
  agentName,
  commands,
}: {
  box: PromptBoxState
  agentName: string
  commands: readonly SlashCommand[]
}) {
  const { t } = useTranslation('composer')
  const { disabled, full, remote, text, editor, update, sessionId } = box
  const shortcut = formatShortcut('Mod+U')
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null)
  const hasPage = useBrowserStore((s) => {
    const page = sessionId ? s.bySession[sessionId] : undefined
    // An evicted page keeps its address for the pane, with no live page behind it.
    return !!page?.url && page.notice?.kind !== 'evicted'
  })
  // Only a page in front draws a frame to capture; the pane shows the main session's.
  const pageShown = useViewStore(
    (s) =>
      shownSidePane(s) === 'browser' && s.main.kind === 'session' && s.main.sessionId === sessionId,
  )
  const emptyDraft = text === ''
  const startMention = () => {
    const current = editor.current?.text() ?? text
    const { from, to } = editor.current?.selection() ?? { from: current.length, to: current.length }
    const next = insertAt(current, from, to)
    update(next.text, next.caret)
  }
  const button = {
    variant: 'quiet',
    size: 'icon-sm',
    'aria-label': t('attachments.add'),
    className: 'size-7.5 text-secondary',
  } as const
  const icon = <PlusIcon strokeWidth={1.35} className="size-4.25" />
  if (disabled) {
    // A disabled button takes no pointer, so the tooltip says why from around it.
    return (
      <Tooltip>
        <TooltipTrigger render={<span />}>
          <Button {...button} disabled>
            {icon}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('attachments.waitForAgent', { agent: agentName })}</TooltipContent>
      </Tooltip>
    )
  }
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={<DropdownMenuTrigger render={<Button {...button} ref={setTrigger} />} />}
        >
          {icon}
        </TooltipTrigger>
        <TooltipContent>
          {t('attachments.add')}
          <Kbd>{shortcut}</Kbd>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="top"
        sideOffset={aboveBox(trigger)}
        className="w-max min-w-66"
        finalFocus={() => {
          box.focus()
          return false
        }}
      >
        <DropdownMenuItem disabled={full} onClick={() => box.pick('files')}>
          <ImageIcon />
          {t('attachments.addFiles')}
          <DropdownMenuShortcut>{full ? t('attachments.atMost') : shortcut}</DropdownMenuShortcut>
        </DropdownMenuItem>
        {/* A folder here, or a browser's, means nothing on the host. */}
        {!isWeb && !remote && (
          <DropdownMenuItem disabled={full} onClick={() => box.pick('folder')}>
            <FolderIcon />
            {t('attachments.addFolder')}
            {full && <DropdownMenuShortcut>{t('attachments.atMost')}</DropdownMenuShortcut>}
          </DropdownMenuItem>
        )}
        {/* The session's own browser tab, which New session and the web client have none of. */}
        {!isWeb && sessionId && (
          <DropdownMenuItem disabled={full || !hasPage || !pageShown} onClick={box.screenshot}>
            <CameraIcon />
            {t('attachments.screenshot')}
            {(full || !hasPage || !pageShown) && (
              <DropdownMenuShortcut>
                {full
                  ? t('attachments.atMost')
                  : hasPage
                    ? t('attachments.openBrowser')
                    : t('attachments.noPage')}
              </DropdownMenuShortcut>
            )}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={startMention}>
          <AtSignIcon />
          {t('attachments.mentionFile')}
          <DropdownMenuShortcut>@</DropdownMenuShortcut>
        </DropdownMenuItem>
        {commands.length > 0 && (
          <DropdownMenuItem disabled={!emptyDraft} onClick={() => update('/')}>
            <SlashIcon />
            {t('attachments.slashCommands')}
            <DropdownMenuShortcut>
              {emptyDraft ? '/' : t('attachments.slashNeedsEmpty')}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
