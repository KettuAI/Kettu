// The namespaces `kettu.use` hands a page, built from the operations the host says it may use.
// Bundled into the page runtime; it runs in the page, so it reaches nothing but `transport`.

/** How a namespace reaches the host: one answer per call, or a stream of events until cancelled. */
export interface RuntimeTransport {
  call(cap: string, op: string, args: unknown): Promise<unknown>
  /** Returns the function that cancels the stream. */
  stream(cap: string, op: string, args: unknown, onEvent: (event: unknown) => void): () => void
}

export type CapabilityNamespace = (
  cap: string,
  ops: readonly string[],
  transport: RuntimeTransport,
) => Readonly<Record<string, unknown>> | null

/** No capability has a namespace yet, so `kettu.use` gives null for every one. */
export const capabilityNamespace: CapabilityNamespace = () => null
