import { keptPerArtifact } from './artifact-kept'

// The type size a document artifact is read at, chosen per artifact and kept on this device.

/** The sizes the dock steps through, in percent; 100 is not stored. */
export const DOC_SIZES = [90, 100, 110, 125, 150] as const
export type DocSize = (typeof DOC_SIZES)[number]

const sizes = keptPerArtifact<DocSize>('artifact-doc-sizes', 100, (value): value is DocSize =>
  DOC_SIZES.includes(value as DocSize),
)

export const useDocSize = sizes.use
export const setDocSize = sizes.set

/** The next size up or down from `size`, or `size` at either end. */
export function stepDocSize(size: DocSize, direction: 1 | -1): DocSize {
  const i = DOC_SIZES.indexOf(size)
  return DOC_SIZES[Math.max(0, Math.min(DOC_SIZES.length - 1, i + direction))]!
}
