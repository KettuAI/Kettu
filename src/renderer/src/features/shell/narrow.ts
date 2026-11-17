import { useSyncExternalStore } from 'react'

/** App Shell turns the sidebar into a drawer at this window width and below. */
export const NARROW_WINDOW = '(max-width: 900px)'

function subscribe(onChange: () => void): () => void {
  const list = window.matchMedia(NARROW_WINDOW)
  list.addEventListener('change', onChange)
  return () => list.removeEventListener('change', onChange)
}

/** Whether the window is narrow enough that the sidebar is a drawer over the main area. */
export function useNarrowWindow(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(NARROW_WINDOW).matches)
}

/** A phone's width, as the `phone` variant in globals.css; the desktop window is never this narrow. */
export const PHONE_WINDOW = '(max-width: 719px)'

/** Whether the window is a phone's width now, for code outside rendering. */
export function isPhoneWindow(): boolean {
  return window.matchMedia(PHONE_WINDOW).matches
}

function subscribePhone(onChange: () => void): () => void {
  const list = window.matchMedia(PHONE_WINDOW)
  list.addEventListener('change', onChange)
  return () => list.removeEventListener('change', onChange)
}

/** Whether the window is a phone's width, where each surface is laid out for a phone. */
export function usePhoneWindow(): boolean {
  return useSyncExternalStore(subscribePhone, isPhoneWindow)
}
