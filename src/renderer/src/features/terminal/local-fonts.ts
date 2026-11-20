import { isFontFamilyName } from '@shared/settings'

interface InstalledFace {
  family: string
}

type QueryLocalFonts = () => Promise<InstalledFace[]>

/** The installed families, or why the window cannot list them. */
export type FontList = { state: 'ready'; families: string[] } | { state: 'unavailable' }

/** The Local Font Access API is Chromium's; other browsers and plain-http pages lack it. */
function localFontsQuery(): QueryLocalFonts | null {
  const query = (window as unknown as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts
  return typeof query === 'function' ? query.bind(window) : null
}

/** A thin and a wide letter advance the same in a monospace face; the API has no flag for it. */
function monospace(families: string[]): string[] {
  const context = document.createElement('canvas').getContext('2d')
  if (!context) return families
  return families.filter((family) => {
    context.font = `16px "${family}"`
    return (
      Math.abs(context.measureText('iiiiiiiiii').width - context.measureText('WWWWWWWWWW').width) <
      0.01
    )
  })
}

/**
 * Asks the browser to list the installed fonts, only the monospace ones when `monospaceOnly`; it
 * may first ask the user about it.
 */
export async function listInstalledFonts(monospaceOnly: boolean): Promise<FontList> {
  const query = localFontsQuery()
  if (!query) return { state: 'unavailable' }
  try {
    const faces = await query()
    const families = [...new Set(faces.map((face) => face.family))].filter(isFontFamilyName)
    const listed = monospaceOnly ? monospace(families) : families
    return { state: 'ready', families: listed.sort((a, b) => a.localeCompare(b)) }
  } catch (error) {
    console.warn('Installed fonts cannot be listed; a name can still be typed', error)
    return { state: 'unavailable' }
  }
}
