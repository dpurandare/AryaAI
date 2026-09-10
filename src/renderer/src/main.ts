import { mount } from 'svelte'
import 'katex/dist/katex.min.css'
import './theme.css'
import App from './App.svelte'
import { initTheme } from './lib/theme'

// Resolved before mount so the correct theme is already on <html> for the
// very first paint, instead of a flash of the wrong one.
await initTheme()

const app = mount(App, { target: document.getElementById('app')! })

export default app
