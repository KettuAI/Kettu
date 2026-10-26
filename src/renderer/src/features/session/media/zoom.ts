// The viewer's zoom and pan: where a picture shows on the stage, how it steps and how far it goes.

/** A picture's pixels show `z` CSS pixels each, its centre (x, y) from the stage's centre. */
export interface Camera {
  x: number
  y: number
  z: number
}

export interface Size {
  width: number
  height: number
}

export const MAX_ZOOM = 8
/** Buttons and keys zoom by this factor. */
export const ZOOM_STEP = 1.25
/** From this zoom a picture renders pixelated, so its pixels stay crisp. */
export const PIXELATED_FROM = 3
/** The room the fitted picture leaves on each side of the stage. */
const FIT_MARGIN = 48
/** How far past its edges a zoomed picture pans. */
const PAN_MARGIN = 24
/** A zoom that ends this close to the fit snaps back to it. */
const SNAP = 0.05

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** The zoom that shows the picture whole inside the stage less its margins, never enlarged. */
export function fitZoom(picture: Size, stage: Size): number {
  const z = Math.min(
    1,
    (stage.width - 2 * FIT_MARGIN) / Math.max(1, picture.width),
    (stage.height - 2 * FIT_MARGIN) / Math.max(1, picture.height),
  )
  // A stage too small to leave its margins still shows a sliver.
  return Math.max(z, 0.001)
}

/** The camera kept from the fit to 800%, the picture centred on an axis it fits along. */
export function bounded(camera: Camera, picture: Size, stage: Size, fit: number): Camera {
  const z = clamp(camera.z, fit, MAX_ZOOM)
  const reach = (length: number, room: number) =>
    length <= room ? 0 : (length - room) / 2 + PAN_MARGIN
  const x = reach(picture.width * z, stage.width)
  const y = reach(picture.height * z, stage.height)
  return { z, x: clamp(camera.x, -x, x), y: clamp(camera.y, -y, y) }
}

/**
 * Zoomed to `z` with the picture's point under (px, py), from the stage's centre, kept there as
 * far as the bounds allow.
 */
export function zoomAt(
  camera: Camera,
  z: number,
  px: number,
  py: number,
  picture: Size,
  stage: Size,
  fit: number,
): Camera {
  const next = clamp(z, fit, MAX_ZOOM)
  const k = next / camera.z
  return bounded(
    { z: next, x: px - (px - camera.x) * k, y: py - (py - camera.y) * k },
    picture,
    stage,
    fit,
  )
}

/** The zoom a button or key steps to from `z`. */
export function stepZoom(z: number, direction: 1 | -1, fit: number): number {
  return clamp(z * ZOOM_STEP ** direction, fit, MAX_ZOOM)
}

/** A zoom that ended within 5% of the fit, back at the fit; any other as it is. */
export function snapped(camera: Camera, fit: number): Camera {
  return camera.z / fit - 1 < SNAP ? { x: 0, y: 0, z: fit } : camera
}

/** Whether the picture shows larger than its fit, and so pans. */
export const isZoomed = (camera: Camera, fit: number) => camera.z > fit

/** From the fit to 100% around (px, py); from any other zoom back to the fit. */
export function toggled(
  camera: Camera,
  px: number,
  py: number,
  picture: Size,
  stage: Size,
  fit: number,
): Camera {
  if (isZoomed(camera, fit)) return { x: 0, y: 0, z: fit }
  return zoomAt(camera, 1, px, py, picture, stage, fit)
}
