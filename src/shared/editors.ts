/** A code editor on this computer that a session's folder or a file can be opened in. */
export interface EditorApp {
  /** A known editor's, such as `vscode`, or `custom:` and a hash of the path of an app chosen. */
  id: string
  name: string
  /** The app's icon as a PNG `data:` URL; null when none could be read, and always on Linux. */
  icon: string | null
}

/** `editors:list`: the known editors installed, in a fixed order, then the apps the user chose. */
export interface EditorList {
  editors: EditorApp[]
  /** The listed editor something was opened in last, or null. */
  last: string | null
}
