// A passage of an agent message as offsets in the message's text, which find it again after the
// message renders anew, as after switching sessions or a restart.

/** The range's start and end as offsets in the text of `message`, which contains it. */
export function passageOffsets(message: HTMLElement, range: Range): { start: number; end: number } {
  const before = document.createRange()
  before.selectNodeContents(message)
  before.setEnd(range.startContainer, range.startOffset)
  const start = before.toString().length
  return { start, end: start + range.toString().length }
}

/** The range at the offsets in the text of `message`, or null where the text ends sooner. */
export function passageRange(message: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let seen = 0
  let started = false
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = (node as Text).data.length
    if (!started && start <= seen + length) {
      range.setStart(node, start - seen)
      started = true
    }
    if (started && end <= seen + length) {
      range.setEnd(node, end - seen)
      return range
    }
    seen += length
  }
  return null
}

const bare = (text: string): string => text.replace(/\s+/g, '')

/**
 * The passage's range in `message`, when the text there is still the passage; a selection's text
 * spaces its blocks differently from the range's, so only what is not white space is compared.
 */
export function findPassage(
  message: HTMLElement,
  passage: { passage: string; start: number; end: number },
): Range | null {
  const range = passageRange(message, passage.start, passage.end)
  return range && bare(range.toString()) === bare(passage.passage) ? range : null
}
