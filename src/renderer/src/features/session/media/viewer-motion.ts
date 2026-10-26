// Where an item flies between its place in the thread and the viewer's stage.

import type { Size } from './zoom'

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The transform, about the stage's top left, that lays `picture` over `place`, both in the
 * stage's pixels. A place that crops the picture to cover it, as a tile does, takes the picture
 * covering it with what the place leaves out clipped; `clip` is then that clip, and `full` the
 * clip that shows the whole picture.
 */
export function flight(
  place: Box,
  picture: Box,
  stage: Size,
  covers: boolean,
): { x: number; y: number; scale: number; clip: string | null; full: string | null } {
  const scale = covers
    ? Math.max(place.width / picture.width, place.height / picture.height)
    : place.width / picture.width
  const cx = picture.x + picture.width / 2
  const cy = picture.y + picture.height / 2
  const x = place.x + place.width / 2 - scale * cx
  const y = place.y + place.height / 2 - scale * cy
  if (!covers) return { x, y, scale, clip: null, full: null }
  const shown = { width: place.width / scale, height: place.height / scale }
  const inset = (box: Box) =>
    `inset(${box.y}px ${stage.width - box.x - box.width}px ${stage.height - box.y - box.height}px ${box.x}px)`
  return {
    x,
    y,
    scale,
    clip: inset({
      x: cx - shown.width / 2,
      y: cy - shown.height / 2,
      width: shown.width,
      height: shown.height,
    }),
    full: inset(picture),
  }
}

/** The element with an item's key: its place in the thread or the composer. */
export function placeOf(key: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-viewer-key="${CSS.escape(key)}"]`)
}

/** What a place shows of its picture, and whether it crops it to cover its box. */
export function placeBox(place: HTMLElement): { box: Box; covers: boolean } {
  const shown =
    place instanceof HTMLImageElement ? place : place.querySelector<HTMLElement>('img, video')
  const rect = (shown ?? place).getBoundingClientRect()
  const covers = shown instanceof HTMLImageElement && getComputedStyle(shown).objectFit === 'cover'
  return { box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, covers }
}

/** Whether at least half of a place shows: within the window and every box that clips it. */
export function inView(place: HTMLElement): boolean {
  const rect = place.getBoundingClientRect()
  let left = Math.max(rect.left, 0)
  let top = Math.max(rect.top, 0)
  let right = Math.min(rect.right, window.innerWidth)
  let bottom = Math.min(rect.bottom, window.innerHeight)
  for (let at = place.parentElement; at && right > left && bottom > top; at = at.parentElement) {
    const style = getComputedStyle(at)
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue
    const clip = at.getBoundingClientRect()
    left = Math.max(left, clip.left)
    top = Math.max(top, clip.top)
    right = Math.min(right, clip.right)
    bottom = Math.min(bottom, clip.bottom)
  }
  const area = rect.width * rect.height
  return area > 0 && Math.max(0, right - left) * Math.max(0, bottom - top) >= area / 2
}
