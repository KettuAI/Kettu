// A simulator's frame from serve-sim's description of Xcode's device chrome: which pictures go
// where, back to front. Layout follows serve-sim's DeviceKitChrome (Apache-2.0, copyright 2026
// Evan Bacon and Expo):
// https://github.com/expo/expo-device-hub/blob/main/packages/serve-sim/packages/serve-sim/src/client/components/device-chrome-frame.tsx

import type { DeviceFrameRect } from '@shared/device-host'

export interface FramePlan {
  /** serve-sim's name for the chrome, which its picture requests take. */
  chrome: string
  width: number
  height: number
  screen: DeviceFrameRect
  radii: [number, number, number, number]
  images: Array<DeviceFrameRect & { image: string }>
}

const MAX_POINTS = 10_000
const MAX_IMAGES = 24
const NAME = /^[\w .+-]{1,96}$/

type Raw = Record<string, unknown>

function record(value: unknown): Raw | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Raw)
    : null
}

function points(value: unknown, min = 0): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= MAX_POINTS
    ? value
    : null
}

function rect(value: unknown): DeviceFrameRect | null {
  const raw = record(value)
  if (!raw) return null
  const x = points(raw.x, -MAX_POINTS)
  const y = points(raw.y, -MAX_POINTS)
  const width = points(raw.width)
  const height = points(raw.height)
  return x === null || y === null || width === null || height === null
    ? null
    : { x, y, width, height }
}

function name(value: unknown): string | null {
  return typeof value === 'string' && NAME.test(value) ? value : null
}

/** The frame serve-sim describes, or null when it describes none or one this host cannot draw. */
export function framePlan(value: unknown): FramePlan | null {
  const chrome = record(value)
  if (!chrome) return null
  const id = name(chrome.identifier)
  const size = record(chrome.frame)
  const width = points(size?.width, 1)
  const height = points(size?.height, 1)
  const body = rect(chrome.body)
  const screen = rect(chrome.screen)
  if (!id || width === null || height === null || !body || !screen) return null

  const corners = record(chrome.screenCornerRadii)
  const radius = points(chrome.screenRadius) ?? 0
  const radii: [number, number, number, number] = corners
    ? [
        points(corners.topLeft) ?? radius,
        points(corners.topRight) ?? radius,
        points(corners.bottomRight) ?? radius,
        points(corners.bottomLeft) ?? radius,
      ]
    : [radius, radius, radius, radius]

  const buttons = (Array.isArray(chrome.buttons) ? chrome.buttons : []).flatMap((value) => {
    const button = record(value)
    const image = name(button?.image)
    const frame = rect(button?.frame)
    return button && image && frame
      ? [{ picture: { ...frame, image }, onTop: button.onTop === true }]
      : []
  })

  // Buttons behind the body show only where they stick out past its edge.
  const images: FramePlan['images'] = buttons
    .filter((button) => !button.onTop)
    .map((button) => button.picture)
  const composite = name(chrome.compositeImage)
  const slice = record(chrome.slice)
  const corner = record(chrome.corner)
  if (composite) {
    images.push({ ...body, image: composite })
  } else if (slice && corner) {
    const cw = points(corner.width)
    const ch = points(corner.height)
    if (cw === null || ch === null) return null
    const midWidth = Math.max(body.width - cw * 2, 0)
    const midHeight = Math.max(body.height - ch * 2, 0)
    const right = body.x + body.width - cw
    const bottom = body.y + body.height - ch
    const pieces: Array<[unknown, DeviceFrameRect]> = [
      [slice.topLeft, { x: body.x, y: body.y, width: cw, height: ch }],
      [slice.topRight, { x: right, y: body.y, width: cw, height: ch }],
      [slice.bottomLeft, { x: body.x, y: bottom, width: cw, height: ch }],
      [slice.bottomRight, { x: right, y: bottom, width: cw, height: ch }],
      [slice.top, { x: body.x + cw, y: body.y, width: midWidth, height: ch }],
      [slice.bottom, { x: body.x + cw, y: bottom, width: midWidth, height: ch }],
      [slice.left, { x: body.x, y: body.y + ch, width: cw, height: midHeight }],
      [slice.right, { x: right, y: body.y + ch, width: cw, height: midHeight }],
    ]
    for (const [piece, area] of pieces) {
      const image = name(piece)
      if (!image) return null
      if (area.width > 0 && area.height > 0) images.push({ ...area, image })
    }
  } else {
    return null
  }
  for (const button of buttons) if (button.onTop) images.push(button.picture)
  if (images.length > MAX_IMAGES) return null
  return { chrome: id, width, height, screen, radii, images }
}
