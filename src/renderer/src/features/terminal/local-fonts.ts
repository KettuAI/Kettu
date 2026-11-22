import { isFontFamilyName } from '@shared/settings'
import MonospaceWorker from './monospace-worker?worker'

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

/** Tells the monospace families apart in a worker, so measuring them never blocks the window. */
function monospace(families: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const worker = new MonospaceWorker()
    worker.onmessage = (event: MessageEvent<string[]>) => {
      worker.terminate()
      resolve(event.data)
    }
    worker.onerror = (event) => {
      worker.terminate()
      reject(new Error(event.message))
    }
    worker.postMessage(families)
  })
}

async function queryFamilies(): Promise<FontList> {
  const query = localFontsQuery()
  if (!query) return { state: 'unavailable' }
  try {
    const faces = await query()
    const families = [...new Set(faces.map((face) => face.family))].filter(isFontFamilyName)
    return { state: 'ready', families: families.sort((a, b) => a.localeCompare(b)) }
  } catch (error) {
    console.warn('Installed fonts cannot be listed; a name can still be typed', error)
    return { state: 'unavailable' }
  }
}

async function queryMonospaceFamilies(): Promise<FontList> {
  const all = await listed('all', queryFamilies)
  if (all.state !== 'ready') return all
  try {
    return { state: 'ready', families: await monospace(all.families) }
  } catch (error) {
    console.warn('Monospace fonts cannot be told apart; a name can still be typed', error)
    return { state: 'unavailable' }
  }
}

// One listing per window, shared by every picker.
const lists: Record<'all' | 'monospace', Promise<FontList> | null> = { all: null, monospace: null }

/** Keeps a listing that worked; one that did not is asked for again by the next picker. */
function listed(kind: 'all' | 'monospace', make: () => Promise<FontList>): Promise<FontList> {
  const held = lists[kind]
  if (held) return held
  const listing = make()
  lists[kind] = listing
  void listing.then((list) => {
    if (list.state !== 'ready') lists[kind] = null
  })
  return listing
}

/**
 * Asks the browser to list the installed fonts, only the monospace ones when `monospaceOnly`; it
 * may first ask the user about it. The answer is kept for the window, measures included.
 */
export function listInstalledFonts(monospaceOnly: boolean): Promise<FontList> {
  return monospaceOnly ? listed('monospace', queryMonospaceFamilies) : listed('all', queryFamilies)
}
