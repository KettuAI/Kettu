// What a page's capability namespaces send their requests through.

export interface CapabilityTransport {
  call(cap: string, op: string, args: unknown): Promise<unknown>
  /** Returns what cancels the stream. */
  stream(cap: string, op: string, args: unknown, onEvent: (event: unknown) => void): () => void
}
