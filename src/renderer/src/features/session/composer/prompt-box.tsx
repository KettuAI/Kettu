import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Popover } from '@base-ui/react/popover'
import { AtSignIcon, FileIcon, FolderIcon, PlusIcon, SlashIcon } from 'lucide-react'
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
import { InputGroup, InputGroupAddon, InputGroupButton } from '@renderer/components/ui/input-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { formatShortcut } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { TextDialog, type TextDialogTarget } from '../attachments/text-dialog'
import { AttachmentTray } from './attachment-tray'
import { attachMention } from './attachments'
import { ComposerEditor } from './editor'
import { MentionFooter, MentionHeader, MentionItem } from './mention-popover'
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
import { orderSlashMatches } from './slash'
import { useMentionList, type MentionList } from './use-mention-list'
import type { PromptBoxState } from './use-prompt-box'

// The box both composers share, the session's and New session's: the text with its slash and `@`
// popovers, the attachments and **+**, kept in a draft. What sends, and how, is each one's own.

type PopoverItem = SlashCommand | MentionRow

// 8 px from the list: the rows sit 6 px inside its edge.
const TIP_OFFSET = 14

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
  end,
  onKeyDown,
}: {
  box: PromptBoxState
  agentId: AgentId | null
  agentName: string
  commands: SlashCommand[]
  placeholder: string
  label: string
  /** The text's least height and its padding, as CSS lengths. */
  size: { minHeight: string; padding: string }
  /** What the box shows before the attachments, such as a notice; `wrap` while it shows. */
  top?: ReactNode
  wrap?: boolean
  /** The text over a row of **+** and `end`, as on New session, rather than between them. */
  stacked?: boolean
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
  const startMention = () => {
    const current = editor.current?.text() ?? text
    const { from, to } = editor.current?.selection() ?? { from: current.length, to: current.length }
    const next = insertAt(current, from, to)
    update(next.text, next.caret)
  }
  const hint = (() => {
    if (text === '/' && slashOpen) return t('slash.typeToFilter')
    const match = /^\/(\S+)\s$/.exec(text)
    return match ? commands.find((c) => c.name === match[1])?.inputHint : undefined
  })()
  const commandNames = useMemo(() => commands.map((c) => c.name), [commands])

  // The highlighted command's description, in a tooltip 8 px beside the list, whichever row it is.
  const tipText = slashOpen ? (rows[active] as SlashCommand | undefined)?.description : undefined
  const tipOpen = !!tipText
  const tipAnchor = useCallback(
    () => document.getElementById(`${listId}-${active}`),
    [listId, active],
  )

  const addMenu = (
    <AddMenu
      agentName={agentName}
      disabled={disabled}
      full={box.full}
      commands={commands.length > 0}
      emptyDraft={text === ''}
      onFocusBox={box.focus}
      onPick={box.pick}
      onSlash={() => update('/')}
      onMention={startMention}
    />
  )

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
    if (handling === 'popover' || handling === 'choose') {
      chooseItem(rows[active])
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
    if (event.relatedTarget instanceof Node && popup.current?.contains(event.relatedTarget)) return
    dismiss()
  }

  return (
    <>
      <InputGroup
        ref={group}
        variant="composer"
        data-disabled={disabled || undefined}
        className={cn(!stacked && (attachments.length > 0 || wrap) && 'flex-wrap')}
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
        />
        {/* After the tiles in the DOM, so they keep the first row when the box wraps. */}
        {!stacked && (
          <InputGroupAddon align="inline-start" className="order-none self-end pb-3 pl-3">
            {addMenu}
          </InputGroupAddon>
        )}
        {/* With a basis, the text wraps under the attachments instead of sharing their row. */}
        <div className={cn('min-w-0', stacked ? 'w-full' : 'flex-[1_1_12rem] self-stretch')}>
          <ComposerEditor
            ref={editor}
            initialText={text}
            label={label}
            placeholder={placeholder}
            disabled={disabled}
            hint={hint}
            commands={commandNames}
            size={size}
            popover={open ? { listId, activeId: active >= 0 ? optionId(active) : undefined } : null}
            onChange={box.changed}
            onCaret={setCaret}
            onKeyDown={keyDown}
            onPaste={box.onPaste}
            onFocus={() => box.onActivity?.()}
            onBlur={blur}
            onCompositionStart={() => setComposition({ open: mentionOpen })}
            onCompositionEnd={() => setComposition(null)}
          />
        </div>
        {stacked ? (
          <InputGroupAddon align="block-end" className="gap-1.5 px-3 pb-3">
            {addMenu}
            <span className="flex-1" />
            {end}
          </InputGroupAddon>
        ) : (
          <InputGroupAddon align="inline-end" className="self-end gap-1.5 pr-3 pb-3 pl-1">
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
                showing === 'slash'
                  ? 'w-max max-w-80 min-w-40 rounded-2xl'
                  : 'w-[min(var(--anchor-width),420px)] rounded-xl',
              )}
            >
              {listing?.used && listing.rows.length > 0 && <MentionHeader id={`${draft}-used`} />}
              <div
                role="listbox"
                id={listId}
                aria-labelledby={listing?.used ? `${draft}-used` : undefined}
                aria-label={listing && !listing.used ? t('mentions.label') : undefined}
                className={cn(
                  'min-h-0 flex-1 scroll-fade-y overflow-y-auto overscroll-contain',
                  showing === 'slash' ? 'p-1.5' : 'p-1',
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
      {/* Keyed by the row: a tooltip does not follow its anchor to another row on its own. */}
      <Tooltip key={`${listKey}:${active}`} open={tipOpen}>
        <TooltipContent
          anchor={tipAnchor}
          side="right"
          sideOffset={TIP_OFFSET}
          className="pointer-events-none motion-reduce:data-closed:animate-none motion-reduce:data-open:animate-none"
        >
          {tipText}
        </TooltipContent>
      </Tooltip>
      <TextDialog target={viewing} onClose={() => setViewing(null)} />
    </>
  )
}

/** A slash command's row: its name alone; the description shows in a tooltip. */
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
      aria-description={command.description || undefined}
      data-highlighted={highlighted ? '' : undefined}
      // Pressing a row keeps the focus, and with it the caret, in the box.
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={onHighlight}
      onClick={onChoose}
      className="flex min-h-row cursor-default items-center rounded-lg px-2 py-1 text-ui outline-none select-none data-highlighted:bg-accent"
    >
      <span className="truncate">{command.name}</span>
    </div>
  )
}

