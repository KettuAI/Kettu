import { useShallow } from 'zustand/react/shallow'
import type { RoutineView } from '@shared/routines'
import { routineHost } from '@renderer/lib/host'
import { routinesRead, useRoutinesStore, type RoutinesRead } from '@renderer/stores/routines'
import { useShowsHost, useWindowHost, useWindowHostAway } from '@renderer/stores/window-host'

export interface WindowRoutines {
  /** The routines of the host the window shows, or of every host while it shows them all. */
  routines: RoutineView[]
  /** The chosen host's last read; this computer's while every host shows. */
  read: RoutinesRead
  /** The host the window shows, null being this computer; undefined while it shows them all. */
  hostId: string | null | undefined
  /** The window is narrowed to a host that is away: the list is what was last read from it. */
  away: boolean
}

/** The routines of the hosts the window shows, in the store's order. */
export function useShownRoutines(): RoutineView[] {
  const shows = useShowsHost()
  return useRoutinesStore(
    useShallow((s) =>
      s.order
        .filter((id) => shows(routineHost(id)))
        .map((id) => s.byId[id])
        .filter((routine): routine is RoutineView => !!routine),
    ),
  )
}

export function useWindowRoutines(): WindowRoutines {
  const host = useWindowHost()
  const hostId = host.kind === 'one' ? host.hostId : undefined
  const away = useWindowHostAway() !== null
  const routines = useShownRoutines()
  const read = useRoutinesStore(useShallow((s) => routinesRead(s, hostId ?? null)))
  return { routines, read, hostId, away }
}
