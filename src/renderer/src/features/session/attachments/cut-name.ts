/** Where a name is cut: the head, which takes the ellipsis, and the tail that always shows. */
export function cutName(name: string): [string, string] {
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot) : ''
  const stem = name.slice(0, name.length - extension.length)
  // Up to five of the stem's last characters stay with the extension, as in "-1042.log".
  const kept = Math.min(5, Math.floor(stem.length / 2))
  return [stem.slice(0, stem.length - kept), stem.slice(stem.length - kept) + extension]
}
