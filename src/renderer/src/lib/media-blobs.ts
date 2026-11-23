// The blobs behind the web client's `blob:` media URLs. The page's policy lets no request read a
// `blob:` URL, so a viewer that parses a file itself takes its bytes from here.

const blobs = new Map<string, Blob>()

export function holdBlob(url: string, blob: Blob): void {
  blobs.set(url, blob)
}

export function releaseBlob(url: string): void {
  blobs.delete(url)
}

export function blobOf(url: string): Blob | undefined {
  return blobs.get(url)
}
