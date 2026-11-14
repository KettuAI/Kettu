import { useEffect } from 'react'

// The account menu and the plan ring's popover open in the same place and never together.
let closeMenu: (() => void) | null = null

/** Lets the plan ring close the account menu while it is open. */
export function useMenuClose(close: () => void): void {
  useEffect(() => {
    closeMenu = close
    return () => {
      if (closeMenu === close) closeMenu = null
    }
  }, [close])
}

/** Closes the account menu if it is open. */
export function closeAccountMenu(): void {
  closeMenu?.()
}
