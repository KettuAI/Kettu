import { useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { Autocomplete } from '@base-ui/react/autocomplete'
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
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@renderer/components/ui/input-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { formatShortcut } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { ImageDialog, type ImageDialogTarget } from '../attachments/image-dialog'
import { AttachmentTray } from './attachment-tray'
import { attachMention } from './attachments'
import { MentionFooter, MentionHeader, MentionItem } from './mention-popover'
import {
  insertAt,
  mentionAt,
  mentionName,
  mentionShown,
  popoverKey,
  replaceMention,
  type MentionRow,
} from './mentions'
import { useMentionList, type MentionList } from './use-mention-list'
import type { PromptBoxState } from './use-prompt-box'

// The box both composers share, the session's and New session's: the text with its slash and `@`
// popovers, the attachments and **+**, kept in a draft. What sends, and how, is each one's own.

type BaseUIKeyboardEvent = KeyboardEvent<HTMLTextAreaElement> & {
  preventBaseUIHandler?: () => void
}

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
  className,
  end,
  onKeyDown,
}: {
  box: PromptBoxState
  agentId: AgentId | null
  agentName: string
  commands: SlashCommand[]
  placeholder: string
  label: string
  /** The text area's size and padding. */
  className: string
  /** What follows the text on its last line, such as Send. */
  end: ReactNode
  /** A key the popovers left to the composer. */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
}) {
  const { t } = useTranslation('composer')
  const {
    draft,
    projectPath,
    disabled,
    text,
    attachments,
    update,
    textarea,
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
  const [viewing, setViewing] = useState<ImageDialogTarget | null>(null)
  const highlighted = useRef<PopoverItem | undefined>(undefined)
  const group = useRef<HTMLDivElement>(null)

  const slashQuery = text.startsWith('/') && !/\s/.test(text) ? text.slice(1).toLowerCase() : null
  const slashMatches =
    slashQuery === null ? [] : commands.filter((c) => c.name.toLowerCase().includes(slashQuery))
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
  const choose = (row: MentionRow) => {
    if (!mention || !projectPath) return
    const next = replaceMention(text, mention, mentionName(row))
    update(next.text, next.caret)
    box.limitError(attachMention(draft, projectPath, row.path, row.folder))
  }
  const startMention = () => {
    const el = textarea.current
    const from = el?.selectionStart ?? text.length
    const next = insertAt(text, from, el?.selectionEnd ?? from)
    update(next.text, next.caret)
    el?.focus()
  }
  const hint = (() => {
    const match = /^\/(\S+)\s$/.exec(text)
    return match ? commands.find((c) => c.name === match[1])?.inputHint : undefined
  })()

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const handling = popoverKey(event.key, {
      composing: event.nativeEvent.isComposing || event.keyCode === 229,
      modified: event.shiftKey || event.ctrlKey || event.altKey || event.metaKey,
      slashOpen,
      mentionOpen,
      mentionRows: mentions.rows.length > 0,
    })
    // IME composition: no key reaches a popover, and Enter confirms the candidate, never sends.
    if (handling === 'block') {
      ;(event as BaseUIKeyboardEvent).preventBaseUIHandler?.()
      return
    }
    if (handling === 'popover') return
    if (handling === 'choose') {
      const item = highlighted.current
      if (item && isMentionRow(item)) {
        event.preventDefault()
        choose(item)
      }
      return
    }
    // With no list open, Base UI's autocomplete clears its input on Escape, which here is the draft.
    if (event.key === 'Escape') (event as BaseUIKeyboardEvent).preventBaseUIHandler?.()
    onKeyDown(event)
  }

  return (
    <>
      <Autocomplete.Root<PopoverItem>
        items={listing ? listing.rows : commands}
        filteredItems={listing ? listing.rows : undefined}
        value={text}
        onValueChange={(value, details) => {
          // A row the pointer was released on: the composer writes the mention, not Base UI.
          if (details.reason === 'item-press' && mentionOpen) {
            const item = highlighted.current
            if (item && isMentionRow(item)) choose(item)
            return
          }
          update(value)
        }}
        open={slashOpen || mentionOpen}
        onOpenChange={(open) => {
          if (open) return
          if (slashOpen) setSlashDismissed(true)
          if (mentionOpen && mention) setMentionDismissed(mention.start)
        }}
        onItemHighlighted={(item) => {
          highlighted.current = item
        }}
        filter={(item: PopoverItem, query: string) =>
          !isMentionRow(item) &&
          query.startsWith('/') &&
          item.name.toLowerCase().includes(query.slice(1).toLowerCase())
        }
        itemToStringValue={(item: PopoverItem) =>
          isMentionRow(item) ? `@${mentionName(item)} ` : `/${item.name} `
        }
        // A mention's first row is always the one Enter or Tab chooses.
        autoHighlight={mentionOpen ? 'always' : true}
      >
        <InputGroup
          ref={group}
          variant="composer"
          data-disabled={disabled || undefined}
          className={cn(attachments.length > 0 && 'flex-wrap')}
        >
          <AttachmentTray
            draft={draft}
            agentId={agentId}
            agentName={agentName}
            projectPath={projectPath}
            onOpen={setViewing}
            onError={box.setError}
            onLeave={() => textarea.current?.focus()}
          />
          {/* After the tiles in the DOM, so they keep the first row when the box wraps. */}
          <InputGroupAddon align="inline-start" className="order-none self-end pb-3 pl-3">
            <AddMenu
              agentName={agentName}
              disabled={disabled}
              full={box.full}
              commands={commands.length > 0}
              emptyDraft={text === ''}
              textarea={textarea}
              onPick={box.pick}
              onSlash={() => {
                update('/')
                textarea.current?.focus()
              }}
              onMention={startMention}
            />
          </InputGroupAddon>
          {/* With a basis, the text wraps under the attachments instead of sharing their row. */}
          <div className="relative min-w-0 flex-[1_1_12rem] self-stretch">
            <Autocomplete.Input
              render={
                <InputGroupTextarea
                  ref={textarea}
                  rows={1}
                  aria-label={label}
                  placeholder={placeholder}
                  disabled={disabled}
                  onKeyDown={keyDown}
                  onPaste={box.onPaste}
                  onSelect={(event) => {
                    const el = event.currentTarget
                    setCaret(el.selectionStart === el.selectionEnd ? el.selectionStart : null)
                  }}
                  onCompositionStart={() => setComposition({ open: mentionOpen })}
                  onCompositionEnd={() => setComposition(null)}
                  className={cn(
                    'max-h-[min(40svh,24rem)] pr-1 pl-1.5 text-prose leading-6 placeholder:text-placeholder md:text-prose',
                    className,
                  )}
                />
              }
            />
            {hint && (
              <div
                aria-hidden
                className={cn(
                  'pointer-events-none absolute inset-0 overflow-hidden pr-1 pl-1.5 text-prose leading-6 whitespace-pre',
                  className,
                )}
              >
                <span className="invisible">{text}</span>
                <span className="text-placeholder">{hint}</span>
              </div>
            )}
          </div>
          <InputGroupAddon align="inline-end" className="self-end gap-1.5 pr-3 pb-3 pl-1">
            {end}
          </InputGroupAddon>
        </InputGroup>
        <Autocomplete.Portal>
          <Autocomplete.Positioner
            anchor={group}
            side="top"
            align="start"
            sideOffset={6}
            className="isolate z-50 outline-none"
          >
            <Autocomplete.Popup className="max-h-[min(var(--available-height),320px)] w-[min(var(--anchor-width),420px)] flex origin-(--transform-origin) flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-menu animation-duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
              {listing?.used && listing.rows.length > 0 && <MentionHeader id={`${draft}-used`} />}
              <Autocomplete.List
                aria-labelledby={listing?.used ? `${draft}-used` : undefined}
                aria-label={listing && !listing.used ? t('mentions.label') : undefined}
                className={cn(
                  'min-h-0 flex-1 scroll-fade-y overflow-y-auto overscroll-contain p-1',
                  listing?.rows.length === 0 && 'hidden',
                )}
              >
                {(item: PopoverItem) =>
                  isMentionRow(item) ? (
                    <MentionItem
                      key={`${item.folder ? 'd' : 'f'}:${item.path}`}
                      row={item}
                      onChoose={choose}
                    />
                  ) : (
                    <Autocomplete.Item
                      key={item.name}
                      value={item}
                      className="flex min-h-row cursor-default items-baseline gap-2 rounded-md px-2 py-1 text-ui outline-none select-none data-highlighted:bg-accent"
                    >
                      <span className="shrink-0 font-mono text-xs">/{item.name}</span>
                      <span className="min-w-0 truncate text-muted-foreground">
                        {item.description}
                      </span>
                    </Autocomplete.Item>
                  )
                }
              </Autocomplete.List>
              {listing && <MentionFooter list={listing} />}
            </Autocomplete.Popup>
          </Autocomplete.Positioner>
        </Autocomplete.Portal>
      </Autocomplete.Root>
      <ImageDialog target={viewing} onClose={() => setViewing(null)} />
    </>
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
  textarea,
  onPick,
  onSlash,
  onMention,
}: {
  agentName: string
  disabled: boolean
  full: boolean
  commands: boolean
  emptyDraft: boolean
  textarea: RefObject<HTMLTextAreaElement | null>
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
      <DropdownMenuContent side="top" sideOffset={6} className="w-60" finalFocus={textarea}>
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
