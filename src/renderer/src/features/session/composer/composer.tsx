import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import { Autocomplete } from '@base-ui/react/autocomplete'
import { ArrowUpIcon, ListPlusIcon, PlusIcon, SquareIcon } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { ATTACHMENT_LIMIT } from '@shared/attachments'
import type { SessionView, SlashCommand, UserContent } from '@shared/thread'
import { onAppEvent, type AppEvent } from '@renderer/app/events'
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
import { limitLabel, resetTime } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { formatShortcut, isMod } from '@renderer/lib/platform'
import { useAgentsStore } from '@renderer/stores/agents'
import {
  selectDraft,
  setDraftAttachments,
  useAttachmentsStore,
  type DraftAttachment,
} from '@renderer/stores/attachments'
import { useSettingsStore } from '@renderer/stores/settings'
import { cn } from '@renderer/lib/utils'
import { ImageDialog, type ImageDialogTarget } from '../attachments/image-dialog'
import { AttachmentTray } from './attachment-tray'
import {
  attachFiles,
  attachImages,
  attachMention,
  attachmentContent,
  attachmentsBlock,
  pastedImages,
  pickAttachments,
} from './attachments'
import { ControlRow } from './control-row'
import { clearDraft, flushDraft, readDraft, writeDraft } from './drafts'
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

type BaseUIKeyboardEvent = KeyboardEvent<HTMLTextAreaElement> & {
  preventBaseUIHandler?: () => void
}

type PopoverItem = SlashCommand | MentionRow

const isMentionRow = (item: PopoverItem): item is MentionRow => 'positions' in item

