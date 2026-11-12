/** Opens a folder or file in the editor used last, else the first one found, else asks for an app. */
export async function openInEditor(path: string): Promise<void> {
  const { editors, last } = await window.kettu.editors.list()
  const editor = editors.find((candidate) => candidate.id === last) ?? editors[0]
  if (editor) await window.kettu.editors.open(editor.id, path)
  else await window.kettu.editors.choose(path)
}
