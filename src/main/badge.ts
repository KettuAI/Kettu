import { app, BrowserWindow, nativeImage, type NativeImage } from 'electron'
import { badgeLabel, encodePng, renderBadge } from './badge-image'
import { createLogger } from './log'

const log = createLogger('badge')

let count = 0
let enabled = true
const overlays = new Map<string, Promise<NativeImage>>()

// Windows shows overlay icons at 16 px per scale step; 1x and 2x cover the common scales.
async function overlayImage(label: string): Promise<NativeImage> {
  const image = nativeImage.createFromBuffer(await encodePng(renderBadge(label, 16), 16, 16), {
    scaleFactor: 1,
  })
  image.addRepresentation({
    scaleFactor: 2,
    buffer: await encodePng(renderBadge(label, 32), 32, 32),
  })
  return image
}

function description(shown: number): string {
  return shown === 1 ? '1 request waiting for approval' : `${shown} requests waiting for approval`
}

async function applyOverlay(window: BrowserWindow, label: string | null): Promise<void> {
  if (!label) {
    if (!window.isDestroyed()) window.setOverlayIcon(null, '')
    return
  }
  let image = overlays.get(label)
  if (!image) {
    image = overlayImage(label)
    overlays.set(label, image)
  }
  const resolved = await image
  if (!window.isDestroyed() && badgeLabel(shownCount()) === label) {
    window.setOverlayIcon(resolved, description(shownCount()))
  }
}

function shownCount(): number {
  return enabled ? count : 0
}

/** Shows the pending-approval count on the Dock icon, the taskbar button, or the launcher. */
function apply(windows = BrowserWindow.getAllWindows()): void {
  const shown = shownCount()
  if (process.platform === 'win32') {
    const label = badgeLabel(shown)
    for (const window of windows) {
      applyOverlay(window, label).catch((error: unknown) => log.error('Overlay failed', error))
    }
    return
  }
  // On Linux this works only where the desktop supports launcher counts, such as Unity.
  app.setBadgeCount(shown)
}

export function setBadgeCount(next: number): void {
  const clean = Number.isInteger(next) && next > 0 ? next : 0
  if (clean === count) return
  count = clean
  apply()
}

export function setBadgeEnabled(next: boolean): void {
  if (next === enabled) return
  enabled = next
  apply()
}

/** A new window has its own taskbar button on Windows, which needs the overlay too. */
export function applyBadgeTo(window: BrowserWindow): void {
  if (process.platform === 'win32' && shownCount() > 0) apply([window])
}
