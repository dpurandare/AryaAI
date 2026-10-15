// Electron entry used by scripts/export-docs.mjs: loads a local HTML file in a hidden window and prints it to PDF.
// Usage (run by the export script): electron scripts/docs-pdf-main.cjs <input.html> <output.pdf> <footer title>
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')

const [input, output, title] = process.argv.slice(2)
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  try {
    await win.loadFile(input)
    // Let images and fonts settle before printing.
    await win.webContents.executeJavaScript(
      'Promise.all([document.fonts.ready, ...[...document.images].map((i) => i.decode().catch(() => {}))]).then(() => true)'
    )
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.8, bottom: 0.8, left: 0.8, right: 0.8 },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="font-size:8px;width:100%;text-align:center;color:#666"><span>${esc(title)}</span> · <span class="pageNumber"></span>/<span class="totalPages"></span></div>`
    })
    writeFileSync(output, pdf)
    app.exit(0)
  } catch (err) {
    console.error(err)
    app.exit(1)
  }
})
