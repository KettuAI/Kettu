// The globals the shared code may use: the part of the web platform that browsers, Node.js and
// React Native with Expo's runtime all provide. Only the package's own type check reads this file;
// the processes' type checks take the DOM's or Node's declarations instead.

/* eslint-disable no-var -- a global the runtime defines is a var, as in TypeScript's own libraries */

type TimerHandle = { readonly __timer: unique symbol }
declare function setTimeout(handler: (...args: never[]) => void, timeout?: number): TimerHandle
declare function clearTimeout(handle: TimerHandle | undefined): void
declare function setInterval(handler: (...args: never[]) => void, timeout?: number): TimerHandle
declare function clearInterval(handle: TimerHandle | undefined): void
declare function queueMicrotask(callback: () => void): void

declare function structuredClone<T>(value: T): T
declare function atob(data: string): string
declare function btoa(data: string): string

declare var console: {
  log(...data: unknown[]): void
  info(...data: unknown[]): void
  warn(...data: unknown[]): void
  error(...data: unknown[]): void
  debug(...data: unknown[]): void
}

interface TextEncoder {
  encode(input?: string): Uint8Array<ArrayBuffer>
}
declare var TextEncoder: { new (): TextEncoder }

interface TextDecoder {
  decode(input?: ArrayBuffer | ArrayBufferView, options?: { stream?: boolean }): string
}
declare var TextDecoder: {
  new (label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }): TextDecoder
}

interface URLSearchParams {
  append(name: string, value: string): void
  delete(name: string): void
  get(name: string): string | null
  getAll(name: string): string[]
  has(name: string): boolean
  set(name: string, value: string): void
  toString(): string
  forEach(callback: (value: string, key: string) => void): void
}
declare var URLSearchParams: {
  new (init?: string | Record<string, string> | [string, string][]): URLSearchParams
}

interface URL {
  hash: string
  host: string
  hostname: string
  href: string
  readonly origin: string
  password: string
  pathname: string
  port: string
  protocol: string
  search: string
  readonly searchParams: URLSearchParams
  username: string
  toString(): string
  toJSON(): string
}
declare var URL: {
  new (url: string | URL, base?: string | URL): URL
  /** Missing from some runtimes, which add it before loading the shared code. */
  parse(url: string | URL, base?: string | URL): URL | null
  canParse(url: string | URL, base?: string | URL): boolean
}

interface EventTargetLike<Events> {
  addEventListener<K extends keyof Events>(
    type: K,
    listener: (event: Events[K]) => void,
    options?: { once?: boolean; signal?: AbortSignal },
  ): void
  removeEventListener<K extends keyof Events>(type: K, listener: (event: Events[K]) => void): void
}

interface Event {
  readonly type: string
}

interface AbortSignal extends EventTargetLike<{ abort: Event }> {
  readonly aborted: boolean
  readonly reason: unknown
  throwIfAborted(): void
}
declare var AbortSignal: {
  prototype: AbortSignal
  new (): AbortSignal
  /** Missing from some runtimes, which add it before loading the shared code. */
  timeout(milliseconds: number): AbortSignal
  any(signals: AbortSignal[]): AbortSignal
  abort(reason?: unknown): AbortSignal
}

interface AbortController {
  readonly signal: AbortSignal
  abort(reason?: unknown): void
}
declare var AbortController: { new (): AbortController }

interface DOMException extends Error {
  readonly code: number
}
declare var DOMException: { new (message?: string, name?: string): DOMException }

interface Blob {
  readonly size: number
  readonly type: string
  arrayBuffer(): Promise<ArrayBuffer>
  text(): Promise<string>
}
declare var Blob: {
  new (
    parts?: (ArrayBuffer | ArrayBufferView<ArrayBuffer> | Blob | string)[],
    options?: { type?: string },
  ): Blob
}

/** A file the desktop's API names; no runtime outside a browser makes one. */
interface File extends Blob {
  readonly name: string
}

interface FormData {
  append(name: string, value: string | Blob, fileName?: string): void
  set(name: string, value: string | Blob, fileName?: string): void
}
declare var FormData: { new (): FormData }

interface Headers {
  get(name: string): string | null
  has(name: string): boolean
  set(name: string, value: string): void
}

interface RequestInit {
  method?: string
  headers?: Record<string, string>
  body?:
    string | Blob | FormData | URLSearchParams | ArrayBuffer | ArrayBufferView<ArrayBuffer> | null
  redirect?: 'follow' | 'error' | 'manual'
  signal?: AbortSignal | null
  cache?: 'default' | 'no-store' | 'reload' | 'no-cache' | 'force-cache' | 'only-if-cached'
  credentials?: 'omit' | 'same-origin' | 'include'
}

interface Response {
  readonly ok: boolean
  readonly status: number
  readonly statusText: string
  readonly headers: Headers
  readonly url: string
  arrayBuffer(): Promise<ArrayBuffer>
  json(): Promise<unknown>
  text(): Promise<string>
  blob(): Promise<Blob>
}

