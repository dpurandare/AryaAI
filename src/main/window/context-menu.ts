import type { WebContents } from 'electron'
import { Menu } from 'electron'

/**
 * What a right-click in the window should offer, in order — kept as plain data (not `Menu`/`click`
 * handlers directly) so the logic deciding what to show is testable without mocking Electron's `Menu`.
 * The actual `webContents`/`Menu` calls live only in `attachSpellcheckContextMenu` below.
 */
export type ContextMenuAction =
  | { kind: 'replace'; word: string }
  | { kind: 'add-to-dictionary'; word: string }
  | { kind: 'separator' }
  | { kind: 'cut' }
  | { kind: 'copy' }
  | { kind: 'paste' }
  | { kind: 'select-all' }

export interface ContextMenuParams {
  misspelledWord: string
  dictionarySuggestions: string[]
  editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean }
}

/**
 * TASKS.md #209: Electron's built-in spellchecker already underlines a misspelled word (on by
 * default, nothing in this app disables it) but nothing was ever wired up to the right-click — so
 * right-clicking one did nothing at all. `editFlags` is Chromium's own, already-correct answer to
 * "what applies here" (e.g. Cut only where there is an editable selection) — used directly rather
 * than re-deriving it from `isEditable`/`selectionText`. Returns `[]` when nothing applies (a plain
 * right-click with no selection on non-editable, non-misspelled content) so the caller can skip
 * popping up an empty menu.
 */
export function buildContextMenuActions(params: ContextMenuParams): ContextMenuAction[] {
  const actions: ContextMenuAction[] = []
  if (params.misspelledWord) {
    for (const word of params.dictionarySuggestions) actions.push({ kind: 'replace', word })
    if (params.dictionarySuggestions.length) actions.push({ kind: 'separator' })
    actions.push({ kind: 'add-to-dictionary', word: params.misspelledWord })
  }
  const editActions: ContextMenuAction[] = []
  if (params.editFlags.canCut) editActions.push({ kind: 'cut' })
  if (params.editFlags.canCopy) editActions.push({ kind: 'copy' })
  if (params.editFlags.canPaste) editActions.push({ kind: 'paste' })
  if (params.editFlags.canSelectAll) editActions.push({ kind: 'select-all' })
  if (actions.length && editActions.length) actions.push({ kind: 'separator' })
  return [...actions, ...editActions]
}

/** Registers the right-click menu above for every page this `webContents` ever loads. */
export function attachSpellcheckContextMenu(webContents: WebContents): void {
  webContents.on('context-menu', (_event, params) => {
    const actions = buildContextMenuActions(params)
    if (!actions.length) return
    const template = actions.map((action) => {
      switch (action.kind) {
        case 'replace':
          return { label: action.word, click: () => webContents.replaceMisspelling(action.word) }
        case 'add-to-dictionary':
          return { label: 'Add to Dictionary', click: () => webContents.session.addWordToSpellCheckerDictionary(action.word) }
        case 'separator':
          return { type: 'separator' as const }
        case 'cut':
          return { label: 'Cut', role: 'cut' as const }
        case 'copy':
          return { label: 'Copy', role: 'copy' as const }
        case 'paste':
          return { label: 'Paste', role: 'paste' as const }
        case 'select-all':
          return { label: 'Select All', role: 'selectAll' as const }
      }
    })
    Menu.buildFromTemplate(template).popup()
  })
}
