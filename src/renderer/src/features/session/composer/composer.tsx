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
  attachmentContent,
  attachmentsBlock,
  pastedImages,
  pickAttachments,
} from './attachments'
import { ControlRow } from './control-row'
import { clearDraft, flushDraft, readDraft, writeDraft } from './drafts'

type BaseUIKeyboardEvent = KeyboardEvent<HTMLTextAreaElement> & {
  preventBaseUIHandler?: () => void
}

/** The prompt box and the session's controls under it. */
export function Composer({ session, agentName }: { session: SessionView; agentName: string }) {
  const { t } = useTranslation('composer')
  const sessionId = session.id
  const [text, setText] = useState(() => readDraft(sessionId))
  const [error, setError] = useState<string | null>(null)
  const [slashDismissed, setSlashDismissed] = useState(false)
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

  const update = (next: string) => {
    setText(next)
    writeDraft(sessionId, next)
    if (!next.startsWith('/')) setSlashDismissed(false)
  }

  const take = (): { prompt: string; held: DraftAttachment[] } => {
    const prompt = text
    const held = attachments
    setText('')
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
  const hint = (() => {
    const match = /^\/(\S+)\s$/.exec(text)
    return match ? commands.find((c) => c.name === match[1])?.inputHint : undefined
  })()

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // IME composition: Enter confirms the candidate, it never sends.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (slashOpen && (event.key === 'Enter' || event.key === 'Tab' || event.key === 'Escape'))
      return
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
      <Autocomplete.Root
        items={commands}
        value={text}
        onValueChange={(value) => update(value)}
        open={slashOpen}
        onOpenChange={(open) => {
          if (!open) setSlashDismissed(true)
        }}
        filter={(command: SlashCommand, query: string) =>
          query.startsWith('/') && command.name.toLowerCase().includes(query.slice(1).toLowerCase())
        }
        itemToStringValue={(command: SlashCommand) => `/${command.name} `}
        autoHighlight
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
              <Autocomplete.List className="min-h-0 flex-1 scroll-fade-y overflow-y-auto overscroll-contain p-1">
                {(command: SlashCommand) => (
                  <Autocomplete.Item
                    key={command.name}
                    value={command}
                    className="flex min-h-row cursor-default items-baseline gap-2 rounded-md px-2 py-1 text-ui outline-none select-none data-highlighted:bg-accent"
                  >
                    <span className="shrink-0 font-mono text-xs">/{command.name}</span>
                    <span className="min-w-0 truncate text-muted-foreground">
                      {command.description}
                    </span>
                  </Autocomplete.Item>
                )}
              </Autocomplete.List>
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

/** **+**: adds files, photos or a folder through the system dialog, or starts a slash command. */
function AddMenu({
  agentName,
  starting,
  full,
  commands,
  emptyDraft,
  textarea,
  onPick,
  onSlash,
}: {
  agentName: string
  starting: boolean
  full: boolean
  commands: boolean
  emptyDraft: boolean
  textarea: RefObject<HTMLTextAreaElement | null>
  onPick: (kind: 'files' | 'folder') => void
  onSlash: () => void
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
        {commands && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!emptyDraft} onClick={onSlash}>
              {t('attachments.slashCommands')}
              <DropdownMenuShortcut>
                {emptyDraft ? '/' : t('attachments.slashNeedsEmpty')}
              </DropdownMenuShortcut>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
