import { useLayoutEffect, type RefObject } from 'react'
import { useSessionDragStore } from '@renderer/features/split/session-drag-model'
import { useOverlayStore } from '@renderer/stores/overlays'
import { prefersReducedMotion, useSettingsStore } from '@renderer/stores/settings'
import { useViewStore } from '@renderer/stores/view'
import { NARROW_WINDOW } from './narrow'

// Pointing at a collapsed sidebar's toggle shows the sidebar over the page, so a New session or
// another session is one click away without opening it and collapsing it again.

/** The time on the toggle before the sidebar shows, so a pointer passing by does not open it. */
const OPEN_DELAY = 120
/** The time off the toggle and the sidebar before it goes, so a short slip does not close it. */
const CLOSE_DELAY = 300
/** The fade of a sidebar going away; the same as `.kettu-peek-out` in affect.css. */
const FADE = 160

let openTimer: ReturnType<typeof setTimeout> | undefined
let closeTimer: ReturnType<typeof setTimeout> | undefined
let fadeTimer: ReturnType<typeof setTimeout> | undefined
// Whether the pointer is on the toggle, the corner's controls or the sidebar.
let over = false

const setPeek = (sidebarPeek: 'open' | 'closing' | null): void =>
  useViewStore.setState({ sidebarPeek })

function canPeek(): boolean {
  return (
    useSettingsStore.getState().settings.appearance.sidebarHover &&
    useViewStore.getState().sidebarCollapsed &&
    !window.matchMedia(NARROW_WINDOW).matches
  )
}

// The shell's own menus, such as the account's, are not in the overlay store; their button says so.
const MENU_OPEN = '.ui-as-app > .ui-as-side [aria-haspopup][aria-expanded="true"]'

// A menu or dialog it opened, a row being renamed or a session being dragged out of it keeps the
// sidebar until it ends: closing would take away what they stand on.
function held(): boolean {
  return (
    Object.keys(useOverlayStore.getState().open).length > 0 ||
    useViewStore.getState().renamingIn !== null ||
    useSessionDragStore.getState().dragging !== null ||
    document.querySelector(MENU_OPEN) !== null
  )
}

function show(): void {
  clearTimeout(fadeTimer)
  setPeek('open')
}

function hide(): void {
  clearTimeout(openTimer)
  clearTimeout(closeTimer)
  over = false
  if (useViewStore.getState().sidebarPeek !== 'open') return
  if (prefersReducedMotion()) return setPeek(null)
  setPeek('closing')
  fadeTimer = setTimeout(() => setPeek(null), FADE)
}

/** Takes the sidebar away at once, as when it is shown for good or the window is narrow. */
function drop(): void {
  clearTimeout(openTimer)
  clearTimeout(closeTimer)
  clearTimeout(fadeTimer)
  over = false
  if (useViewStore.getState().sidebarPeek !== null) setPeek(null)
}

// Closes it a moment after the pointer is off it and nothing holds it, looking again while
// something does.
function settle(): void {
  clearTimeout(closeTimer)
  if (over || useViewStore.getState().sidebarPeek !== 'open') return
  closeTimer = setTimeout(() => (held() ? settle() : hide()), CLOSE_DELAY)
}

/** The pointer came onto the toggle: the sidebar shows once it stays there. */
export function pointAtToggle(): void {
  over = true
  clearTimeout(closeTimer)
  const { sidebarPeek } = useViewStore.getState()
  if (sidebarPeek === 'closing') show()
  if (sidebarPeek || !canPeek()) return
  clearTimeout(openTimer)
  openTimer = setTimeout(show, OPEN_DELAY)
}

/** The pointer left the toggle for the corner's other controls or for outside them. */
export function leaveToggle(): void {
  clearTimeout(openTimer)
}

/**
 * Wires the collapsed sidebar's peek: the pointer on the sidebar or the corner's controls keeps it
 * shown, leaving both closes it, and going to another place, a click on the toggle or Escape puts
 * it away. `frame` holds the window's frame, whose sidebar and corner it finds.
 */
export function useSidebarPeek(frame: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const root = frame.current
    const regions = [
      root?.querySelector('.ui-as-app > .ui-as-side'),
      root?.querySelector('.ui-as-corner__tools'),
    ].filter((element): element is Element => !!element)
    const enter = (event: Event): void => {
      if ((event as PointerEvent).pointerType === 'touch') return
      over = true
      clearTimeout(closeTimer)
      // Back on it while it fades out.
      if (useViewStore.getState().sidebarPeek === 'closing') show()
    }
    const leave = (event: Event): void => {
      if ((event as PointerEvent).pointerType === 'touch') return
      over = false
      clearTimeout(openTimer)
      settle()
    }
    for (const region of regions) {
      region.addEventListener('pointerenter', enter)
      region.addEventListener('pointerleave', leave)
    }
    // Before the page's own handlers, so Escape that closes a menu or dialog leaves the sidebar.
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && useViewStore.getState().sidebarPeek === 'open' && !held())
        hide()
    }
    window.addEventListener('keydown', escape, true)

    const narrow = window.matchMedia(NARROW_WINDOW)
    narrow.addEventListener('change', drop)

    const stops = [
      useViewStore.subscribe((state, previous) => {
        // Shown for good, which puts the floating one away too.
        if (!state.sidebarCollapsed && previous.sidebarCollapsed) return drop()
        if (state.sidebarPeek !== 'open') return
        // Opening a place, Settings or Search from it puts it away, as the narrow window's drawer.
        if (
          state.main !== previous.main ||
          (state.settings.open && !previous.settings.open) ||
          (state.searchOpen && !previous.searchOpen)
        )
          return hide()
      }),
      useSettingsStore.subscribe((state, previous) => {
        if (
          state.settings.appearance.sidebarHover !== previous.settings.appearance.sidebarHover &&
          !state.settings.appearance.sidebarHover
        )
          drop()
      }),
    ]
    return () => {
      for (const region of regions) {
        region.removeEventListener('pointerenter', enter)
        region.removeEventListener('pointerleave', leave)
      }
      window.removeEventListener('keydown', escape, true)
      narrow.removeEventListener('change', drop)
      for (const stop of stops) stop()
      drop()
    }
  }, [frame])
}
