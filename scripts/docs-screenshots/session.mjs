// One throwaway Sachivji instance at a time: launch, drive over CDP, capture, seed, quit.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PAGE_PORT = 9333
const NODE_PORT = 9334

async function connect(url) {
  const ws = new WebSocket(url)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('websocket error'))
  })
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    const ex = r.result?.exceptionDetails
    if (ex) throw new Error(`evaluate failed: ${ex.exception?.description ?? ex.text}`)
    return r.result?.result?.value
  }
  return { send, evaluate, close: () => ws.close() }
}

export const pause = sleep

export class Session {
  constructor({ exe, work, out, theme, only }) {
    Object.assign(this, { exe, work, out, theme, only })
    // A real, writable folder: the bundled Ollama creates ~/.ollama (its key) and refuses to start without it.
    this.fakeHome = join(work, 'home')
    this.userData = join(work, 'userdata')
    this.workspace = join(work, 'workspace')
    this.child = undefined
    this.page = undefined
    this.node = undefined
    this.taken = []
  }

  /** Real paths that must never appear in a screenshot, mapped to generic ones. */
  get redactions() {
    const base = [
      [this.workspace, '/Users/alex/Documents/Sachivji Workspace'],
      [this.userData, '/Users/alex/Library/Application Support/Sachivji'],
      [this.fakeHome, '/Users/alex'],
      [this.work, '/Users/alex/Documents'],
      [process.env.HOME ?? '/Users/__none__', '/Users/alex'],
      [process.env.USER ?? '__none__', 'alex']
    ].filter(([from]) => from && from.length > 3)
    // macOS reports temp folders as /private/var/...; replace that spelling first.
    return [...base.filter(([f]) => f.startsWith('/var/')).map(([f, t]) => [`/private${f}`, t]), ...base]
  }

  wanted(name) {
    return !this.only || this.only.has(name)
  }

