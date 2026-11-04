// The interface runtime capabilities are served through: each handler registers by name with the
// operations it answers. Nothing dispatches page requests to the handlers in this build yet.

/** Who asks: the artifact a page belongs to, as its client named it, and its declaration. */
export interface CapabilityContext {
  artifactId: string
  project: string | null
  version: number
  declared: readonly string[]
  client: string
  signal: AbortSignal
}

export interface CapabilityHandler {
  name: string
  /** Whether the user must agree before a page may use it. */
  consent: boolean
  ops: readonly string[]
  call(ctx: CapabilityContext, op: string, args: unknown): Promise<unknown>
  stream?(
    ctx: CapabilityContext,
    op: string,
    args: unknown,
    emit: (event: unknown) => void,
  ): Promise<void>
}

const handlers = new Map<string, CapabilityHandler>()

export function registerCapability(handler: CapabilityHandler): void {
  handlers.set(handler.name, handler)
}
