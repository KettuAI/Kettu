const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)'

/** Keeps the `dark` class on <html> in sync with the OS appearance. */
export function followSystemTheme(): void {
  const query = window.matchMedia(DARK_SCHEME_QUERY)
  const apply = (): void => {
    document.documentElement.classList.toggle('dark', query.matches)
  }
  apply()
  query.addEventListener('change', apply)
}
