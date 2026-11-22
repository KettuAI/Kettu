import { keptPerArtifact } from './artifact-kept'

// The width a web page artifact is laid out at, chosen per artifact and kept on this device.

/** Fill takes the room there is; a number lays the page out that many pixels wide. */
export type PageWidth = 'fill' | 1280 | 768 | 390

export const PAGE_WIDTHS: readonly Exclude<PageWidth, 'fill'>[] = [1280, 768, 390]

const widths = keptPerArtifact<PageWidth>(
  'artifact-page-widths',
  'fill',
  (value): value is PageWidth => PAGE_WIDTHS.includes(value as Exclude<PageWidth, 'fill'>),
)

export const usePageWidth = widths.use
export const setPageWidth = widths.set