/**
 * **+**: adds files, photos or a folder through the system dialog, or starts a mention or a
 * slash command.
 */
function AddMenu({
  agentName,
  disabled,
  full,
  commands,
  emptyDraft,
  onFocusBox,
  onPick,
  onSlash,
  onMention,
}: {
  agentName: string
  disabled: boolean
  full: boolean
  commands: boolean
  emptyDraft: boolean
  onFocusBox: () => void
  onPick: (kind: 'files' | 'folder') => void
  onSlash: () => void
  onMention: () => void
}) {
  const { t } = useTranslation('composer')
  const shortcut = formatShortcut('Mod+U')
  if (disabled) {
    // A disabled button takes no pointer, so the tooltip says why from around it.
    return (
      <Tooltip>
        <TooltipTrigger render={<span />}>
          <InputGroupButton size="round" variant="quiet" aria-label={t('attachments.add')} disabled>
            <PlusIcon />
          </InputGroupButton>
        </TooltipTrigger>
        <TooltipContent>{t('attachments.waitForAgent', { agent: agentName })}</TooltipContent>
      </Tooltip>
    )
  }
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <InputGroupButton size="round" variant="quiet" aria-label={t('attachments.add')} />
              }
            />
          }
        >
          <PlusIcon />
        </TooltipTrigger>
        <TooltipContent>
          {t('attachments.add')} <span className="opacity-60">{shortcut}</span>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="top"
        sideOffset={6}
        finalFocus={() => {
          onFocusBox()
          return false
        }}
      >
        <DropdownMenuItem disabled={full} onClick={() => onPick('files')}>
          <FileIcon />
          {t('attachments.addFiles')}
          <DropdownMenuShortcut>{full ? t('attachments.atMost') : shortcut}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={full} onClick={() => onPick('folder')}>
          <FolderIcon />
          {t('attachments.addFolder')}
          {full && <DropdownMenuShortcut>{t('attachments.atMost')}</DropdownMenuShortcut>}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onMention}>
          <AtSignIcon />
          {t('attachments.mentionFile')}
          <DropdownMenuShortcut>@</DropdownMenuShortcut>
        </DropdownMenuItem>
        {commands && (
          <DropdownMenuItem disabled={!emptyDraft} onClick={onSlash}>
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
