// The window's side of the page runtime in each artifact frame: what drives the frame, posted into
// it, and the picks it reports, which reach this page only checked. On the desktop they come from
// main, which took them from the page's own origin; in the web client, over the port this page
// hands the frame, where a capability's message is answered as by a client that offers none.

import {
  noCapability,
  parsePageMessage,
  parseSelectMessage,
  RUNTIME_VERSION,
  type DriveMessage,
  type PageSelection,
  type SelectMessage,
} from '@shared/artifact-runtime/page-messages'
import { isWeb } from '@renderer/lib/platform'

/** The picks a frame may report each second over its port; more are dropped. */
const PICKS_PER_SECOND = 20

type PickListener = (selection: PageSelection | null) => void

const channels = new Map<string, { origin: string; listener: PickListener }>()
let listening = false

function deliver(origin: string, message: SelectMessage): void {
  const entry = channels.get(message.channel)
  if (entry && entry.origin === origin) entry.listener(message.selection)
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

type Sticky = 'select-mode' | 'select-pins' | 'select-source'

/**
 * One frame's link: messages into its page, of which the last mode, pins and pick are sent again
 * whenever the frame loads a page, and the picks it reports, for `listener`.
 */
export class FrameLink {
  readonly channel = newChannel()
  private frame: HTMLIFrameElement | null = null
  private port: MessagePort | null = null
  private readonly sticky = new Map<Sticky, DriveMessage>()
  private second = 0
  private picks = 0

  /** `origin` is the artifact's URL as `artifact:open` gave it, without its last slash. */
  constructor(
    private readonly origin: string,
    private readonly listener: PickListener,
  ) {}

  /** Takes the frame's picks, until `dispose`. */
  open(): void {
    channels.set(this.channel, { origin: this.origin, listener: this.listener })
    listen()
  }

  attach(frame: HTMLIFrameElement | null): void {
    this.frame = frame
    if (!frame) this.closePort()
  }

  /** The frame loaded a page: its port on the web, and what drives it, again. */
  loaded(): void {
    if (isWeb) this.connect()
    for (const message of this.sticky.values()) this.send(message)
  }

  post(message: DriveMessage): void {
    if (
      message.kind === 'select-mode' ||
      message.kind === 'select-pins' ||
      message.kind === 'select-source'
    ) {
      this.sticky.set(message.kind, message)
    }
    this.send(message)
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
    this.port?.close()
    this.port = null
  }

  private connect(): void {
    const target = this.frame?.contentWindow
    if (!target) return
    this.closePort()
    const { port1, port2 } = new MessageChannel()
    this.port = port1
    port1.onmessage = (event) => {
      const parsed = parsePageMessage(event.data)
      if (!parsed) return
      if (parsed.kind === 'select') {
        if (parsed.message.channel !== this.channel || !this.allowPick()) return
        deliver(this.origin, parsed.message)
        return
      }
      if (parsed.message.kind === 'cancel') return
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