declare function fetch(input: string | URL, init?: RequestInit): Promise<Response>

interface MessageEvent<T = unknown> extends Event {
  readonly data: T
}

interface CloseEvent extends Event {
  readonly code: number
  readonly reason: string
  readonly wasClean: boolean
}

interface WebSocketEventMap {
  open: Event
  message: MessageEvent
  close: CloseEvent
  error: Event
}

interface WebSocket extends EventTargetLike<WebSocketEventMap> {
  binaryType: 'arraybuffer' | 'blob'
  /** Not kept by every runtime; reads 0 where it is not. */
  readonly bufferedAmount: number
  readonly protocol: string
  readonly readyState: number
  readonly url: string
  close(code?: number, reason?: string): void
  send(data: string | ArrayBuffer | ArrayBufferView<ArrayBuffer>): void
  readonly CONNECTING: 0
  readonly OPEN: 1
  readonly CLOSING: 2
  readonly CLOSED: 3
}
declare var WebSocket: {
  new (url: string | URL, protocols?: string | string[]): WebSocket
  readonly CONNECTING: 0
  readonly OPEN: 1
  readonly CLOSING: 2
  readonly CLOSED: 3
}

// WebCrypto: browsers in a secure context and Node.js have it. Where `crypto.subtle` is missing,
// the channel runs on the noble primitives, and only `getRandomValues` is needed.
interface CryptoKey {
  readonly algorithm: { name: string }
  readonly extractable: boolean
  readonly type: 'private' | 'public' | 'secret'
  readonly usages: string[]
}
declare var CryptoKey: { prototype: CryptoKey; new (): CryptoKey }

interface CryptoKeyPair {
  privateKey: CryptoKey
  publicKey: CryptoKey
}

interface JsonWebKey {
  crv?: string
  d?: string
  kty?: string
  x?: string
  y?: string
}

type CryptoBytes = ArrayBuffer | ArrayBufferView<ArrayBuffer>
type CryptoAlgorithm = string | { name: string; [key: string]: unknown }

interface SubtleCrypto {
  digest(algorithm: CryptoAlgorithm, data: CryptoBytes): Promise<ArrayBuffer>
  importKey(
    format: 'raw' | 'pkcs8' | 'spki' | 'jwk',
    keyData: CryptoBytes | JsonWebKey,
    algorithm: CryptoAlgorithm,
    extractable: boolean,
    usages: string[],
  ): Promise<CryptoKey>
  exportKey(format: 'raw' | 'pkcs8' | 'spki', key: CryptoKey): Promise<ArrayBuffer>
  exportKey(format: 'jwk', key: CryptoKey): Promise<JsonWebKey>
  generateKey(
    algorithm: CryptoAlgorithm,
    extractable: boolean,
    usages: string[],
  ): Promise<CryptoKeyPair | CryptoKey>
  deriveBits(algorithm: CryptoAlgorithm, baseKey: CryptoKey, length: number): Promise<ArrayBuffer>
  encrypt(algorithm: CryptoAlgorithm, key: CryptoKey, data: CryptoBytes): Promise<ArrayBuffer>
  decrypt(algorithm: CryptoAlgorithm, key: CryptoKey, data: CryptoBytes): Promise<ArrayBuffer>
  sign(algorithm: CryptoAlgorithm, key: CryptoKey, data: CryptoBytes): Promise<ArrayBuffer>
  verify(
    algorithm: CryptoAlgorithm,
    key: CryptoKey,
    signature: CryptoBytes,
    data: CryptoBytes,
  ): Promise<boolean>
}

declare var crypto: {
  getRandomValues<T extends ArrayBufferView>(array: T): T
  randomUUID(): string
  readonly subtle: SubtleCrypto
}

// Browsers and Node.js only: a runtime without them gives the channel its own raw deflate.
interface ReadableStreamReadResult<T> {
  done: boolean
  value: T
}
interface ReadableStreamDefaultReader<T> {
  read(): Promise<ReadableStreamReadResult<T>>
  cancel(reason?: unknown): Promise<void>
}
interface ReadableStream<T = Uint8Array<ArrayBuffer>> {
  getReader(): ReadableStreamDefaultReader<T>
  pipeThrough<O>(transform: { readable: ReadableStream<O>; writable: unknown }): ReadableStream<O>
}
interface Blob {
  stream(): ReadableStream
}
declare var Response: {
  new (body?: ReadableStream | Blob | string | null): Response
}
declare var CompressionStream: {
  new (format: 'deflate' | 'deflate-raw' | 'gzip'): {
    readable: ReadableStream
    writable: unknown
  }
}
declare var DecompressionStream: {
  new (format: 'deflate' | 'deflate-raw' | 'gzip'): {
    readable: ReadableStream
    writable: unknown
  }
}
