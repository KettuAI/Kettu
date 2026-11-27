/**
 * A command line split into its words as a shell would split it: spaces separate them, quotes
 * keep spaces in one, and a backslash keeps the next character. Null while a quote is open.
 */
export function splitCommand(line: string): string[] | null {
  const words: string[] = []
  let word = ''
  let has = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!
    if (quote) {
      if (char === quote) quote = null
      else if (char === '\\' && quote === '"' && i + 1 < line.length) word += line[++i]
      else word += char
    } else if (char === '"' || char === "'") {
      quote = char
      has = true
    } else if (char === '\\' && i + 1 < line.length) {
      word += line[++i]
      has = true
    } else if (/\s/.test(char)) {
      if (has) words.push(word)
      word = ''
      has = false
    } else {
      word += char
      has = true
    }
  }
  if (quote) return null
  if (has) words.push(word)
  return words
}

export function formatMcpCommand(command: string, args: readonly string[]): string {
  return [command, ...args]
    .map((word) =>
      /^[a-zA-Z0-9_./:@=+-]+$/.test(word) ? word : "'" + word.replaceAll("'", "'\\''") + "'",
    )
    .join(' ')
}
