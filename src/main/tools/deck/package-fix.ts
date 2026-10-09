import { readFile, writeFile } from 'node:fs/promises'
import JSZip from 'jszip'

const THEME_TYPE = 'application/vnd.openxmlformats-officedocument.theme+xml'

/**
 * Makes the file PptxGenJS wrote something PowerPoint opens without its "repair" prompt. Three things PowerPoint's own repair changed
 * on a deck from this app (found live, 11.1): the notes list sat after the slide list in presentation.xml (the schema wants it before),
 * the notes master pointed at the slide master's theme instead of having its own,
 * [Content_Types].xml listed slide masters that are not in the file, and the zip held folder entries.
 */
export async function fixDeckPackage(absPath: string): Promise<void> {
  const zip = await JSZip.loadAsync(await readFile(absPath))
  const names = new Set(Object.keys(zip.files).filter((n) => !zip.files[n].dir))

  const typesFile = zip.file('[Content_Types].xml')
  let types = typesFile ? await typesFile.async('string') : ''
  types = types.replace(/<Override\s+PartName="([^"]+)"[^>]*\/>/g, (tag, part: string) => (names.has(part.replace(/^\//, '')) ? tag : ''))

  const notesRels = zip.file('ppt/notesMasters/_rels/notesMaster1.xml.rels')
  const theme1 = zip.file('ppt/theme/theme1.xml')
  if (notesRels && theme1 && !names.has('ppt/theme/theme2.xml')) {
    const rels = await notesRels.async('string')
    if (rels.includes('../theme/theme1.xml')) {
      zip.file('ppt/theme/theme2.xml', await theme1.async('string'))
      zip.file(notesRels.name, rels.replace('../theme/theme1.xml', '../theme/theme2.xml'))
      if (!types.includes('/ppt/theme/theme2.xml')) {
        types = types.replace('</Types>', `<Override PartName="/ppt/theme/theme2.xml" ContentType="${THEME_TYPE}"/></Types>`)
      }
    }
  }
  if (typesFile) zip.file('[Content_Types].xml', types)

  const presFile = zip.file('ppt/presentation.xml')
  if (presFile) {
    const pres = await presFile.async('string')
    const notesList = /<p:notesMasterIdLst>[\s\S]*?<\/p:notesMasterIdLst>/.exec(pres)
    if (notesList && notesList.index > pres.indexOf('<p:sldIdLst')) {
      const without = pres.replace(notesList[0], '')
      zip.file('ppt/presentation.xml', without.replace('</p:sldMasterIdLst>', `</p:sldMasterIdLst>${notesList[0]}`))
    }
  }

  // Copied into a fresh archive: removing a folder from the old one would remove everything inside it.
  const out = new JSZip()
  for (const name of Object.keys(zip.files)) if (!zip.files[name].dir) out.file(name, await zip.files[name].async('nodebuffer'), { createFolders: false })
  await writeFile(absPath, await out.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
}
