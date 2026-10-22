// Loaded on first use: the manifest and the URLs of the theme's 1,251 icons. The icons are files
// of their own, never inlined, so only the ones on screen are read.
import {
  file,
  fileExtensions,
  fileNames,
  folder,
  folderExpanded,
  folderNames,
  folderNamesExpanded,
  iconDefinitions,
  light,
} from 'material-icon-theme/dist/material-icons.json'
import { indexManifest } from './file-icons'

const files = import.meta.glob<string>(
  '../../../../../node_modules/material-icon-theme/icons/*.svg',
  { query: '?url&no-inline', import: 'default', eager: true },
)
const byFile = new Map(Object.entries(files).map(([path, url]) => [path.split('/').at(-1)!, url]))

export const manifest = indexManifest({
  file,
  folder,
  folderExpanded,
  fileNames,
  fileExtensions,
  folderNames,
  folderNamesExpanded,
  light,
})

/** The URL of an icon of the theme, by its id. */
export function iconUrl(id: string): string | undefined {
  const path = iconDefinitions[id]?.iconPath
  return path ? byFile.get(path.split('/').at(-1)!) : undefined
}
