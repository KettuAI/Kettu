const MAX_NAME_CHARS = 100

/** A file name from a title: nothing a file system on any platform refuses, never empty. */
export function safeName(title: string, fallback: string): string {
  const cleaned = title.replace(/[<>:"/\\|?*\p{Cc}]/gu, '-')
  const capped = Array.from(cleaned.replace(/^[. ]+|[. ]+$/g, '')).slice(0, MAX_NAME_CHARS)
  const name = capped.join('').replace(/[. ]+$/, '')
  return name === '' ? fallback : name
}
