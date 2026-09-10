import { mount } from 'svelte'
import 'katex/dist/katex.min.css'
import './theme.css'
import PrintView from './lib/components/PrintView.svelte'

// The PDF export always renders in light mode regardless of the app's own
// theme setting — a near-black background wastes ink/toner and isn't what
// a "printed" document is expected to look like.
document.documentElement.setAttribute('data-theme', 'light')

mount(PrintView, { target: document.getElementById('app')! })
