import { hostOfPath } from '@renderer/lib/host-paths'
import { i18n } from '@renderer/lib/i18n'
import { otherHosts, useHostsStore } from '@renderer/stores/hosts'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useViewStore } from '@renderer/stores/view'

/** The window's title: Kettu, with the other host the session in front is on before it. */
export function windowTitle(): string {
  const { main, settings } = useViewStore.getState()
  if (settings.open || main.kind !== 'session') return 'Kettu'
  const summary = useSessionsStore.getState().byId[main.sessionId]
  const hostId = summary ? hostOfPath(summary.projectPath) : null
  const host = hostId && otherHosts(useHostsStore.getState()).find((h) => h.id === hostId)
  return host ? i18n.t('windowTitle.onHost', { host: host.name }) : 'Kettu'
}

/** Keeps the window's title, which the system's window lists show, naming the host. */
export function followWindowTitle(): void {
  const update = () => {
    const title = windowTitle()
    if (document.title !== title) document.title = title
  }
  useViewStore.subscribe(update)
  useSessionsStore.subscribe(update)
  useHostsStore.subscribe(update)
  update()
}
