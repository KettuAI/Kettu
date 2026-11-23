// What the first bytes of a Word or Excel file tell the viewers before they parse it.

const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
/** The stream a password-protected Office file keeps its package in, named in UTF-16. */
const ENCRYPTED_PACKAGE = Array.from('EncryptedPackage', (char) => char.charCodeAt(0))

/** Whether the bytes are an OLE2 container, which holds legacy and password-protected files. */
export function isOle2(bytes: Uint8Array): boolean {
  return OLE2.every((byte, i) => bytes[i] === byte)
}

/** Whether an OLE2 container holds a password-protected Office package. */
export function holdsEncryptedPackage(bytes: Uint8Array): boolean {
  const [first = 0] = ENCRYPTED_PACKAGE
  for (let at = bytes.indexOf(first); at >= 0; at = bytes.indexOf(first, at + 1)) {
    if (
      ENCRYPTED_PACKAGE.every(
        (byte, i) => bytes[at + 2 * i] === byte && bytes[at + 2 * i + 1] === 0,
      )
    ) {
      return true
    }
  }
  return false
}