  /** Runs the app (profile folders are kept between launches inside one run). */
  async launch({ mainInspector = false } = {}) {
    mkdirSync(this.userData, { recursive: true })
    mkdirSync(this.workspace, { recursive: true })
    mkdirSync(this.fakeHome, { recursive: true })
    const argv = [`--user-data-dir=${this.userData}`, `--remote-debugging-port=${PAGE_PORT}`]
    if (mainInspector) argv.push(`--inspect=${NODE_PORT}`)
    this.child = spawn(this.exe, argv, {
      env: { ...process.env, HOME: this.fakeHome, SACHIV_WORKSPACE_DIR: this.workspace },
      stdio: 'ignore'
    })
    this.exited = new Promise((res) => this.child.once('exit', res))
    for (let i = 0; i < 80; i++) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${PAGE_PORT}/json`)).json()
        const t = targets.find((x) => x.type === 'page' && x.webSocketDebuggerUrl)
        if (t) {
          this.page = await connect(t.webSocketDebuggerUrl)
          break
        }
      } catch {
        /* not up yet */
      }
      await sleep(500)
    }
    if (!this.page) throw new Error('The app did not open its debug port.')
    if (mainInspector) {
      const list = await (await fetch(`http://127.0.0.1:${NODE_PORT}/json/list`)).json()
      this.node = await connect(list[0].webSocketDebuggerUrl)
    }
    await this.page.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 780, deviceScaleFactor: 2, mobile: false })
    await this.page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: this.theme }] })
    await sleep(1500)
  }

  /** Asks the app to quit and waits for the process; falls back to a signal. */
  async quit() {
    if (!this.child) return
    try {
      if (this.node) await this.node.evaluate("process.mainModule.require('electron').app.quit()")
      else this.child.kill('SIGTERM')
    } catch {
      this.child.kill('SIGTERM')
    }
    await Promise.race([this.exited, sleep(15000)])
    if (this.child.exitCode === null) this.child.kill('SIGKILL')
    this.page?.close()
    this.node?.close()
    this.child = this.page = this.node = undefined
    await sleep(1000)
  }

  async shutdown() {
    await this.quit()
  }

  /** Writes settings/rows into the (closed) app database with the sqlite3 command line tool. */
  sql(statements) {
    const db = join(this.userData, 'sachiv.db')
    if (!existsSync(db)) throw new Error('No database yet; launch the app once first.')
    const r = spawnSync('sqlite3', [db], { input: statements, encoding: 'utf-8' })
    if (r.status !== 0) throw new Error(`sqlite3 failed: ${r.stderr}`)
  }

  setSetting(key, value) {
    const esc = (s) => String(s).replaceAll("'", "''")
    return `INSERT INTO app_settings (key, value) VALUES ('${esc(key)}', '${esc(value)}') ON CONFLICT(key) DO UPDATE SET value = excluded.value;\n`
  }

  evaluate(expression) {
    return this.page.evaluate(expression)
  }

  async text() {
    return this.evaluate('document.body.innerText')
  }

  async waitFor(predicateSource, { timeout = 30000, label = predicateSource } = {}) {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      try {
        if (await this.evaluate(`Boolean(${predicateSource})`)) return
      } catch {
        /* page navigating */
      }
      await sleep(400)
    }
    throw new Error(`Timed out waiting for: ${label}`)
  }

  waitForText(text, opts) {
    return this.waitFor(`document.body.innerText.includes(${JSON.stringify(text)})`, { label: `text "${text}"`, ...opts })
  }

  /** Clicks the first visible button whose text is exactly (or starts with) `label`. */
  async click(label, { within } = {}) {
    const ok = await this.evaluate(`(() => {
      const root = ${within ? `document.querySelector(${JSON.stringify(within)})` : 'document'} ?? document
      const b = [...root.querySelectorAll('button, [role=button], summary, label, a')].find(
        (x) => x.offsetParent !== null && x.innerText.trim().startsWith(${JSON.stringify(label)}) && !x.disabled
      )
      if (!b) return false
      b.click()
      return true
    })()`)
    if (!ok) throw new Error(`No enabled button "${label}" found.`)
    await sleep(400)
  }

  /** Clicks until the page text contains `wanted` (for buttons that cycle through states), at most `max` times. */
  async clickUntil(label, wanted, max = 5) {
    for (let i = 0; i < max; i++) {
      if ((await this.text()).includes(wanted)) return
      await this.click(label)
    }
    if (!(await this.text()).includes(wanted)) throw new Error(`"${label}" never reached "${wanted}".`)
  }

  freshProfile() {
    rmSync(this.userData, { recursive: true, force: true })
    rmSync(this.workspace, { recursive: true, force: true })
  }

  /** Scrolls the element matching the selector (or text of a heading) into view at the top of its scroll area. */
  async scrollToHeading(text) {
    const ok = await this.evaluate(`(() => {
      const h = [...document.querySelectorAll('h1, h2, h3')].find((x) => x.innerText.trim().startsWith(${JSON.stringify(text)}))
      if (!h) return false
      h.scrollIntoView({ block: 'start' })
      return true
    })()`)
    if (!ok) throw new Error(`No heading "${text}".`)
    await sleep(500)
  }

  /** Types text into whatever has focus (the composer) and presses a key. */
  async type(text) {
    await this.page.send('Input.insertText', { text })
    await sleep(200)
  }

  async press(key, code = key, vk = 13) {
    for (const type of ['keyDown', 'keyUp']) {
      await this.page.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, text: type === 'keyDown' && key === 'Enter' ? '\r' : undefined })
    }
    await sleep(300)
  }

  /**
   * Replaces the app's chat:send handler (main process, via the inspector) so a "turn" starts without any model: the next message
   * the page sends opens a stream we then drive with emit(). Throwaway profile only.
   */
  async installDemoStream() {
    const r = await this.node.evaluate(`(() => {
      const req = process.mainModule?.require ?? module?.require
      const { ipcMain } = req('electron')
      // The page refuses to send without a stored key; report one as present (throwaway profile, nothing is stored).
      ipcMain.removeHandler('providers:has-api-key')
      ipcMain.handle('providers:has-api-key', () => true)
      ipcMain.removeHandler('chat:send')
      ipcMain.handle('chat:send', (event, sessionId) => {
        globalThis.__demo = { sessionId, sender: event.sender }
        return { streamId: 'demo-1' }
      })
      globalThis.__emit = (channel, payload) => globalThis.__demo.sender.send(channel, payload)
      return 'ok'
    })()`)
    if (r !== 'ok') throw new Error('Could not install the demo stream.')
  }

  /** Sends a stream event to the page as if the orchestrator had produced it. */
  emitStream(event) {
    return this.node.evaluate(`globalThis.__emit('chat:stream-event', { streamId: 'demo-1', sessionId: globalThis.__demo.sessionId, event: ${JSON.stringify(event)} })`)
  }

  emitChannel(channel, payload) {
    return this.node.evaluate(`globalThis.__emit(${JSON.stringify(channel)}, Object.assign(${JSON.stringify(payload)}, { sessionId: globalThis.__demo.sessionId }))`)
  }

  async redact() {
    const pairs = JSON.stringify(this.redactions)
    await this.evaluate(`(() => {
      const pairs = ${pairs}
      const fix = (s) => pairs.reduce((acc, [from, to]) => acc.split(from).join(to), s)
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const v = fix(n.nodeValue)
        if (v !== n.nodeValue) n.nodeValue = v
      }
      for (const el of document.querySelectorAll('input, textarea')) {
        const v = fix(el.value ?? '')
        if (v !== el.value) el.value = v
        const p = fix(el.placeholder ?? '')
        if (p !== el.placeholder) el.placeholder = p
      }
      for (const el of document.querySelectorAll('[title]')) el.title = fix(el.title)
      for (const el of document.querySelectorAll('.avatar')) el.textContent = 'A'
    })()`)
  }

  /** Captures the window (or a clip of it) to <out>/<name>.png. `clip` = {x, y, width, height} in CSS pixels. */
  async shot(name, { clip } = {}) {
    if (!this.wanted(name)) return
    await this.redact()
    await sleep(300)
    const r = await this.page.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) })
    if (!r.result?.data) throw new Error(`Capture failed for ${name}: ${JSON.stringify(r.error)}`)
    writeFileSync(join(this.out, `${name}.png`), Buffer.from(r.result.data, 'base64'))
    this.taken.push(name)
    console.log(`  captured ${name}.png`)
  }
}
