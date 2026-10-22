// File-type icons from Material Icon Theme (MIT,
// https://github.com/material-extensions/vscode-material-icon-theme), resolved the way VS Code
// resolves a file icon theme: file names, then extensions longest first, then the default.

type Names = Record<string, string>

export interface IconManifest {
  file: string
  folder: string
  folderExpanded: string
  fileNames: Names
  fileExtensions: Names
  folderNames: Names
  folderNamesExpanded: Names
  light?: Partial<
    Record<'fileNames' | 'fileExtensions' | 'folderNames' | 'folderNamesExpanded', Names>
  >
}

type MapKey = 'fileNames' | 'fileExtensions' | 'folderNames' | 'folderNamesExpanded'

/** The manifest's maps with lower-case keys, since names match without regard to case. */
export function indexManifest(manifest: IconManifest): IconManifest {
  const lower = (names: Names | undefined): Names =>
    Object.fromEntries(Object.entries(names ?? {}).map(([key, id]) => [key.toLowerCase(), id]))
  const keys: MapKey[] = ['fileNames', 'fileExtensions', 'folderNames', 'folderNamesExpanded']
  return {
    file: manifest.file,
    folder: manifest.folder,
    folderExpanded: manifest.folderExpanded,
    fileNames: lower(manifest.fileNames),
    fileExtensions: lower(manifest.fileExtensions),
    folderNames: lower(manifest.folderNames),
    folderNamesExpanded: lower(manifest.folderNamesExpanded),
    light: Object.fromEntries(keys.map((key) => [key, lower(manifest.light?.[key])])),
  }
}

/**
 * The icon for a project-relative path, from an indexed manifest. A name can also match with its
 * parent folder, such as `.github/workflows`; the light theme has its own icons for a few.
 */
export function iconId(
  manifest: IconManifest,
  path: string,
  kind: 'file' | 'folder',
  { open = false, light = false }: { open?: boolean; light?: boolean } = {},
): string {
  const parts = path.toLowerCase().split('/').filter(Boolean)
  const name = parts.at(-1) ?? ''
  const parent = parts.at(-2)
  const find = (key: MapKey, value: string): string | undefined =>
    (light ? manifest.light?.[key]?.[value] : undefined) ?? manifest[key][value]
  const named = (key: MapKey): string | undefined =>
    (parent !== undefined ? find(key, `${parent}/${name}`) : undefined) ?? find(key, name)

  if (kind === 'folder') {
    return (
      named(open ? 'folderNamesExpanded' : 'folderNames') ??
      (open ? manifest.folderExpanded : manifest.folder)
    )
  }
  const byName = named('fileNames')
  if (byName) return byName
  for (let dot = name.indexOf('.'); dot !== -1; dot = name.indexOf('.', dot + 1)) {
    const byExtension = find('fileExtensions', name.slice(dot + 1))
    if (byExtension) return byExtension
  }
  return manifest.file
}
