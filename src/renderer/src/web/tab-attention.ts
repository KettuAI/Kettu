// The web client's browser tab while the page is away: its title counts what needs the user and its
// icon carries a dot, until the page is back in front. It follows the switches of Settings >
// Notifications, and unlike the browser's notifications needs no permission, so it works on plain
// http too.

import { ATTENTION_SETTING, attentionTarget } from '@shared/attention'
import type { HostAttention } from '@shared/remote/host-admin'
import type { SettingsFile } from '@shared/settings'
import icon from '@renderer/assets/kettu-icon.svg'

const TITLE = 'Kettu'
const ICON_SIZE = 64
const DOT_RING = 18
const DOT = 14

export interface TabAttentionDeps {
  settings(): SettingsFile
  /** Whether this page is in front: shown and focused. */
  inFront(): boolean
}

// What needs the user, by the key a newer notice for the same session replaces it under.
const unseen = new Set<string>()
// The page's own icon links, held while the one with the dot stands in for them.
let originals: HTMLLinkElement[] | null = null
let dotLink: HTMLLinkElement | null = null

// The tab strip is the browser's, not the app's, so the dot keeps the light theme's colors.
function lightColor(token: string): string {
  const probe = document.createElement('div')
  probe.dataset.theme = 'light'
  document.body.append(probe)
  const color = getComputedStyle(probe).getPropertyValue(token).trim()
  probe.remove()
  if (!color) throw new Error(`The theme has no ${token}`)
  return color
}

/** Draws the page's icon with a dot in its corner. */
async function drawDotIcon(): Promise<string> {
  const image = new Image()
  image.src = icon
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = ICON_SIZE
  canvas.height = ICON_SIZE
  const context = canvas.getContext('2d')
  if (!context) throw new Error('No canvas context')
  context.drawImage(image, 0, 0, ICON_SIZE, ICON_SIZE)
  const dot = (radius: number, token: string): void => {
    context.fillStyle = lightColor(token)
    context.beginPath()
    context.arc(ICON_SIZE - DOT_RING, DOT_RING, radius, 0, Math.PI * 2)
    context.fill()
  }
  dot(DOT_RING, '--destructive-foreground')
  dot(DOT, '--danger')
  return canvas.toDataURL('image/png')
}

async function showDotIcon(): Promise<void> {
  const href = await drawDotIcon()
  // Cleared while the icon was drawn.
  if (unseen.size === 0) return
  originals ??= [...document.head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')]
  if (!dotLink) {
    dotLink = document.createElement('link')
    dotLink.rel = 'icon'
    dotLink.type = 'image/png'
  }
  dotLink.href = href
  for (const link of originals) link.remove()
  document.head.append(dotLink)
}

function showPlainIcon(): void {
  if (!originals || !dotLink?.isConnected) return
  dotLink.remove()
  document.head.append(...originals)
}

function apply(): void {
  const count = unseen.size
  document.title = count > 0 ? `(${count}) ${TITLE}` : TITLE
  if (count === 0) {
    showPlainIcon()
    return
  }
  showDotIcon().catch((error: unknown) => console.error('Could not draw the tab icon', error))
}

/** Marks what needs the user in the tab, when its switch is on and the page is away. */
export function noteTabAttention(attention: HostAttention, deps: TabAttentionDeps): void {
  const target = attentionTarget(attention)
  if (!target || deps.inFront()) return
  if (!deps.settings().notifications[ATTENTION_SETTING[attention.kind]]) return
  unseen.add(target.key)
  apply()
}

/** Clears the tab's marks once the page is back in front. */
export function followTabFront(inFront: () => boolean): void {
  const clear = (): void => {
    if (unseen.size === 0 || !inFront()) return
    unseen.clear()
    apply()
  }
  document.addEventListener('visibilitychange', clear)
  window.addEventListener('focus', clear)
}
