// Tells monospace faces from the rest off the main thread: measuring a family loads its font.

const scope = self as unknown as Worker

/** A thin and a wide letter advance the same in a monospace face; the API has no flag for it. */
scope.onmessage = (event: MessageEvent<string[]>) => {
  const families = event.data
  const context = new OffscreenCanvas(1, 1).getContext('2d')
  if (!context) {
    scope.postMessage(families)
    return
  }
  scope.postMessage(
    families.filter((family) => {
      context.font = `16px "${family}"`
      return (
        Math.abs(
          context.measureText('iiiiiiiiii').width - context.measureText('WWWWWWWWWW').width,
        ) < 0.01
      )
    }),
  )
}
