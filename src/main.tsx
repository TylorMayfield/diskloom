import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import '@radix-ui/themes/styles.css'
import './styles.css'

// Preload scripts are not hot-reloaded by Electron. Keep an already-running
// development window functional while the bridge name migrates to Diskloom.
const bridgeWindow = window as Window & { diskloom?: Window['diskloom'] }
if (!bridgeWindow.diskloom && window.diskDaddy) bridgeWindow.diskloom = window.diskDaddy

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
