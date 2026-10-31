// How a host is reached, whatever carries it: a utility process's MessagePorts in the desktop app,
// the IPC of `child_process.fork` and a local socket under Node.js.

/** One client's port to a host, carrying plain JSON values both ways. */
export interface PortChannel<Out = unknown> {
  send(message: Out): void
  /** Messages that arrive before a listener is set wait for it. */
  onMessage(listener: (data: unknown) => void): void
  onClose(listener: () => void): void
  close(): void
}

/** A host's link to the process that started it: that process's messages in, the host's out. */
export interface ControlChannel<In, Out> {
  send(message: Out): void
  onMessage(listener: (message: In) => void): void
}
