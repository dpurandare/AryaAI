// Demo conversations for the screenshots: invented, generic content, written straight into the throwaway database.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const esc = (s) => String(s).replaceAll("'", "''")
const HOUR = 3_600_000

/** A weekly-forecast bar chart as a PNG (matplotlib from the system Python); null when it is not available. */
function weatherChart(dir) {
  const file = join(dir, 'pune-weather.png')
  const code = `
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
hi = [31, 32, 30, 29, 31, 33, 32]
lo = [20, 21, 20, 19, 20, 21, 22]
fig, ax = plt.subplots(figsize=(6, 3.2), dpi=110)
ax.plot(days, hi, marker="o", color="#c4542d", label="High")
ax.plot(days, lo, marker="o", color="#2d6fc4", label="Low")
ax.fill_between(days, lo, hi, color="#c4542d", alpha=0.08)
ax.set_title("Pune: weekly temperature (°C)")
ax.grid(alpha=0.3)
ax.legend()
fig.tight_layout()
fig.savefig(${JSON.stringify(file)})
`
  const r = spawnSync('python3', ['-c', code], { encoding: 'utf-8' })
  if (r.status !== 0) return null
  return readFileSync(file).toString('base64')
}

export function demoSql(workDir) {
  const now = Date.now()
  const chart = weatherChart(workDir)
  const rows = []
  const sessions = []
  let n = 0
  const add = (sessionId, role, content, at, model) => {
    n++
    rows.push(
      `INSERT INTO messages (id, session_id, role, content, created_at, model) VALUES ('demo-m${n}', '${sessionId}', '${role}', '${esc(JSON.stringify(content))}', ${at}, ${model ? `'${model}'` : 'NULL'});`
    )
  }
  const session = (id, title, updated) => sessions.push(`INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('${id}', '${esc(title)}', ${updated - 600_000}, ${updated});`)
  const M = 'openai:gpt-4o-mini'

  // 1. Database question -> Word document
  const s1 = 'demo-s1'
  const t1 = now - 2 * HOUR
  session(s1, 'Top 5 customers by sales', t1 + 120_000)
  add(s1, 'user', [{ type: 'text', text: 'Find the top 5 customers by total sales in Northwind and write them into a Word document.' }], t1)
  add(s1, 'assistant', [
    { type: 'text', text: "I'll total the sales per customer in the Northwind database and take the five largest.", agentRole: 'data' },
    { type: 'tool_use', id: 'call_sql', name: 'db_execute_sql', agentRole: 'data', input: { connection: 'northwind', sql: 'SELECT c.CompanyName, ROUND(SUM(od.UnitPrice * od.Quantity * (1 - od.Discount)), 2) AS TotalSales FROM Customers c JOIN Orders o ON o.CustomerID = c.CustomerID JOIN "Order Details" od ON od.OrderID = o.OrderID GROUP BY c.CustomerID ORDER BY TotalSales DESC LIMIT 5' } }
  ], t1 + 20_000, M)
  add(s1, 'user', [{ type: 'tool_result', toolUseId: 'call_sql', content: 'QUICK-Stop | 110277.31\nErnst Handel | 104874.98\nSave-a-lot Markets | 104361.95\nRattlesnake Canyon Grocery | 51097.80\nHungry Owl All-Night Grocers | 49979.91' }], t1 + 25_000)
  add(s1, 'assistant', [
    { type: 'tool_use', id: 'call_doc', name: 'office_create_document', agentRole: 'document-creator', input: { path: 'documents/Top-5-Customers.docx', title: 'Top 5 customers by total sales', sections: [{ heading: 'Result', paragraphs: ['The five customers with the highest total sales in the Northwind database.'] }] } }
  ], t1 + 40_000, M)
  add(s1, 'user', [{ type: 'tool_result', toolUseId: 'call_doc', content: 'Created documents/Top-5-Customers.docx' }], t1 + 45_000)
  add(s1, 'assistant', [{ type: 'text', text: "Done. The five biggest customers by total sales are:\n\n1. **QUICK-Stop** — 110,277.31\n2. **Ernst Handel** — 104,874.98\n3. **Save-a-lot Markets** — 104,361.95\n4. **Rattlesnake Canyon Grocery** — 51,097.80\n5. **Hungry Owl All-Night Grocers** — 49,979.91\n\nI saved them to `documents/Top-5-Customers.docx`." }], t1 + 60_000, M)

  // 2. Web API -> chart
  const s2 = 'demo-s2'
  const t2 = now - 5 * HOUR
  session(s2, 'Weekly weather for Pune', t2 + 90_000)
  add(s2, 'user', [{ type: 'text', text: 'Create a chart with the weekly weather for Pune.' }], t2)
  add(s2, 'assistant', [
    { type: 'text', text: "I'll fetch this week's forecast from the Open-Meteo API and plot it.", agentRole: 'data' },
    { type: 'tool_use', id: 'call_api', name: 'api_call', agentRole: 'data', input: { connection: 'open-meteo', method: 'GET', path: '/v1/forecast', query: { latitude: 18.52, longitude: 73.86, daily: 'temperature_2m_max,temperature_2m_min', timezone: 'Asia/Kolkata' } } }
  ], t2 + 15_000, M)
  add(s2, 'user', [{ type: 'tool_result', toolUseId: 'call_api', content: '{"daily":{"time":["Mon","Tue","Wed","Thu","Fri","Sat","Sun"],"temperature_2m_max":[31,32,30,29,31,33,32],"temperature_2m_min":[20,21,20,19,20,21,22]}}' }], t2 + 20_000)
  add(s2, 'assistant', [
    { type: 'tool_use', id: 'call_py', name: 'python_run', agentRole: 'coding', input: { code: 'import matplotlib.pyplot as plt\n# plot highs and lows for the week\nplt.savefig("resources/pune-weather.png")' } }
  ], t2 + 40_000, M)
  add(s2, 'user', [{ type: 'tool_result', toolUseId: 'call_py', content: 'Saved resources/pune-weather.png' }], t2 + 55_000)
  const show = [{ type: 'tool_use', id: 'call_show', name: 'show_media', agentRole: 'coding', input: { path: 'resources/pune-weather.png' } }]
  add(s2, 'assistant', show, t2 + 60_000, M)
  const shown = [{ type: 'tool_result', toolUseId: 'call_show', content: 'Displayed resources/pune-weather.png' }]
  if (chart) shown.push({ type: 'image', toolUseId: 'call_show', path: 'resources/pune-weather.png', mimeType: 'image/png', dataBase64: chart, agentRole: 'coding' })
  add(s2, 'user', shown, t2 + 62_000)
  add(s2, 'assistant', [{ type: 'text', text: 'Here is the weekly temperature chart for Pune. Highs stay around 29–33 °C and lows around 19–22 °C. The picture is saved as `resources/pune-weather.png`.' }], t2 + 80_000, M)

  // 3-6: other conversations, so the list looks lived in and search-history has something to find
  const small = [
    ['demo-s3', 'Q3 forecast review', 26 * HOUR, 'What did we conclude about the Q3 forecast?', 'We agreed to raise the Q3 revenue forecast by 4% after the two new contracts, and to keep costs flat.'],
    ['demo-s4', 'Draft reply to the supplier', 30 * HOUR, 'Draft a polite reply asking the supplier to confirm the delivery date.', 'Here is a draft: "Dear team, could you please confirm the delivery date for order 4471? Thank you."'],
    ['demo-s5', 'Summarise standup notes', 52 * HOUR, 'Summarise notes/standup.txt in three bullets.', '- Release candidate is ready\n- Two bugs remain in the export\n- Demo planned for Friday'],
    ['demo-s6', 'Compare vendor quotes', 76 * HOUR, 'Compare the two vendor quotes in documents/quotes.xlsx.', 'Vendor B is 6% cheaper overall, but Vendor A includes installation.']
  ]
  for (const [id, title, ago, ask, answer] of small) {
    const t = now - ago
    session(id, title, t + 60_000)
    add(id, 'user', [{ type: 'text', text: ask }], t)
    add(id, 'assistant', [{ type: 'text', text: answer }], t + 30_000, M)
  }
  return ['BEGIN;', ...sessions, ...rows, 'COMMIT;', ''].join('\n')
}
