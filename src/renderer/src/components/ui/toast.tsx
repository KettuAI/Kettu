import { useEffect, useId } from 'react'
import { Toast } from '@base-ui/react/toast'
import { useOverlayStore } from '@renderer/stores/overlays'

const manager = Toast.createToastManager()

/**
 * Confirms a finished action at the foot of the window, such as a removal whose row is gone. An
 * action, such as Undo, keeps the toast up longer and closes it when chosen.
 */
export function toast(title: string, action?: { label: string; onClick: () => void }) {
  if (!action) {
    manager.add({ title })
    return
  }
  const id: string = manager.add({
    title,
    timeout: 6000,
    actionProps: {
      children: action.label,
      onClick: () => {
        manager.close(id)
        action.onClick()
      },
    },
  })
}

/** The toasts' layer, mounted once at the app's root. */
export function Toaster() {
  return (
    <Toast.Provider toastManager={manager} timeout={4000} limit={1}>
      <Toast.Portal>
        <Toast.Viewport className="fixed bottom-5.5 left-1/2 z-50 grid w-max max-w-105 -translate-x-1/2 outline-none">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  )
}

function ToastList() {
  const { toasts } = Toast.useToastManager()
  const id = useId()
  const shown = toasts.length > 0
  // A toast can cover the browser pane's native view, as a menu can.
  useEffect(() => {
    useOverlayStore.getState().set(id, shown)
    return () => useOverlayStore.getState().set(id, false)
  }, [id, shown])
  return toasts.map((item) => (
    <Toast.Root
      key={item.id}
      toast={item}
      swipeDirection={[]}
      data-overlay-layer=""
      className="col-start-1 row-start-1 flex min-h-9 min-w-0 items-center gap-1.5 justify-self-center rounded-xl bg-foreground px-3.5 py-1 text-command text-background has-[button]:pr-1 transition-[opacity,translate] duration-(--duration-base) ease-out-quart data-ending-style:opacity-0 data-limited:hidden data-starting-style:opacity-0 motion-safe:data-starting-style:translate-y-1"
    >
      <Toast.Title className="min-w-0 flex-1 truncate" />
      <Toast.Action className="h-6 shrink-0 rounded-md px-2 text-xs font-semibold text-background outline-none hover:bg-background/20 focus-ring" />
    </Toast.Root>
  ))
}
