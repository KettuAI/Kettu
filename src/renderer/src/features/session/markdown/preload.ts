/** Starts loading the Markdown renderer before the first entry needs it. */
export function preloadRenderers(): void {
  void import('./markdown-impl')
}
