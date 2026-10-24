import { useSyncExternalStore } from 'react'

/** What the controls outside the canvas show: the top bar's, or the pane header's. */
export interface CanvasState {
  zoom: number
  selected: number
  focused: number | null
  count: number
}

export interface CanvasCommands {
  zoomStep(direction: 1 | -1): void
  fitAll(): void
  focus(index: number | null): void
}

/** The canvas's state and commands for the controls around it; the view attaches its commands. */
export class CanvasControls {
  private state: CanvasState = { zoom: 1, selected: 0, focused: null, count: 0 }
  private readonly listeners = new Set<() => void>()
  private attached: CanvasCommands | null = null

  get commands(): CanvasCommands | null {
    return this.attached
  }

  /** The view's commands, until the returned function detaches them. */
  attach(commands: CanvasCommands): () => void {
    this.attached = commands
    return () => {
      if (this.attached === commands) this.attached = null
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get = (): CanvasState => this.state

  publish(patch: Partial<CanvasState>): void {
    const next = { ...this.state, ...patch }
    if (
      next.zoom === this.state.zoom &&
      next.selected === this.state.selected &&
      next.focused === this.state.focused &&
      next.count === this.state.count
    ) {
      return
    }
    this.state = next
    for (const listener of this.listeners) listener()
  }
}

export function useCanvasState(controls: CanvasControls): CanvasState {
  return useSyncExternalStore(controls.subscribe, controls.get)
}
