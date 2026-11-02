/**
 * Copies the path and says so, where the desktop app shows its own files in the file manager: a
 * host reached over the channel keeps its files where this device cannot show them.
 */
export async function copyPath(path: string): Promise<void> {
  await navigator.clipboard.writeText(path)
  const [{ toast }, { i18n }] = await Promise.all([
    import('@renderer/components/ui/toast'),
    import('@renderer/lib/i18n'),
  ])
  toast(i18n.t('web:copiedPath', { path }))
}
