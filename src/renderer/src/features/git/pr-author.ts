import type { PullRequestAuthor } from '@shared/git'

export interface AuthorLabel {
  name: string
  /** The login, when the name does not already say it. */
  login: string | null
  initial: string
}

/** How the pull request card names its author: a bot by its app's name, a user by their profile name. */
export function authorLabel(author: PullRequestAuthor): AuthorLabel {
  const name = author.bot
    ? author.login.replace(/\[bot\]$/, '')
    : author.name?.trim() || author.login
  const login =
    author.bot || name.toLowerCase() === author.login.toLowerCase() ? null : author.login
  return { name, login, initial: Array.from(name)[0]?.toUpperCase() ?? '' }
}