/** The prompt box and the session's controls under it. */
export function Composer({ session, agentName }: { session: SessionView; agentName: string }) {
  const { t } = useTranslation('composer')
  const sessionId = session.id
  const [text, setText] = useState(() => readDraft(sessionId))
  const [error, setError] = useState<string | null>(null)
  const [slashDismissed, setSlashDismissed] = useState(false)
  // The caret, or null while a range is selected, for telling which `@` word it is in.
  const [caret, setCaret] = useState<number | null>(null)
  // The `@` whose popover Esc or a click elsewhere closed.
  const [mentionDismissed, setMentionDismissed] = useState<number | null>(null)
  // While an input method composes: whether the mention popover was open when it started.
  const [composition, setComposition] = useState<{ open: boolean } | null>(null)
  const [popover, setPopover] = useState<'slash' | MentionList | null>(null)
  const pendingCaret = useRef<number | null>(null)
  const highlighted = useRef<PopoverItem | undefined>(undefined)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const group = useRef<HTMLDivElement>(null)
  const sendKey = useSettingsStore((s) => s.settings.general.sendKey)
  const limits = useAgentsStore((s) => s.byId[session.agentId]?.limits)
  const steering = useAgentsStore((s) => !!s.byId[session.agentId]?.capabilities.steering)
  const attachments = useAttachmentsStore(selectDraft(sessionId))
  const [viewing, setViewing] = useState<ImageDialogTarget | null>(null)

  const status = session.status
  const starting = status === 'starting'
  const running = status === 'running' || status === 'awaiting_permission'
  const awaiting = status === 'awaiting_permission'
  // A closed session attaches to its agent as the message goes.
  const idle = status === 'ready' || status === 'closed'
  const blocked = attachmentsBlock(attachments, text)
  const hasMessage = text.trim().length > 0 || attachments.length > 0
  const canSend = idle && hasMessage && !blocked
  // During a turn the send key queues the message and the steer key sends it into the turn.
  const canQueue = running && hasMessage && !blocked
  const queueKey = sendKey === 'enter' ? 'Enter' : 'Mod+Enter'
  const steerKey = sendKey === 'enter' ? 'Mod+Enter' : 'Mod+Shift+Enter'
  const reached = limits?.find((l) => l.state === 'reached')
  // Claude Code turns on ultracode for a message that says the word; no config option sets it.
  const ultracode = session.agentId === 'claude-code' && /\bultracode\b/i.test(text)

  useEffect(() => () => flushDraft(sessionId), [sessionId])

  // A pick that is still open, or waiting for its grants, makes a second one a no-op.
  const picking = useRef(false)
  const full = attachments.length >= ATTACHMENT_LIMIT
  const pick = (kind: 'files' | 'folder') => {
    if (starting || picking.current) return
    if (full) {
      setError(t('attachments.limit'))
      return
    }
    picking.current = true
    pickAttachments(sessionId, kind, session.projectPath)
      .then(
        (left) => setError(left > 0 ? t('attachments.limit') : null),
        (e: unknown) => setError(errorMessage(e)),
      )
      .finally(() => {
        picking.current = false
      })
  }
  const onEvent = useEffectEvent((event: AppEvent) => {
    if (event.kind === 'add-attachments') pick('files')
    if (event.kind === 'drop-attachments' && event.sessionId === sessionId && !starting) {
      attachFiles(sessionId, event.files).then(
        (left) => setError(left > 0 ? t('attachments.limit') : null),
        (e: unknown) => setError(errorMessage(e)),
      )
    }
  })

  useEffect(
    () =>
      onAppEvent((event) => {
        onEvent(event)
        if (event.kind === 'focus-composer') textarea.current?.focus()
        if (
          event.kind === 'insert-into-composer' &&
          (!event.sessionId || event.sessionId === sessionId)
        ) {
          setText((current) => {
            const next = current ? `${current.replace(/\s+$/, '')}\n\n${event.text}` : event.text
            writeDraft(sessionId, next)
            return next
          })
          requestAnimationFrame(() => {
            const el = textarea.current
            if (!el) return
            el.focus()
            el.setSelectionRange(el.value.length, el.value.length)
          })
        }
      }),
    [sessionId],
  )

  // A chosen mention or `@` from the menu puts the caret after what it wrote.
  useLayoutEffect(() => {
    const at = pendingCaret.current
    const el = textarea.current
    if (at === null || !el) return
    pendingCaret.current = null
    el.setSelectionRange(at, at)
  }, [text])

  // A textarea scrolls only the caret into view, not its padding, so typing at the end of a long
  // draft would leave the last line on the box's edge.
  useLayoutEffect(() => {
    const el = textarea.current
    if (!el || document.activeElement !== el || el.selectionEnd !== el.value.length) return
    if (el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight
  }, [text])

  // Starting a session focuses the composer, as the reference does.
  useEffect(() => {
    if (status === 'ready' && document.activeElement === document.body) textarea.current?.focus()
  }, [status])

  const update = (next: string, at?: number) => {
    setText(next)
    writeDraft(sessionId, next)
    if (!next.startsWith('/')) setSlashDismissed(false)
    if (at !== undefined) {
      pendingCaret.current = at
      setCaret(at)
      return
    }
    const el = textarea.current
    setCaret(el && el.selectionStart === el.selectionEnd ? el.selectionStart : null)
  }

  const take = (): { prompt: string; held: DraftAttachment[] } => {
    const prompt = text
    const held = attachments
    setText('')
    // A draft put back after a failed send opens no mention until the caret moves.
    setCaret(null)
    clearDraft(sessionId)
    setDraftAttachments(sessionId, [])
    setError(null)
    return { prompt, held }
  }
  const restore =
    ({ prompt, held }: { prompt: string; held: DraftAttachment[] }) =>
    (e: unknown) => {
      setError(errorMessage(e))
      setText((current) => (current ? current : prompt))
      if (held.length > 0) setDraftAttachments(sessionId, held)
    }

  // Both go through the host's queue, which sends at once when the session is free.
  const send = () => {
    if (canSend || canQueue) queue(false)
  }

  const queue = (steer: boolean) => {
    const taken = take()
    const content: UserContent[] = [
      ...(taken.prompt.trim() ? [{ type: 'text' as const, text: taken.prompt }] : []),
      ...attachmentContent(taken.held),
    ]
    host('sessions.queue', { sessionId, content })
      .then(({ itemId }) => {
        // Once queued, a failed steer leaves the message in the queue, not lost.
        if (steer && itemId) {
          host('sessions.steer', { sessionId, itemId }).catch((e: unknown) =>
            setError(errorMessage(e)),
          )
        }
      })
      .catch(restore(taken))
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = pastedImages(event.clipboardData)
    if (images.length === 0) return
    event.preventDefault()
    const left = attachImages(sessionId, images)
    setError(left > 0 ? t('attachments.limit') : null)
  }

  const cancel = () => {
    host('sessions.cancel', { sessionId }).catch((e: unknown) => setError(errorMessage(e)))
  }

  const commands = session.commands
  const slashQuery = text.startsWith('/') && !/\s/.test(text) ? text.slice(1).toLowerCase() : null
  const slashMatches =
    slashQuery === null ? [] : commands.filter((c) => c.name.toLowerCase().includes(slashQuery))
  const slashOpen = slashQuery !== null && slashMatches.length > 0 && !slashDismissed

  const mention = mentionAt(text, caret)
  if (mentionDismissed !== null && mention?.start !== mentionDismissed) setMentionDismissed(null)
  const shown = mentionShown(mention, mentionDismissed, composition)
  const mentions = useMentionList(sessionId, session.projectPath, shown ? mention!.query : null)
  const filesReady = !!mentions.files && !(mentions.files.error && !mentions.files.paths.length)
  // With nothing typed it shows the files the session used and how many there are to search;
  // typed, only while something matches.
  const mentionOpen =
    shown && (mentions.used || mentions.rows.length > 0 || (mention!.query !== '' && !filesReady))
  // What the popup shows, kept after it closes so it fades out as it was.
  const showing = slashOpen ? 'slash' : mentionOpen ? mentions : popover
  if (showing !== popover) setPopover(showing)
  const listing = typeof showing === 'object' ? showing : null
  const choose = (row: MentionRow) => {
    if (!mention) return
    const next = replaceMention(text, mention, mentionName(row))
    update(next.text, next.caret)
    const left = attachMention(sessionId, session.projectPath, row.path, row.folder)
    setError(left > 0 ? t('attachments.limit') : null)
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

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
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
    if (event.key === 'Escape' && running) {
      event.preventDefault()
      cancel()
      return
    }
    if (event.key !== 'Enter') return
    const sends = sendKey === 'enter' ? !event.shiftKey && !isMod(event) : isMod(event)
    const steers =
      running &&
      steering &&
      (sendKey === 'enter' ? isMod(event) && !event.shiftKey : isMod(event) && event.shiftKey)
    if (steers) {
      event.preventDefault()
      if (canQueue) queue(true)
      return
    }
    if (!sends) return
    event.preventDefault()
    send()
  }

  const placeholder = starting
    ? t('prompt.placeholder.starting', { agent: agentName })
    : awaiting
      ? t('prompt.placeholder.awaiting')
      : running
        ? t(steering ? 'prompt.placeholder.steer' : 'prompt.placeholder.queue', {
            agent: agentName,
            queue: formatShortcut(queueKey),
            steer: formatShortcut(steerKey),
          })
        : reached?.resetsAt
          ? t('prompt.placeholder.limitReached', {
              limit: limitLabel(reached),
              time: resetTime(reached.resetsAt),
            })
          : t('prompt.placeholder.ask', { agent: agentName })

  const compact = commands.some((c) => c.name === 'compact')
    ? () => {
        if (!idle) return
        host('sessions.prompt', { sessionId, content: [{ type: 'text', text: '/compact' }] }).catch(
          (e: unknown) => setError(errorMessage(e)),
        )
      }
    : null

  return (
    <div className="flex flex-col gap-1">
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
          data-disabled={starting || undefined}
          className={cn(attachments.length > 0 && 'flex-wrap')}
        >
          <AttachmentTray
            draft={sessionId}
            agentId={session.agentId}
            agentName={agentName}
            projectPath={session.projectPath}
            onOpen={setViewing}
            onError={setError}
            onLeave={() => textarea.current?.focus()}
          />
          {/* After the tiles in the DOM, so they keep the first row when the box wraps. */}
          <InputGroupAddon align="inline-start" className="order-none self-end pb-3 pl-3">
            <AddMenu
              agentName={agentName}
              starting={starting}
              full={full}
              commands={commands.length > 0}
              emptyDraft={text === ''}
              textarea={textarea}
              onPick={pick}
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
                  aria-label={t('prompt.label', { agent: agentName })}
                  placeholder={placeholder}
                  disabled={starting}
                  onKeyDown={onKeyDown}
                  onPaste={onPaste}
                  onSelect={(event) => {
                    const el = event.currentTarget
                    setCaret(el.selectionStart === el.selectionEnd ? el.selectionStart : null)
                  }}
                  onCompositionStart={() => setComposition({ open: mentionOpen })}
                  onCompositionEnd={() => setComposition(null)}
                  className="max-h-[min(40svh,24rem)] min-h-(--composer-min) py-4 pr-1 pl-1.5 text-prose leading-6 placeholder:text-placeholder md:text-prose"
                />
              }
            />
            {hint && (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 overflow-hidden py-4 pr-1 pl-1.5 text-prose leading-6 whitespace-pre"
              >
                <span className="invisible">{text}</span>
                <span className="text-placeholder">{hint}</span>
              </div>
            )}
          </div>
          <InputGroupAddon align="inline-end" className="self-end gap-1.5 pr-3 pb-3 pl-1">
            {canQueue && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <InputGroupButton
                      key="queue"
                      size="round"
                      variant="secondary"
                      aria-label={t('prompt.queue')}
                      onClick={() => queue(false)}
                      className="animate-in zoom-in-75 fade-in animation-duration-(--duration-fast)"
                    />
                  }
                >
                  <ListPlusIcon />
                </TooltipTrigger>
                <TooltipContent>
                  <Trans
                    t={t}
                    i18nKey={steering ? 'prompt.queueSteerTooltip' : 'prompt.queueTooltip'}
                    values={{
                      queueShortcut: formatShortcut(queueKey),
                      steerShortcut: formatShortcut(steerKey),
                    }}
                    components={{ shortcut: <span className="opacity-60" /> }}
                  />
                </TooltipContent>
              </Tooltip>
            )}
            {running ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <InputGroupButton
                      key="stop"
                      size="round"
                      variant="default"
                      aria-label={t('prompt.stop')}
                      onClick={cancel}
                      className="animate-in zoom-in-75 fade-in animation-duration-(--duration-fast)"
                    />
                  }
                >
                  <SquareIcon className="size-3 fill-current" />
                </TooltipTrigger>
                <TooltipContent>
                  <Trans
                    t={t}
                    i18nKey="prompt.stopTooltip"
                    values={{ shortcut: 'Esc' }}
                    components={{ shortcut: <span className="opacity-60" /> }}
                  />
                </TooltipContent>
              </Tooltip>
            ) : blocked && hasMessage ? (
              // A disabled button takes no pointer, so the tooltip says why from around it.
              <Tooltip>
                <TooltipTrigger render={<span key="send" />}>
                  <InputGroupButton
                    size="round"
                    variant="secondary"
                    aria-label={t('prompt.send')}
                    disabled
                  >
                    <ArrowUpIcon />
                  </InputGroupButton>
                </TooltipTrigger>
                <TooltipContent>{blocked.message}</TooltipContent>
              </Tooltip>
            ) : (
              <InputGroupButton
                key="send"
                size="round"
                variant={canSend ? 'default' : 'secondary'}
                aria-label={t('prompt.send')}
                disabled={!canSend}
                onClick={send}
                className="animate-in zoom-in-75 fade-in animation-duration-(--duration-fast)"
              >
                <ArrowUpIcon />
              </InputGroupButton>
            )}
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
              {listing?.used && listing.rows.length > 0 && (
                <MentionHeader id={`${sessionId}-used`} />
              )}
              <Autocomplete.List
                aria-labelledby={listing?.used ? `${sessionId}-used` : undefined}
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
      {/* Holds the row's height while the agent starts, so nothing jumps when the options arrive. */}
      <div className="flex min-h-row flex-col">
        {(error || blocked?.notice) && (
          <p className="animate-in px-2 pt-1 text-xs text-danger fade-in" role="alert">
            {error ?? blocked?.message}
          </p>
        )}
        {!starting && <ControlRow session={session} onCompact={compact} ultracode={ultracode} />}
      </div>
      <ImageDialog target={viewing} onClose={() => setViewing(null)} />
    </div>
  )
}

/**
 * **+**: adds files, photos or a folder through the system dialog, or starts a mention or a
 * slash command.
 */
function AddMenu({
  agentName,
  starting,
  full,
  commands,
  emptyDraft,
  textarea,
  onPick,
  onSlash,
  onMention,
}: {
  agentName: string
  starting: boolean
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
  if (starting) {
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
          {t('attachments.addFiles')}
          <DropdownMenuShortcut>{full ? t('attachments.atMost') : shortcut}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={full} onClick={() => onPick('folder')}>
          {t('attachments.addFolder')}
          {full && <DropdownMenuShortcut>{t('attachments.atMost')}</DropdownMenuShortcut>}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onMention}>
          {t('attachments.mentionFile')}
          <DropdownMenuShortcut>@</DropdownMenuShortcut>
        </DropdownMenuItem>
        {commands && (
          <DropdownMenuItem disabled={!emptyDraft} onClick={onSlash}>
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
