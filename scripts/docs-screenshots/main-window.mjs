// The chat window and its dialogs. Conversations are seeded into the database; the dialogs are produced by
// driving the app's own events (no model is called, nothing is sent anywhere).
import { demoSql } from './demo-data.mjs'
import { pause } from './session.mjs'

const NAMES = ['main-window', 'tool-output-shown', 'agent-picker', 'account-menu', 'confirm-dialog', 'confirm-comment', 'steering-note', 'limit-reached', 'outside-workspace']


/** A throwaway profile that has finished onboarding and holds the demo conversations (done once per run). */
export async function prepareDemoProfile(s) {
  if (s.demoReady) return
  s.freshProfile()
  await s.launch()
  await s.waitForText('Welcome to Sachivji')
  await s.quit()
  s.sql(
    [
      s.setSetting('onboardingSecretsChosen', 'true'),
      s.setSetting('onboardingCompleted', 'true'),
      s.setSetting('activeProviderId', 'openai'),
      s.setSetting('model:openai', 'gpt-4o-mini'),
      s.setSetting('toolDisplayMode', 'partial'),
      s.setSetting('planningEnabled', 'true')
    ].join('') + demoSql(s.work)
  )
  s.demoReady = true
}

export async function run(s) {
  if (!NAMES.some((n) => s.wanted(n))) return
  console.log('Chat window screens')

  await prepareDemoProfile(s)

  await s.launch({ mainInspector: true })
  await s.waitForText('Top 5 customers by sales', { timeout: 60000 })
  await s.waitFor("!document.body.innerText.includes('Starting')", { label: 'the splash screen to fade' })
  await s.click('Top 5 customers by sales')
  await s.waitForText('Find the top 5 customers')
  await pause(800)
  await s.shot('main-window')

  await s.clickUntil('Tool output:', 'Tool output: shown')
  await pause(500)
  await s.shot('tool-output-shown')
  await s.clickUntil('Tool output:', 'Tool output: partial')

  await s.click('Agent:')
  await pause(300)
  await s.shot('agent-picker')
  await s.clickUntil('Agent:', 'Agent: Auto', 14)

  await s.evaluate("document.querySelector('.user-row').click()")
  await pause(400)
  await s.shot('account-menu')
  await s.evaluate("document.querySelector('.user-row').click()")

  // A live turn, driven by hand.
  await s.installDemoStream()
  await s.evaluate('location.reload()')
  await s.waitForText('Top 5 customers by sales', { timeout: 60000 })
  await s.waitFor("!document.body.innerText.includes('Starting')", { label: 'the splash screen to fade' })
  await s.click('Top 5 customers by sales')
  await s.waitForText('Find the top 5 customers')
  await s.evaluate("document.querySelector('textarea').focus()")
  await s.type('Find the top 5 customers by total sales and write them into a Word document, then email it to finance.')
  await s.press('Enter')
  await pause(800)
  const steps = [
    { role: 'data', description: 'Find the five customers with the highest total sales' },
    { role: 'document-creator', description: 'Write the list into a Word document' },
    { role: 'email', description: 'Email the document to finance' }
  ]
  await s.emitStream({ type: 'plan', steps })
  await s.emitStream({ type: 'plan_step_start', index: 0 })
  await s.emitStream({ type: 'text_delta', agentRole: 'data', text: 'Querying the Northwind database for total sales per customer…' })
  await s.emitStream({ type: 'plan_step_done', index: 0, isError: false })
  await s.emitStream({ type: 'plan_step_start', index: 1 })
  const input = { path: 'documents/Top-5-Customers.docx', title: 'Top 5 customers by total sales' }
  await s.emitStream({ type: 'tool_use_start', id: 'call_demo_doc', name: 'office_create_document', agentRole: 'document-creator' })
  await s.emitStream({ type: 'tool_use_delta', id: 'call_demo_doc', partialInput: JSON.stringify(input) })
  await s.emitChannel('tools:confirm-request', {
    streamId: 'demo-1',
    toolUseId: 'call_demo_doc',
    name: 'office_create_document',
    input,
    description: 'Create the Word document documents/Top-5-Customers.docx'
  })
  await s.waitForText('Run office_create_document?')
  await pause(600)
  await s.shot('confirm-dialog')

  await s.click('Talk about it')
  await pause(300)
  await s.evaluate("document.querySelector('.talk-about-it-input').focus()")
  await s.type('Also add a column with each customer’s country.')
  await s.shot('confirm-comment')
  await s.click('Cancel')

  await s.click('Approve')
  await s.emitStream({ type: 'tool_result', toolUseId: 'call_demo_doc', content: 'Created documents/Top-5-Customers.docx' })
  await s.emitStream({ type: 'plan_step_done', index: 1, isError: false })
  await s.emitStream({ type: 'plan_step_start', index: 2 })
  await s.waitFor("document.querySelector('textarea')?.placeholder.startsWith('Add a note')", { label: 'the note box' })
  await s.evaluate("document.querySelector('textarea').focus()")
  await s.type('Send it to finance@example.com and copy the sales team.')
  await pause(300)
  await s.shot('steering-note')

  await s.emitChannel('limit:reached-request', { streamId: 'demo-1', requestId: 'demo-limit', reason: 'rounds', roundsUsed: 12, maxRounds: 12, agentRole: 'email' })
  await s.waitForText('Allow more steps')
  await pause(400)
  await s.shot('limit-reached')
  await s.click('Stop here')

  await s.emitChannel('tools:confirm-request', {
    streamId: 'demo-1',
    toolUseId: 'call_demo_ext',
    name: 'external_folder_access',
    input: { access: 'read', path: '/Users/alex/Downloads/vendor-quotes' },
    description: 'Sachivji wants to read files in /Users/alex/Downloads/vendor-quotes, which is outside your workspace.'
  })
  await s.waitForText('Allow access outside the workspace?')
  await pause(400)
  await s.shot('outside-workspace')
  await s.click('Deny')
  await s.emitStream({ type: 'message_stop', stopReason: 'end_turn' })
  await s.quit()
}
