// The part of decompress's API Kettu uses; the package ships no types of its own.
declare module 'decompress' {
  interface DecompressFile {
    path: string
    type: 'file' | 'directory' | 'symlink' | 'link'
  }

  /** Extracts `input` into `output`, keeping each entry's mode bits. */
  export default function decompress(
    input: string,
    output?: string,
    options?: { filter?(file: DecompressFile): boolean; strip?: number },
  ): Promise<DecompressFile[]>
}
