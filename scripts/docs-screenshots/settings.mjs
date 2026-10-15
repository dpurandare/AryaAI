// Settings sections. One role file is written so the Roles section shows a loaded role.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prepareDemoProfile } from './main-window.mjs'
import { pause } from './session.mjs'

const NAMES = ['settings-appearance', 'settings-providers', 'settings-data-sources', 'settings-search-history', 'settings-mcp', 'settings-workspace', 'settings-roles', 'settings-model-behavior']

const ROLE = `---
id: meeting-notes
name: Meeting Notes
summary: Turns pasted meeting notes or a notes file into minutes with decisions and action items. Does not search the web (Researcher) or create Word files (Text Document Creator).
description: Reads a notes file the user names, or the notes pasted into the chat, and writes tidy minutes in the chat.
examples: ["Turn notes/standup.txt into minutes", "Pull the action items out of these notes: ..."]
notExamples: ["Put these minutes into a Word document [document-creator]", "Find out who attended last year's conference [research]"]
tools: [read_file, list_directory]
maxRounds: 6
pickable: true
plannable: true
---
You are Meeting Notes. When the user names a notes file, read it with read_file; otherwise use the notes in the message.
Reply with three headed sections: Summary (2-3 sentences), Decisions (bullets), Action items (bullets as "Owner - task - due date", writing "unassigned" or "no date" when missing).
Never invent owners or dates. Do not modify any file.
`

export async function run(s) {
  if (!NAMES.some((n) => s.wanted(n))) return
  console.log('Settings screens')
  await prepareDemoProfile(s)
  mkdirSync(join(s.userData, 'roles'), { recursive: true })
  writeFileSync(join(s.userData, 'roles', 'meeting-notes.md'), ROLE)

  await s.launch()
  await s.waitForText('Top 5 customers by sales', { timeout: 60000 })
  await s.waitFor("!document.body.innerText.includes('Starting')", { label: 'the splash screen to fade' })
  await s.evaluate("document.querySelector('.user-row').click()")
  await pause(300)
  await s.click('Settings')
  await s.waitForText('Provider API keys')
  // The bundled Ollama pulls its model in the background after onboarding; wait so the section reads "Ready".
  await s.waitForText('embedding model loaded', { timeout: 240000 }).catch(() => console.log('  (embedding model not ready; capturing anyway)'))
  await pause(1500)

  const top = async (name, heading) => {
    if (heading) await s.scrollToHeading(heading)
    else await s.evaluate("document.querySelector('.settings-content')?.scrollTo(0, 0); document.querySelector('.settings-body')?.scrollTo(0, 0)")
    await pause(400)
    await s.shot(name)
  }
  await top('settings-appearance')
  await top('settings-providers', 'Provider API keys')
  await top('settings-data-sources', 'Data sources')
  // The seeded demo conversations were first indexed before the model existed, which leaves a stale "disabled" note: rebuild once.
  await s.scrollToHeading('Search History Embedding')
  await s.click('Rebuild index')
  await s.waitForText('messages indexed', { timeout: 180000 })
  await pause(500)
  await top('settings-search-history', 'Search History Embedding')
  await top('settings-mcp', 'MCP servers')
  await top('settings-workspace', 'Workspace')
  await s.click('Reload').catch(() => {})
  await top('settings-roles', 'Roles')
  await top('settings-model-behavior', 'Prompt caching')
  await s.quit()
}
