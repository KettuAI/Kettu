// The window's side of the page runtime in each artifact frame: what drives the frame, posted into
// it, and the picks it reports, which reach this page only checked. On the desktop they come from
// main, which took them from the page's own origin; in the web client, over the port this page
// hands the frame, whose capability messages the web client relays to the host untouched.

import {
  noCapability,
  parsePageMessage,
  parseSelectMessage,
  RUNTIME_VERSION,
  type DriveMessage,
  type PageKey,
  type PageSelection,
  type SelectMessage,
} from '@shared/artifact-runtime/page-messages'
import type { DeckReport } from '@shared/artifact-runtime/deck-sheet'
import type { DocReport } from '@shared/artifact-runtime/document-sheet'
import { isWeb } from '@renderer/lib/platform'
import { listenPageErrors, receivePageError } from './page-errors'

/** The picks a frame may report each second over its port; more are dropped. */
const PICKS_PER_SECOND = 20

/** What a select message carries besides the pick: a located element, a pin or typed text. */
export type PickExtra = Pick<SelectMessage, 'located' | 'pin' | 'typed'>
type PickListener = (selection: PageSelection | null, extra: PickExtra) => void
type KeyListener = (key: PageKey) => void
type DocListener = (report: DocReport) => void
type DeckListener = (report: DeckReport) => void
type RuntimeRelay = (url: string, port: MessagePort) => () => void

let relay: RuntimeRelay | null = null

/**
 * The web client's relay of the capability messages the frame at `url` posts on `port`, which
 * returns the detach. The desktop app sets none, since its pages ask main.
 */
export function setRuntimeRelay(next: RuntimeRelay): void {
  relay = next
}

const channels = new Map<
  string,
  {
    origin: string
    listener: PickListener
    key: () => KeyListener | null
    doc: () => DocListener | null
    deck: () => DeckListener | null
  }
>()
let listening = false

function deliver(origin: string, message: SelectMessage): void {
  const entry = channels.get(message.channel)
  if (!entry || entry.origin !== origin) return
  if (message.key) entry.key()?.(message.key)
  else if (message.doc) entry.doc()?.(message.doc)
  else if (message.deck) entry.deck()?.(message.deck)
  else
    entry.listener(message.selection, {
      located: message.located,
      pin: message.pin,
      typed: message.typed,
    })
}

/** Main's picks, from every frame of an origin this window opened. */
function listen(): void {
  if (listening || isWeb) return
  listening = true
  window.kettu.artifacts.onSelected((event) => {
    const message = parseSelectMessage(event.message)
    if (message) deliver(event.origin, message)
  })
}

function newChannel(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

type Sticky =
  | 'select-mode'
  | 'select-pins'
  | 'select-source'
  | 'select-keys'
  | 'select-doc'
  | 'select-deck'
  | 'params'

/**
 * One frame's link: messages into its page, of which the last mode, pins and pick are sent again
 * whenever the frame loads a page, and the picks it reports, for `listener`.
 */
export class FrameLink {
  readonly channel = newChannel()
  private frame: HTMLIFrameElement | null = null
  private port: MessagePort | null = null
  /** The frame whose page holds `port`. */
  private portFrame: HTMLIFrameElement | null = null
  private detachRuntime: (() => void) | null = null
  private readonly sticky = new Map<Sticky, DriveMessage>()
  private second = 0
  private picks = 0
  private onKey: KeyListener | null = null
  private onDoc: DocListener | null = null
  private onDeck: DeckListener | null = null

  /** `origin` is the artifact's URL as `artifact:open` gave it, without its last slash. */
  constructor(
    private readonly origin: string,
    private readonly listener: PickListener,
  ) {}

  /** Moves the keyboard into the frame, where its page focuses what is typed in place. */
  focus(): void {
    this.frame?.focus()
  }

  /** Takes the frame's picks, until `dispose`. */
  open(): void {
    channels.set(this.channel, {
      origin: this.origin,
      listener: this.listener,
      key: () => this.onKey,
      doc: () => this.onDoc,
      deck: () => this.onDeck,
    })
    listen()
    listenPageErrors()
  }

  attach(frame: HTMLIFrameElement | null): void {
    this.frame = frame
    // A ref set again on each render detaches and attaches the same frame, whose page keeps its port.
    if (frame && frame !== this.portFrame) this.closePort()
  }

  /** The frame loaded a page: its port on the web, and what drives it, again. */
  loaded(): void {
    if (isWeb) this.connect()
    for (const message of this.sticky.values()) this.send(message)
  }

  /** Takes the keys the page passes on, until null, as `select-keys` asks it to. */
  keys(listener: KeyListener | null): void {
    if (listener === this.onKey) return
    const was = this.onKey !== null
    this.onKey = listener
    if (was !== (listener !== null)) {
      this.post({
        v: RUNTIME_VERSION,
        kind: 'select-keys',
        on: listener !== null,
        channel: this.channel,
      })
    }
  }

  /** Takes what a document viewer reports, until null. */
  docs(listener: DocListener | null): void {
    this.onDoc = listener
  }

  /** Takes what a slides viewer reports, until null. */
  decks(listener: DeckListener | null): void {
    this.onDeck = listener
  }

  post(message: DriveMessage): void {
    if (
      message.kind === 'select-mode' ||
      message.kind === 'select-pins' ||
      message.kind === 'select-source' ||
      message.kind === 'select-keys' ||
      message.kind === 'select-doc' ||
      message.kind === 'select-deck'
    ) {
      this.sticky.set(message.kind, message)
    }
    this.send(message)
  }

  /** Keeps a message for the next page the frame loads, without sending it to this one. */
  keep(message: DriveMessage & { kind: Sticky }): void {
    this.sticky.set(message.kind, message)
  }

  /** Sends a kept kind of message to no later page. */
  forget(kind: Sticky): void {
    this.sticky.delete(kind)
  }

  dispose(): void {
    channels.delete(this.channel)
    this.closePort()
    this.frame = null
  }

  private send(message: DriveMessage): void {
    // The page has an opaque or artifact origin of its own, which no target origin can name.
    this.frame?.contentWindow?.postMessage(message, '*')
  }

  private closePort(): void {
    this.detachRuntime?.()
    this.detachRuntime = null
    this.port?.close()
    this.port = null
    this.portFrame = null
  }

  private connect(): void {
    const target = this.frame?.contentWindow
    if (!target) return
    this.closePort()
    const { port1, port2 } = new MessageChannel()
    this.port = port1
    this.portFrame = this.frame
    const relays = relay
    this.detachRuntime = relays ? relays(`${this.origin}/`, port1) : null
    port1.onmessage = (event) => {
      const parsed = parsePageMessage(event.data)
      if (!parsed) return
      if (parsed.kind === 'select') {
        if (parsed.message.channel !== this.channel || !this.allowPick()) return
        deliver(this.origin, parsed.message)
        return
      }
      if (parsed.kind === 'error') {
        receivePageError(this.origin, parsed.message)
        return
      }
      if (relays || parsed.message.kind === 'cancel') return
      port1.postMessage(noCapability(parsed.message))
    }
    const message: DriveMessage = { v: RUNTIME_VERSION, kind: 'transport' }
    target.postMessage(message, '*', [port2])
  }

  private allowPick(): boolean {
    const second = Math.floor(Date.now() / 1000)
    if (second !== this.second) {
      this.second = second
      this.picks = 0
    }
    return ++this.picks <= PICKS_PER_SECOND
  }
}
