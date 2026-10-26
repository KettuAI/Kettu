// The canvas's camera: where its pages show on screen, how it zooms and fits, which pages stay
// live, and which labels have room.

import { ROW_GAP, type PlacedPage } from './canvas'

/** Screen = canvas * z + (x, y), in CSS pixels of the view. */
export interface Camera {
  x: number
  y: number
  z: number
}

export interface Size {
  width: number
  height: number
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export const ZOOM_STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 4] as const
export const MIN_ZOOM = 0.05
export const MAX_ZOOM = 4

/** Room left around what a fit shows: beside it, and above it for the labels and below. */
const FIT_SIDE = 48
const FIT_ABOVE = 78
const FIT_BELOW = 48

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
}

// A glide ends on its zoom through a logarithm, a hair off the limit it was clamped to.
/** Whether `z` is as far out as the canvas zooms. */
export function atMinZoom(z: number): boolean {
  return z <= MIN_ZOOM * 1.001
}

/** Whether `z` is as far in as the canvas zooms. */
export function atMaxZoom(z: number): boolean {
  return z >= MAX_ZOOM / 1.001
}

/** The camera that shows `box` whole and centred, never above 100%; `top` is covered by a bar. */
export function fitBox(box: Box, view: Size, top = 0): Camera {
  const room = {
    width: view.width - 2 * FIT_SIDE,
    height: view.height - top - FIT_ABOVE - FIT_BELOW,
  }
  const z = clampZoom(
    Math.min(1, room.width / Math.max(1, box.width), room.height / Math.max(1, box.height)),
  )
  return {
    z,
    x: (view.width - box.width * z) / 2 - box.x * z,
    y: top + FIT_ABOVE + (room.height - box.height * z) / 2 - box.y * z,
  }
}

/** Zoomed to `z` with the canvas point under the screen point (`sx`, `sy`) kept there. */
export function zoomAt(camera: Camera, z: number, sx: number, sy: number): Camera {
  const next = clampZoom(z)
  const wx = (sx - camera.x) / camera.z
  const wy = (sy - camera.y) / camera.z
  return { z: next, x: sx - wx * next, y: sy - wy * next }
}

/** The next zoom step in or out from `z`. */
export function stepZoom(z: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find((step) => step > z * 1.01) ?? MAX_ZOOM
  return [...ZOOM_STEPS].reverse().find((step) => step < z / 1.01) ?? MIN_ZOOM
}

/**
 * Between two cameras at `t` from 0 to 1: the zoom on a log scale, and the canvas point at the
 * view's centre in a straight line, so a zoom does not swing sideways.
 */
export function between(a: Camera, b: Camera, t: number, view: Size): Camera {
  const z = Math.exp(Math.log(a.z) + (Math.log(b.z) - Math.log(a.z)) * t)
  const centre = (c: Camera) => ({
    x: (view.width / 2 - c.x) / c.z,
    y: (view.height / 2 - c.y) / c.z,
  })
  const from = centre(a)
  const to = centre(b)
  const wx = from.x + (to.x - from.x) * t
  const wy = from.y + (to.y - from.y) * t
  return { z, x: view.width / 2 - wx * z, y: view.height / 2 - wy * z }
}

/** The part of the canvas the view shows. */
export function visible(camera: Camera, view: Size): Box {
  return {
    x: -camera.x / camera.z,
    y: -camera.y / camera.z,
    width: view.width / camera.z,
    height: view.height / camera.z,
  }
}

/** The smallest move that brings `box` into view with `margin` screen pixels around it. */
export function reveal(camera: Camera, box: Box, view: Size, margin = 48): Camera {
  const left = box.x * camera.z + camera.x
  const top = box.y * camera.z + camera.y
  const right = left + box.width * camera.z
  const bottom = top + box.height * camera.z
  const shift = (start: number, end: number, size: number): number => {
    if (end - start > size - 2 * margin) return margin - start
    if (start < margin) return margin - start
    if (end > size - margin) return size - margin - end
    return 0
  }
  return {
    z: camera.z,
    x: camera.x + shift(left, right, view.width),
    y: camera.y + shift(top, bottom, view.height),
  }
}

/** The page at a screen point, or -1. */
export function pageAt(
  pages: readonly PlacedPage[],
  camera: Camera,
  sx: number,
  sy: number,
): number {
  const wx = (sx - camera.x) / camera.z
  const wy = (sy - camera.y) / camera.z
  return pages.findIndex(
    (p) => wx >= p.x && wx <= p.x + p.width && wy >= p.y && wy <= p.y + p.height,
  )
}

/** Pages within one and a half views of the visible area, nearest first, at most `max`. */
export function livePages(
  pages: readonly PlacedPage[],
  camera: Camera,
  view: Size,
  max = 48,
): number[] {
  const area = visible(camera, view)
  const reach = { x: area.width * 1.5, y: area.height * 1.5 }
  const cx = area.x + area.width / 2
  const cy = area.y + area.height / 2
  const near: { index: number; distance: number }[] = []
  pages.forEach((p, index) => {
    const dx = Math.max(area.x - (p.x + p.width), p.x - (area.x + area.width), 0)
    const dy = Math.max(area.y - (p.y + p.height), p.y - (area.y + area.height), 0)
    if (dx > reach.x || dy > reach.y) return
    const distance = Math.hypot(p.x + p.width / 2 - cx, p.y + p.height / 2 - cy)
    near.push({ index, distance })
  })
  near.sort((a, b) => a.distance - b.distance)
  return near.slice(0, max).map((n) => n.index)
}

/** The nearest page, by its centre, in the row above or below the page at `from`; -1 if none. */
export function pageInNextRow(
  pages: readonly PlacedPage[],
  from: number,
  direction: -1 | 1,
): number {
  const origin = pages[from]
  if (!origin) return -1
  const ahead = pages
    .map((p, index) => ({ p, index }))
    .filter(({ p }) => (direction < 0 ? p.y < origin.y : p.y > origin.y))
  if (!ahead.length) return -1
  const rowY =
    direction < 0 ? Math.max(...ahead.map(({ p }) => p.y)) : Math.min(...ahead.map(({ p }) => p.y))
  const centre = origin.x + origin.width / 2
  let best = -1
  let distance = Infinity
  for (const { p, index } of ahead) {
    if (p.y !== rowY) continue
    const d = Math.abs(p.x + p.width / 2 - centre)
    if (d < distance) {
      distance = d
      best = index
    }
  }
  return best
}

/** Whether the screen gap between rows leaves room for page names, and for a group's title. */
export function labelRoom(z: number): { names: boolean; title: boolean } {
  const gap = ROW_GAP * z
  return { names: gap >= 44, title: gap >= 22 }
}

/** A page's name shows while the page is at least 56 px wide on screen. */
export const NAME_MIN_WIDTH = 56
/** A group's title shows while its row is at least 80 px wide on screen. */
export const TITLE_MIN_WIDTH = 80
