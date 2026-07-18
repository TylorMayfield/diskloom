import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { configureDiskloomApi } from './tauri-api'
import '@radix-ui/themes/styles.css'
import './styles.css'

void configureDiskloomApi().then(() => {
  createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
})
